import * as express from 'express';
import * as graphql from 'graphql';
import { runQuery } from '../core/runQuery';

import * as GraphiQL from '../modules/renderGraphiQL';

import * as httpError from 'http-errors';

// TODO: will these be the same or different for other integrations?
export interface ExpressApolloOptions {
  schema: graphql.GraphQLSchema;
  formatError?: Function;
  rootValue?: any;
  context?: any;
  logFunction?: Function;
  formatResponse?: Function;
}

export interface ExpressApolloOptionsFunction {
  (req?: express.Request): ExpressApolloOptions;
}

// Design principles:
// - there is just one way allowed: POST request with JSON body. Nothing else.
// - simple, fast and secure
//

export interface ExpressHandler {
  (req: express.Request, res: express.Response, next): void;
}

export function graphqlHTTP(options: ExpressApolloOptions | ExpressApolloOptionsFunction): ExpressHandler {
  if (!options) {
    throw new Error('Apollo Server requires options.');
  }

  if (arguments.length > 1) {
    // TODO: test this
    throw new Error(`Apollo Server expects exactly one argument, got ${arguments.length + 1}`);
  }

  return (req: express.Request, res: express.Response, next) => {
    let optionsObject: ExpressApolloOptions;
    if (isOptionsFunction(options)) {
      optionsObject = options(req);
    } else {
      optionsObject = options;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      throw httpError(405, 'Apollo Server supports only POST requests.');
    }

    if (!req.body) {
      throw httpError(500, 'POST body missing. Did you forget "app.use(bodyParser.json())"?');
    }

    const b = req.body;
    const query = b.query;
    const operationName = b.operationName;
    let variables = b.variables;

    if (typeof variables === 'string') {
      // TODO: catch errors
      variables = JSON.parse(variables);
    }

    // either query or operationName must be present. Return 400 otherwise
    // if only operationName is present, check if it's in store. Return 400 otherwise

    // TODO: in store, fragments should only have to be written once, then used across queries.

    if (!query) {
      throw httpError(400, 'Must provide query string.');
    }

    return runQuery({
      schema: optionsObject.schema,
      query: query,
      variables: variables,
      rootValue: optionsObject.rootValue,
      operationName: operationName,
      logFunction: optionsObject.logFunction,
    }).then(gqlResponse => {
      res.set('Content-Type', 'application/json');
      if (gqlResponse.errors && typeof gqlResponse.data === 'undefined') {
        res.status(400);
      }
      let response = {
        data: gqlResponse.data,
      };
      if (gqlResponse.errors) {
        response['errors'] = gqlResponse.errors.map(optionsObject.formatError || graphql.formatError as any);
        // TODO: stop any creep. Fix the issue here.
      }
      if (optionsObject.formatResponse) {
        response = optionsObject.formatResponse(response);
      }
      res.send(JSON.stringify(response));
    });
  };
}

function isOptionsFunction(arg: ExpressApolloOptions | ExpressApolloOptionsFunction): arg is ExpressApolloOptionsFunction {
  return typeof arg === 'function';
}

// this returns the html for the GraphiQL interactive query UI
export function renderGraphiQL(options: GraphiQL.GraphiQLData) {
  return (req: express.Request, res: express.Response, next) => {

    const q = req.query || {};
    const query = q.query || '';
    const variables = q.variables || '{}';
    const operationName = q.operationName || '';


    const graphiQLString = GraphiQL.renderGraphiQL({
      location: options.location,
      query: query || options.query,
      variables: JSON.parse(variables) || options.variables,
      operationName: operationName || options.operationName,
    });
    res.set('Content-Type', 'text/html');
    res.send(graphiQLString);
  };
}
