import {
  VIDEO_STREAM_EXPIRES_PARAM,
  VIDEO_STREAM_FILENAME_PARAM,
  VIDEO_STREAM_SIGNATURE_PARAM,
} from '../../shared/types/protocol';
import { signWith, signaturesMatch } from '../infra/system';

export interface StreamSigner {
  /** The query string, without a leading `?`, authorising this filename. */
  readonly sign: (filename: string, nowMs: number) => string;
  readonly verify: (request: StreamRequest, nowMs: number) => StreamVerdict;
}

export interface StreamRequest {
  readonly filename: string;
  readonly expires: string | undefined;
  readonly signature: string | undefined;
}

export type StreamVerdict = 'ok' | 'expired' | 'invalid';

export interface StreamSignerOptions {
  readonly secret: string;
  /** How long a handed-out URL stays usable; see `timeouts.streamUrlLifetime`. */
  readonly lifetimeMs: number;
}

/**
 * What the signature covers.
 *
 * The filename is in it so a URL for one video cannot be edited into a URL for
 * another, and the expiry is in it so the deadline cannot be pushed back. There
 * is no nonce and no replay list: on a LAN appliance whose whole threat model is
 * "something else on the network", a URL that only works for one file until it
 * expires is the right amount of machinery. Anyone who can read the URL can
 * already watch the video over your network.
 */
const message = (filename: string, expiresAt: number): string => `${filename}:${expiresAt}`;

export const createStreamSigner = ({ secret, lifetimeMs }: StreamSignerOptions): StreamSigner => ({
  sign: (filename, nowMs) => {
    const expiresAt = nowMs + lifetimeMs;
    const signature = signWith(secret, message(filename, expiresAt));
    return (
      `${VIDEO_STREAM_FILENAME_PARAM}=${encodeURIComponent(filename)}` +
      `&${VIDEO_STREAM_EXPIRES_PARAM}=${expiresAt}` +
      `&${VIDEO_STREAM_SIGNATURE_PARAM}=${signature}`
    );
  },

  verify: ({ filename, expires, signature }, nowMs) => {
    if (typeof expires !== 'string' || typeof signature !== 'string') return 'invalid';

    const expiresAt = Number(expires);
    if (!Number.isFinite(expiresAt)) return 'invalid';

    // Signature before expiry, so an attacker cannot learn from the response
    // whether a filename they guessed at ever existed.
    if (!signaturesMatch(signature, signWith(secret, message(filename, expiresAt)))) {
      return 'invalid';
    }
    return nowMs <= expiresAt ? 'ok' : 'expired';
  },
});
