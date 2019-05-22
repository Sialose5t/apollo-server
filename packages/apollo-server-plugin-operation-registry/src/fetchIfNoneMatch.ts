import fetch, { Response, RequestInit } from 'node-fetch';
import { Logger } from 'loglevel';

const urlCachedResponseMap: { [url: string]: Response } = {};

/**
 * @returns {[Response, boolean]} The boolean denotes whether the response was cached
 */
export async function fetchIfNoneMatch(
  url: string,
  logger: Logger,
  fetchOptions?: RequestInit,
): Promise<[Response, boolean]> {
  const cachedResponse = urlCachedResponseMap[url];
  const previousEtag = cachedResponse && cachedResponse.headers.get('etag');

  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      ...(fetchOptions && fetchOptions.headers),
      ...(previousEtag && { 'If-None-Match': previousEtag }),
    },
  });

  if (response.status === 304) {
    logger.debug(
      `The response for ${url} was the same as the previous attempt.`,
    );
    return [cachedResponse.clone(), true];
  }

  if (!response.ok) {
    throw new Error(`Fetching ${url} failed with ${await response.text()}`);
  }

  urlCachedResponseMap[url] = response;
  return [response.clone(), false];
}
