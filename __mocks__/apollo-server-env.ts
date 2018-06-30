/// <reference types="jest" />

import {
  fetch,
  Request,
  Response,
  BodyInit,
  Headers,
  HeadersInit,
  URL,
  URLSearchParams,
} from '../packages/apollo-server-env';

interface FetchMock extends jest.Mock<typeof fetch> {
  mockResponseOnce(data?: any, headers?: HeadersInit, status?: number);
  mockJSONResponseOnce(data?: object, headers?: HeadersInit);
}

const mockFetch = jest.fn<typeof fetch>() as FetchMock;

mockFetch.mockResponseOnce = (
  data?: BodyInit,
  headers?: Headers,
  status: number = 200,
) => {
  return mockFetch.mockImplementationOnce(async () => {
    return new Response(data, {
      status,
      headers,
    });
  });
};

mockFetch.mockJSONResponseOnce = (
  data = {},
  headers?: Headers,
  status?: number,
) => {
  return mockFetch.mockResponseOnce(
    JSON.stringify(data),
    Object.assign({ 'Content-Type': 'application/json' }, headers),
    status,
  );
};

export { mockFetch as fetch, Request, Response, Headers, URL, URLSearchParams };
