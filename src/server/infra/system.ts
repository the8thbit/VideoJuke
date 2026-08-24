import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';

import { asVideoId, type VideoId } from '../../shared/types/brand';
import type { RandomSource } from '../../shared/util/arrays';

/** Non-deterministic capabilities, injected so the domain layer stays pure. */
export interface SystemServices {
  readonly random: RandomSource;
  readonly newVideoId: () => VideoId;
  readonly digest: (input: string) => string;
  readonly delay: (milliseconds: number) => Promise<void>;
  /** A fresh shared secret, for the first run of a server that has none. */
  readonly newSecret: () => string;
}

export const md5 = (input: string): string => createHash('md5').update(input).digest('hex');

/**
 * 128 bits of randomness as plain hex.
 *
 * Hex rather than base64url because this string has to survive being a
 * WebSocket subprotocol, where RFC 6455 allows only RFC 7230 token characters,
 * a URL query parameter, a JSON file and a TV's on-screen keyboard. Hex is legal
 * in all four with no escaping and no case folding, and 128 bits is far beyond
 * what a LAN appliance needs.
 */
export const newSecret = (): string => randomBytes(16).toString('hex');

/**
 * Whether a token can travel as a WebSocket subprotocol.
 *
 * A hand-edited token containing a space or a comma makes the browser's
 * `new WebSocket(url, [name, token])` throw, which the transport swallows into
 * its polling fallback - the socket then silently never works while HTTP still
 * does. Worth one check at startup rather than a mystery later.
 */
export const isTokenSubprotocolSafe = (token: string): boolean =>
  /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(token);

/** Keyed digest used to sign stream URLs; truncated to keep those URLs short. */
export const signWith = (secret: string, message: string): string =>
  createHmac('sha256', secret).update(message).digest('base64url').slice(0, 32);

/**
 * Compares two signatures without leaking where they first differ.
 *
 * A plain `===` on a secret-derived value is a timing oracle. It is a small one
 * over a LAN, but constant-time comparison costs nothing here.
 */
export const signaturesMatch = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

export const delay = (milliseconds: number): Promise<void> =>
  milliseconds <= 0
    ? Promise.resolve()
    : new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      });

export const systemServices: SystemServices = {
  random: Math.random,
  newVideoId: () => asVideoId(randomUUID()),
  digest: md5,
  delay,
  newSecret,
};
