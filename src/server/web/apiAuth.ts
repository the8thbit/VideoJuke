import type { RequestHandler } from 'express';

import type { Logger } from '../../shared/types/logging';
import { AUTH_HEADER, AUTH_SCHEME } from '../../shared/types/protocol';
import { signaturesMatch } from '../infra/system';

export interface ApiAuthOptions {
  readonly token: string;
  readonly logger: Logger;
}

/**
 * Pulls the secret out of an `Authorization: Bearer <token>` header.
 *
 * Returns null for anything else, including a bare token with no scheme: being
 * lenient about the shape of a credential is how a header meant for one server
 * ends up being accepted by another.
 */
export const readBearerToken = (header: string | undefined): string | null => {
  if (typeof header !== 'string') return null;

  const separator = header.indexOf(' ');
  if (separator === -1) return null;

  const scheme = header.slice(0, separator);
  const value = header.slice(separator + 1).trim();
  if (scheme.toLowerCase() !== AUTH_SCHEME.toLowerCase() || value === '') return null;
  return value;
};

/**
 * Rejects any API request that does not carry the shared secret.
 *
 * Mounted in front of the API router only. Three things deliberately sit
 * outside it:
 *
 * - the static client page, because the browser has to be able to load it in
 *   order to be told it needs a token at all;
 * - `/health`, which answers "yes I am running" and nothing else;
 * - the stream route, which a `<video>` element requests and therefore cannot
 *   put a header on - it carries a signature in the URL instead.
 */
export const createApiAuth = ({ token, logger }: ApiAuthOptions): RequestHandler => {
  return (request, response, next) => {
    // A CORS preflight never carries credentials; rejecting it would only turn
    // an auth failure into a confusing browser-side CORS error.
    if (request.method === 'OPTIONS') {
      next();
      return;
    }

    const presented = readBearerToken(request.headers[AUTH_HEADER]);
    if (presented !== null && signaturesMatch(presented, token)) {
      next();
      return;
    }

    // The path, never the header: whatever was presented is either the real
    // secret or someone's guess at it, and neither belongs in a log file.
    logger.warn(`refused an unauthenticated ${request.method} ${request.baseUrl}${request.path}`);
    response.status(401).json({ error: 'a valid access token is required' });
  };
};
