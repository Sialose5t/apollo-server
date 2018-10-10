import {
  GraphQLSchema,
  GraphQLFieldResolver,
  specifiedRules,
  DocumentNode,
  getOperationAST,
  ExecutionArgs,
  ExecutionResult,
  GraphQLError,
} from 'graphql';
import * as graphql from 'graphql';
import {
  GraphQLExtension,
  GraphQLExtensionStack,
  enableGraphQLExtensions,
} from 'graphql-extensions';
import { DataSource } from 'apollo-datasource';
import { PersistedQueryOptions } from '.';
import {
  CacheControlExtension,
  CacheControlExtensionOptions,
} from 'apollo-cache-control';
import { TracingExtension } from 'apollo-tracing';
import {
  fromGraphQLError,
  SyntaxError,
  ValidationError,
  PersistedQueryNotSupportedError,
  PersistedQueryNotFoundError,
} from 'apollo-server-errors';
import { createHash } from 'crypto';
import {
  GraphQLRequest,
  GraphQLResponse,
  GraphQLRequestContext,
  InvalidGraphQLRequestError,
  ValidationRule,
} from './requestPipelineAPI';
import {
  ApolloServerPlugin,
  GraphQLRequestListener,
  WithRequired,
} from 'apollo-server-plugin-base';

import { Dispatcher } from './utils/dispatcher';

export {
  GraphQLRequest,
  GraphQLResponse,
  GraphQLRequestContext,
  InvalidGraphQLRequestError,
};

function computeQueryHash(query: string) {
  return createHash('sha256')
    .update(query)
    .digest('hex');
}

export interface GraphQLRequestPipelineConfig<TContext> {
  schema: GraphQLSchema;

  rootValue?: ((document: DocumentNode) => any) | any;
  validationRules?: ValidationRule[];
  fieldResolver?: GraphQLFieldResolver<any, TContext>;

  dataSources?: () => DataSources<TContext>;

  extensions?: Array<() => GraphQLExtension>;
  tracing?: boolean;
  persistedQueries?: PersistedQueryOptions;
  cacheControl?: CacheControlExtensionOptions;

  formatError?: Function;
  formatResponse?: Function;

  plugins?: ApolloServerPlugin[];
}

export type DataSources<TContext> = {
  [name: string]: DataSource<TContext>;
};

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

export class GraphQLRequestPipeline<TContext> {
  plugins: ApolloServerPlugin[];

  constructor(private config: GraphQLRequestPipelineConfig<TContext>) {
    enableGraphQLExtensions(config.schema);
    this.plugins = config.plugins || [];
  }

  async processRequest(
    requestContext: Mutable<GraphQLRequestContext<TContext>>,
  ): Promise<GraphQLResponse> {
    const config = this.config;

    const requestListeners: GraphQLRequestListener<TContext>[] = [];
    for (const plugin of this.plugins) {
      if (!plugin.requestDidStart) continue;
      const listener = plugin.requestDidStart(requestContext);
      if (listener) {
        requestListeners.push(listener);
      }
    }

    const dispatcher = new Dispatcher(requestListeners);

    const extensionStack = this.initializeExtensionStack();
    (requestContext.context as any)._extensionStack = extensionStack;

    this.initializeDataSources(requestContext);

    const request = requestContext.request;

    let { query, extensions } = request;

    let queryHash: string;

    let persistedQueryHit = false;
    let persistedQueryRegister = false;

    if (extensions && extensions.persistedQuery) {
      // It looks like we've received a persisted query. Check if we
      // support them.
      if (
        !this.config.persistedQueries ||
        !this.config.persistedQueries.cache
      ) {
        throw new PersistedQueryNotSupportedError();
      } else if (extensions.persistedQuery.version !== 1) {
        throw new InvalidGraphQLRequestError(
          'Unsupported persisted query version',
        );
      }

      queryHash = extensions.persistedQuery.sha256Hash;

      if (query === undefined) {
        query = await this.config.persistedQueries.cache.get(
          `apq:${queryHash}`,
        );
        if (query) {
          persistedQueryHit = true;
        } else {
          throw new PersistedQueryNotFoundError();
        }
      } else {
        const computedQueryHash = computeQueryHash(query);

        if (queryHash !== computedQueryHash) {
          throw new InvalidGraphQLRequestError(
            'provided sha does not match query',
          );
        }
        persistedQueryRegister = true;

        // Store the query asynchronously so we don't block.
        (async () => {
          return (
            this.config.persistedQueries &&
            this.config.persistedQueries.cache.set(`apq:${queryHash}`, query)
          );
        })().catch(error => {
          console.warn(error);
        });
      }
    } else if (query) {
      // FIXME: We'll compute the APQ query hash to use as our cache key for
      // now, but this should be replaced with the new operation ID algorithm.
      queryHash = computeQueryHash(query);
    } else {
      throw new InvalidGraphQLRequestError('Must provide query string.');
    }

    const requestDidEnd = extensionStack.requestDidStart({
      request: request.http!,
      queryString: request.query,
      operationName: request.operationName,
      variables: request.variables,
      extensions: request.extensions,
      persistedQueryHit,
      persistedQueryRegister,
    });

    const parsingDidEnd = await dispatcher.invokeDidStart(
      'parsingDidStart',
      requestContext,
    );

    try {
      let document: DocumentNode;
      try {
        document = parse(query);
        parsingDidEnd();
      } catch (syntaxError) {
        parsingDidEnd(syntaxError);
        return sendResponse({
          errors: [
            fromGraphQLError(syntaxError, {
              errorClass: SyntaxError,
            }),
          ],
        });
      }

      requestContext.document = document;

      const validationDidEnd = await dispatcher.invokeDidStart(
        'validationDidStart',
        requestContext as WithRequired<typeof requestContext, 'document'>,
      );

      const validationErrors = validate(document);

      if (validationErrors.length > 0) {
        validationDidEnd(validationErrors);
        return sendResponse({
          errors: validationErrors.map(validationError =>
            fromGraphQLError(validationError, {
              errorClass: ValidationError,
            }),
          ),
        });
      }

      validationDidEnd();

      // FIXME: If we want to guarantee an operation has been set when invoking
      // `willExecuteOperation` and executionDidStart`, we need to throw an
      // error here and not leave this to `buildExecutionContext` in
      // `graphql-js`.
      const operation = getOperationAST(document, request.operationName);

      requestContext.operation = operation || undefined;
      // We'll set `operationName` to `null` for anonymous operations.
      requestContext.operationName =
        (operation && operation.name && operation.name.value) || null;

      await dispatcher.invokeAsync(
        'didResolveOperation',
        requestContext as WithRequired<
          typeof requestContext,
          'document' | 'operation' | 'operationName'
        >,
      );

      const executionDidEnd = await dispatcher.invokeDidStart(
        'executionDidStart',
        requestContext as WithRequired<
          typeof requestContext,
          'document' | 'operation' | 'operationName'
        >,
      );

      let response: GraphQLResponse;

      try {
        response = (await execute(
          document,
          request.operationName,
          request.variables,
        )) as GraphQLResponse;
        executionDidEnd();
      } catch (executionError) {
        executionDidEnd(executionError);
        return sendResponse({
          errors: [fromGraphQLError(executionError)],
        });
      }

      const formattedExtensions = extensionStack.format();
      if (Object.keys(formattedExtensions).length > 0) {
        response.extensions = formattedExtensions;
      }

      if (this.config.formatResponse) {
        response = this.config.formatResponse(response, {
          context: requestContext.context,
        });
      }

      return sendResponse(response);
    } finally {
      requestDidEnd();
    }

    function parse(query: string): DocumentNode {
      const parsingDidEnd = extensionStack.parsingDidStart({
        queryString: query,
      });

      try {
        return graphql.parse(query);
      } finally {
        parsingDidEnd();
      }
    }

    function validate(document: DocumentNode): ReadonlyArray<GraphQLError> {
      let rules = specifiedRules;
      if (config.validationRules) {
        rules = rules.concat(config.validationRules);
      }

      const validationDidEnd = extensionStack.validationDidStart();

      try {
        return graphql.validate(config.schema, document, rules);
      } finally {
        validationDidEnd();
      }
    }

    async function execute(
      document: DocumentNode,
      operationName: GraphQLRequest['operationName'],
      variables: GraphQLRequest['variables'],
    ): Promise<ExecutionResult> {
      const executionArgs: ExecutionArgs = {
        schema: config.schema,
        document,
        rootValue:
          typeof config.rootValue === 'function'
            ? config.rootValue(document)
            : config.rootValue,
        contextValue: requestContext.context,
        variableValues: variables,
        operationName,
        fieldResolver: config.fieldResolver,
      };

      const executionDidEnd = extensionStack.executionDidStart({
        executionArgs,
      });

      try {
        return graphql.execute(executionArgs);
      } finally {
        executionDidEnd();
      }
    }

    async function sendResponse(
      response: GraphQLResponse,
    ): Promise<GraphQLResponse> {
      // We override errors, data, and extensions with the passed in response,
      // but keep other properties (like http)
      requestContext.response = extensionStack.willSendResponse({
        graphqlResponse: {
          ...requestContext.response,
          errors: response.errors,
          data: response.data,
          extensions: response.extensions,
        },
      }).graphqlResponse;
      await dispatcher.invokeAsync(
        'willSendResponse',
        requestContext as WithRequired<typeof requestContext, 'response'>,
      );
      return requestContext.response!;
    }
  }

  private initializeExtensionStack(): GraphQLExtensionStack<TContext> {
    // If custom extension factories were provided, create per-request extension
    // objects.
    const extensions = this.config.extensions
      ? this.config.extensions.map(f => f())
      : [];

    if (this.config.tracing) {
      extensions.push(new TracingExtension());
    }

    let cacheControlExtension;
    if (this.config.cacheControl) {
      cacheControlExtension = new CacheControlExtension(
        this.config.cacheControl,
      );
      extensions.push(cacheControlExtension);
    }

    return new GraphQLExtensionStack(extensions);
  }

  private initializeDataSources(
    requestContext: GraphQLRequestContext<TContext>,
  ) {
    if (this.config.dataSources) {
      const context = requestContext.context;

      const dataSources = this.config.dataSources();

      for (const dataSource of Object.values(dataSources)) {
        if (dataSource.initialize) {
          dataSource.initialize({
            context,
            cache: requestContext.cache,
          });
        }
      }

      if ('dataSources' in context) {
        throw new Error(
          'Please use the dataSources config option instead of putting dataSources on the context yourself.',
        );
      }

      (context as any).dataSources = dataSources;
    }
  }
}
