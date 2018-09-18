import { ExecutionResult } from 'graphql';

import { CacheControlExtensionOptions } from 'apollo-cache-control';

import { Request } from 'apollo-server-env';
import {
  default as GraphQLOptions,
  resolveGraphqlOptions,
} from './graphqlOptions';
import {
  formatApolloErrors,
  PersistedQueryNotSupportedError,
  PersistedQueryNotFoundError,
} from 'apollo-server-errors';
import { calculateCacheControlHeaders } from './caching';
import {
  GraphQLRequestProcessor,
  InvalidGraphQLRequestError,
} from './requestProcessing';

export interface HttpQueryRequest {
  method: string;
  // query is either the POST body or the GET query string map.  In the GET
  // case, all values are strings and need to be parsed as JSON; in the POST
  // case they should already be parsed. query has keys like 'query' (whose
  // value should always be a string), 'variables', 'operationName',
  // 'extensions', etc.
  query: Record<string, any> | Array<Record<string, any>>;
  options:
    | GraphQLOptions
    | ((...args: Array<any>) => Promise<GraphQLOptions> | GraphQLOptions);
  request: Pick<Request, 'url' | 'method' | 'headers'>;
}

// The result of a curl does not appear well in the terminal, so we add an extra new line
function prettyJSONStringify(value: any) {
  return JSON.stringify(value) + '\n';
}

export interface ApolloServerHttpResponse {
  headers?: Record<string, string>;
  // ResponseInit contains the follow, which we do not use
  // status?: number;
  // statusText?: string;
}

export interface HttpQueryResponse {
  graphqlResponse: string;
  responseInit: ApolloServerHttpResponse;
}

export class HttpQueryError extends Error {
  public statusCode: number;
  public isGraphQLError: boolean;
  public headers?: { [key: string]: string };

  constructor(
    statusCode: number,
    message: string,
    isGraphQLError: boolean = false,
    headers?: { [key: string]: string },
  ) {
    super(message);
    this.name = 'HttpQueryError';
    this.statusCode = statusCode;
    this.isGraphQLError = isGraphQLError;
    this.headers = headers;
  }
}

/**
 * If optionsObject is specified, then the errors array will be formatted
 */
function throwHttpGraphQLError<E extends Error>(
  statusCode: number,
  errors: Array<E>,
  optionsObject?: Partial<GraphQLOptions>,
): never {
  throw new HttpQueryError(
    statusCode,
    prettyJSONStringify({
      errors: optionsObject
        ? formatApolloErrors(errors, {
            debug: optionsObject.debug,
            formatter: optionsObject.formatError,
          })
        : errors,
    }),
    true,
    {
      'Content-Type': 'application/json',
    },
  );
}

export async function runHttpQuery(
  handlerArguments: Array<any>,
  request: HttpQueryRequest,
): Promise<HttpQueryResponse> {
  let isGetRequest: boolean = false;
  let optionsObject: GraphQLOptions;
  const debugDefault =
    process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';
  let cacheControl:
    | CacheControlExtensionOptions & {
        calculateHttpHeaders: boolean;
        stripFormattedExtensions: boolean;
      }
    | undefined;

  try {
    optionsObject = await resolveGraphqlOptions(
      request.options,
      ...handlerArguments,
    );
  } catch (e) {
    // The options can be generated asynchronously, so we don't have access to
    // the normal options provided by the user, such as: formatError,
    // debug. Therefore, we need to do some unnatural things, such
    // as use NODE_ENV to determine the debug settings
    e.message = `Invalid options provided to ApolloServer: ${e.message}`;
    if (!debugDefault) {
      e.warning = `To remove the stacktrace, set the NODE_ENV environment variable to production if the options creation can fail`;
    }
    return throwHttpGraphQLError(500, [e], { debug: debugDefault });
  }
  if (optionsObject.debug === undefined) {
    optionsObject.debug = debugDefault;
  }
  let requestPayload;

  switch (request.method) {
    case 'POST':
      if (!request.query || Object.keys(request.query).length === 0) {
        throw new HttpQueryError(
          500,
          'POST body missing. Did you forget use body-parser middleware?',
        );
      }

      requestPayload = request.query;
      break;
    case 'GET':
      if (!request.query || Object.keys(request.query).length === 0) {
        throw new HttpQueryError(400, 'GET query missing.');
      }

      isGetRequest = true;
      requestPayload = request.query;
      break;

    default:
      throw new HttpQueryError(
        405,
        'Apollo Server supports only GET/POST requests.',
        false,
        {
          Allow: 'GET, POST',
        },
      );
  }

  let isBatch = true;
  // TODO: do something different here if the body is an array.
  // Throw an error if body isn't either array or object.
  if (!Array.isArray(requestPayload)) {
    isBatch = false;
    requestPayload = [requestPayload];
  }

  const requests = requestPayload.map(async requestParams => {
    try {
      let queryString: string | undefined = requestParams.query;
      let extensions = requestParams.extensions;

      if (isGetRequest && extensions) {
        // For GET requests, we have to JSON-parse extensions. (For POST
        // requests they get parsed as part of parsing the larger body they're
        // inside.)
        try {
          extensions = JSON.parse(extensions);
        } catch (error) {
          throw new HttpQueryError(400, 'Extensions are invalid JSON.');
        }
      }

      if (queryString && typeof queryString !== 'string') {
        // Check for a common error first.
        if ((queryString as any).kind === 'Document') {
          throw new HttpQueryError(
            400,
            "GraphQL queries must be strings. It looks like you're sending the " +
              'internal graphql-js representation of a parsed query in your ' +
              'request instead of a request in the GraphQL query language. You ' +
              'can convert an AST to a string using the `print` function from ' +
              '`graphql`, or use a client like `apollo-client` which converts ' +
              'the internal representation to a string for you.',
          );
        } else {
          throw new HttpQueryError(400, 'GraphQL queries must be strings.');
        }
      }

      const operationName = requestParams.operationName;

      let variables = requestParams.variables;
      if (typeof variables === 'string') {
        try {
          // XXX Really we should only do this for GET requests, but for
          // compatibility reasons we'll keep doing this at least for now for
          // broken clients that ship variables in a string for no good reason.
          variables = JSON.parse(variables);
        } catch (error) {
          throw new HttpQueryError(400, 'Variables are invalid JSON.');
        }
      }

      let context = optionsObject.context;
      if (!context) {
        context = {} as Record<string, any>;
      } else if (typeof context === 'function') {
        try {
          context = await context();
        } catch (e) {
          e.message = `Context creation failed: ${e.message}`;
          // For errors that are not internal, such as authentication, we
          // should provide a 400 response
          if (
            e.extensions &&
            e.extensions.code &&
            e.extensions.code !== 'INTERNAL_SERVER_ERROR'
          ) {
            return throwHttpGraphQLError(400, [e], optionsObject);
          } else {
            return throwHttpGraphQLError(500, [e], optionsObject);
          }
        }
      } else {
        // Always clone the context if it's not a function, because that preserves
        // having a fresh context per request.
        context = Object.assign(
          Object.create(Object.getPrototypeOf(context)),
          context,
        ) as Record<string, any>;
      }

      if (optionsObject.dataSources) {
        const dataSources = optionsObject.dataSources() || {};

        for (const dataSource of Object.values(dataSources)) {
          if (dataSource.initialize) {
            dataSource.initialize({ context, cache: optionsObject.cache! });
          }
        }

        if ('dataSources' in context) {
          throw new Error(
            'Please use the dataSources config option instead of putting dataSources on the context yourself.',
          );
        }

        (context as any).dataSources = dataSources;
      }

      if (optionsObject.cacheControl !== false) {
        if (
          typeof optionsObject.cacheControl === 'boolean' &&
          optionsObject.cacheControl === true
        ) {
          // cacheControl: true means that the user needs the cache-control
          // extensions. This means we are running the proxy, so we should not
          // strip out the cache control extension and not add cache-control headers
          cacheControl = {
            stripFormattedExtensions: false,
            calculateHttpHeaders: false,
            defaultMaxAge: 0,
          };
        } else {
          // Default behavior is to run default header calculation and return
          // no cacheControl extensions
          cacheControl = {
            stripFormattedExtensions: true,
            calculateHttpHeaders: true,
            defaultMaxAge: 0,
            ...optionsObject.cacheControl,
          };
        }
      }

      const requestProcessor = new GraphQLRequestProcessor({
        schema: optionsObject.schema,
        rootValue: optionsObject.rootValue,
        context,
        validationRules: optionsObject.validationRules,
        fieldResolver: optionsObject.fieldResolver,

        extensions: optionsObject.extensions,
        persistedQueries: optionsObject.persistedQueries,
        tracing: optionsObject.tracing,
        cacheControl: cacheControl,

        formatResponse: optionsObject.formatResponse,

        debug: optionsObject.debug,

        queryExtensions: extensions,
      });

      // GET operations should only be queries (not mutations). We want to throw
      // a particular HTTP error in that case.
      if (isGetRequest) {
        requestProcessor.willExecuteOperation = operation => {
          if (operation.operation !== 'query') {
            throw new HttpQueryError(
              405,
              `GET supports only query operation`,
              false,
              {
                Allow: 'POST',
              },
            );
          }
        };
      }

      return await requestProcessor.processRequest({
        query: queryString,
        operationName,
        variables,
        extensions,
        httpRequest: request.request,
      });
    } catch (error) {
      console.log(
        `debug: ${optionsObject.debug}, formatError: ${
          optionsObject.formatError
        }`,
      );
      // A batch can contain another query that returns data,
      // so we don't error out the entire request with an HttpError
      if (isBatch) {
        return {
          errors: formatApolloErrors([error], optionsObject),
        };
      }

      if (error instanceof InvalidGraphQLRequestError) {
        throw new HttpQueryError(400, error.message);
      } else if (
        error instanceof PersistedQueryNotSupportedError ||
        error instanceof PersistedQueryNotFoundError
      ) {
        return throwHttpGraphQLError(200, [error], optionsObject);
      } else {
        throw error;
      }
    }
  }) as Array<Promise<ExecutionResult & { extensions?: Record<string, any> }>>;

  let responses;
  try {
    responses = await Promise.all(requests);
  } catch (error) {
    if (error instanceof HttpQueryError) {
      throw error;
    }
    return throwHttpGraphQLError(500, [error], optionsObject);
  }

  const responseInit: ApolloServerHttpResponse = {
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (cacheControl) {
    if (cacheControl.calculateHttpHeaders) {
      const calculatedHeaders = calculateCacheControlHeaders(responses);

      responseInit.headers = {
        ...responseInit.headers,
        ...calculatedHeaders,
      };
    }

    if (cacheControl.stripFormattedExtensions) {
      responses.forEach(response => {
        if (response.extensions) {
          delete response.extensions.cacheControl;
          if (Object.keys(response.extensions).length === 0) {
            delete response.extensions;
          }
        }
      });
    }
  }

  if (!isBatch) {
    const graphqlResponse = responses[0];
    // This code is run on parse/validation errors and any other error that
    // doesn't reach GraphQL execution
    if (graphqlResponse.errors && typeof graphqlResponse.data === 'undefined') {
      // don't include optionsObject, since the errors have already been formatted
      return throwHttpGraphQLError(400, graphqlResponse.errors as any);
    }
    const stringified = prettyJSONStringify(graphqlResponse);

    responseInit.headers!['Content-Length'] = Buffer.byteLength(
      stringified,
      'utf8',
    ).toString();

    return {
      graphqlResponse: stringified,
      responseInit,
    };
  }

  const stringified = prettyJSONStringify(responses);

  responseInit.headers!['Content-Length'] = Buffer.byteLength(
    stringified,
    'utf8',
  ).toString();

  return {
    graphqlResponse: stringified,
    responseInit,
  };
}
