import { AUTH_TOKEN_PARAM } from '../../shared/types/protocol';
import { attempt } from '../../shared/types/result';

/** Where the token is kept between visits, so the URL only has to carry it once. */
const STORAGE_KEY = 'videojuke_token';
/** The same treatment for the screen's role, which is also per-client. */
const ROLE_KEY = 'videojuke_role';

export interface AccessToken {
  /** The token this page should use, or null when it has none yet. */
  readonly value: string | null;
  /** Forgets a token the server has rejected, so the next load asks again. */
  readonly clear: () => void;
}

const readStored = (): string | null => {
  const read = attempt(() => window.localStorage.getItem(STORAGE_KEY));
  return read.ok ? read.value : null;
};

const store = (token: string): void => {
  // A browser with storage disabled still works for this session; it just has
  // to be given the token again next time.
  attempt(() => {
    window.localStorage.setItem(STORAGE_KEY, token);
  });
};

/**
 * Takes the token out of the address bar and remembers it.
 *
 * The server prints the token once and, when it opens a browser for you, puts it
 * in the URL. Stripping it immediately afterwards keeps it out of the address
 * bar, out of the history entry, and out of any `Referer` the page later sends -
 * a URL is the one place a credential is hardest to take back.
 */
const takeFromUrl = (): string | null => {
  const found = attempt(() => {
    const url = new URL(window.location.href);
    const token = url.searchParams.get(AUTH_TOKEN_PARAM);
    if (token === null || token.trim() === '') return null;

    url.searchParams.delete(AUTH_TOKEN_PARAM);
    window.history.replaceState(null, '', url.toString());
    return token.trim();
  });
  return found.ok ? found.value : null;
};

export const resolveAccessToken = (): AccessToken => {
  const fromUrl = takeFromUrl();
  if (fromUrl !== null) store(fromUrl);

  return {
    value: fromUrl ?? readStored(),
    clear: () => {
      attempt(() => {
        window.localStorage.removeItem(STORAGE_KEY);
      });
    },
  };
};

/**
 * The role this screen plays, from `?role=` or from the last time it was given
 * one. Kept beside the token because it is the same kind of thing: per client,
 * not per server, and tedious to supply on every visit.
 */
export const resolveScreenRole = (): string | null => {
  const fromUrl = attempt(() => {
    const url = new URL(window.location.href);
    const role = url.searchParams.get('role');
    if (role === null || role.trim() === '') return null;

    url.searchParams.delete('role');
    window.history.replaceState(null, '', url.toString());
    return role.trim();
  });

  if (fromUrl.ok && fromUrl.value !== null) {
    attempt(() => {
      window.localStorage.setItem(ROLE_KEY, fromUrl.value as string);
    });
    return fromUrl.value;
  }

  const stored = attempt(() => window.localStorage.getItem(ROLE_KEY));
  return stored.ok ? stored.value : null;
};

export const MISSING_TOKEN_MESSAGE =
  'This player needs an access token. Open it once as ' +
  `?${AUTH_TOKEN_PARAM}=<token>, using the token the server printed when it started. ` +
  'The token is remembered per address, so a player opened at a different ' +
  'hostname or port has to be given it again.';

export const REJECTED_TOKEN_MESSAGE =
  'The server rejected this access token. Open the player again with a current ' +
  `?${AUTH_TOKEN_PARAM}=<token> to replace it.`;
