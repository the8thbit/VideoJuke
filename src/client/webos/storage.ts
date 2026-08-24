import type { Logger } from '../../shared/types/logging';
import { attempt } from '../../shared/types/result';
import { parseNumber } from '../../shared/util/numbers';
import { readProperty } from '../../shared/util/objects';

export interface ServerAddress {
  readonly host: string;
  readonly port: number;
  /** The shared secret; the server refuses every request without it. */
  readonly token: string;
  /** `leader`, `follower`, or empty for a screen that plays on its own. */
  readonly role: string;
}

export interface ServerAddressStore {
  readonly load: () => Promise<ServerAddress | null>;
  readonly save: (address: ServerAddress) => Promise<boolean>;
  readonly clear: () => Promise<boolean>;
}

/** Unchanged from the legacy client, so an existing TV keeps its setting. */
const STORAGE_KEY = 'videojuke_config';

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Reads a stored record back into an address, or into nothing.
 *
 * The legacy version resolved whatever `JSON.parse` produced and left the
 * caller to write `config && config.host && config.port`, which it then did in
 * one place out of three. A record that has lost half of itself is not half an
 * address; it is no address, and the TV asks for one again.
 */
const decodeAddress = (raw: string | null): ServerAddress | null => {
  if (raw === null) return null;

  const parsed = attempt(() => JSON.parse(raw) as unknown);
  if (!parsed.ok) return null;

  const host = readProperty(parsed.value, 'host');
  const port = parseNumber(readProperty(parsed.value, 'port'));
  if (typeof host !== 'string' || host.trim() === '') return null;
  if (port === null || port < MIN_PORT || port > MAX_PORT) return null;

  // A record written before tokens existed has no token, and an empty one is
  // still an address worth restoring: the form comes back with the host and
  // port already filled in and only the token left to type.
  const token = readProperty(parsed.value, 'token');
  const role = readProperty(parsed.value, 'role');
  return {
    host: host.trim(),
    port: Math.round(port),
    token: typeof token === 'string' ? token.trim() : '',
    role: typeof role === 'string' ? role.trim() : '',
  };
};

/**
 * The saved server address, kept wherever this TV can keep it.
 *
 * webOS storage survives an app reinstall and localStorage does not, so it is
 * preferred where the firmware has it; every write is mirrored to localStorage
 * regardless, which is what makes the fallback path meaningful rather than
 * empty on the one TV where the platform store later disappears.
 */
export const createServerAddressStore = (logger: Logger): ServerAddressStore => {
  const platformStorage = (): WebOsStorageApi | null => {
    const platform = window.webOS;
    if (platform === undefined || platform.storage === undefined) return null;
    return platform.storage;
  };

  const readLocal = (): string | null => {
    const read = attempt(() => window.localStorage.getItem(STORAGE_KEY));
    if (read.ok) return read.value;
    logger.warn(`localStorage is unreadable - ${read.error.message}`);
    return null;
  };

  const writeLocal = (raw: string): boolean => {
    const written = attempt(() => {
      window.localStorage.setItem(STORAGE_KEY, raw);
    });
    if (written.ok) return true;
    logger.warn(`localStorage is unwritable - ${written.error.message}`);
    return false;
  };

  const clearLocal = (): boolean => {
    const cleared = attempt(() => {
      window.localStorage.removeItem(STORAGE_KEY);
    });
    if (cleared.ok) return true;
    logger.warn(`localStorage could not be cleared - ${cleared.error.message}`);
    return false;
  };

  const load = (): Promise<ServerAddress | null> => {
    const storage = platformStorage();
    if (storage === null) return Promise.resolve(decodeAddress(readLocal()));

    return new Promise((resolve) => {
      storage.get(
        STORAGE_KEY,
        (result) => {
          const raw = result === null || result.value === undefined ? null : result.value;
          const stored = decodeAddress(raw);
          // A missing or unusable platform record falls through rather than
          // ending the read: the mirror may still hold a good one.
          resolve(stored ?? decodeAddress(readLocal()));
        },
        (error) => {
          logger.debug(`webOS storage read failed - ${String(error)}`);
          resolve(decodeAddress(readLocal()));
        },
      );
    });
  };

  const save = (address: ServerAddress): Promise<boolean> => {
    const raw = JSON.stringify(address);
    const storage = platformStorage();
    if (storage === null) return Promise.resolve(writeLocal(raw));

    return new Promise((resolve) => {
      storage.set(
        STORAGE_KEY,
        raw,
        () => {
          writeLocal(raw);
          resolve(true);
        },
        (error) => {
          logger.debug(`webOS storage write failed - ${String(error)}`);
          resolve(writeLocal(raw));
        },
      );
    });
  };

  const clear = (): Promise<boolean> => {
    const storage = platformStorage();
    if (storage === null) return Promise.resolve(clearLocal());

    return new Promise((resolve) => {
      storage.remove(
        STORAGE_KEY,
        () => {
          resolve(clearLocal());
        },
        (error) => {
          logger.debug(`webOS storage clear failed - ${String(error)}`);
          resolve(clearLocal());
        },
      );
    });
  };

  logger.debug(`server address store ready (webOS storage: ${platformStorage() !== null})`);
  return { load, save, clear };
};
