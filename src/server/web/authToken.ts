import type { Logger } from '../../shared/types/logging';
import { err, ok, type Result } from '../../shared/types/result';
import { isPlainObject } from '../../shared/util/objects';
import type { FileSystem } from '../infra/fileSystem';
import type { AppPaths } from '../infra/paths';

export interface AuthTokenDeps {
  readonly fileSystem: FileSystem;
  readonly paths: AppPaths;
  readonly logger: Logger;
  /** The token already configured, if any. */
  readonly configured: string;
  readonly newSecret: () => string;
}

/**
 * Adds the token to a parsed config object without disturbing anything else in
 * it. The nested sections are rebuilt rather than mutated, because the value
 * came from `JSON.parse` and may be missing either of them.
 */
const withToken = (raw: unknown, token: string): Record<string, unknown> => {
  const root = isPlainObject(raw) ? { ...raw } : {};
  const network = isPlainObject(root['network']) ? { ...root['network'] } : {};
  const server = isPlainObject(network['server']) ? { ...network['server'] } : {};

  server['authToken'] = token;
  network['server'] = server;
  root['network'] = network;
  return root;
};

/**
 * Guarantees the web server has a shared secret, generating one on first run.
 *
 * The server refuses to run without one. It has no authentication of any other
 * kind, it hands out the paths of every video in the library, and it is
 * routinely bound to `0.0.0.0` so a TV can reach it - "no token configured"
 * would mean "anything on the network can drive this", which is not a default
 * worth having.
 *
 * Writing to config.json is a departure: `configService` deliberately never
 * saves the merged configuration back, precisely so a changed default stays
 * visible. Only this one field is written, and only when it is absent. It is
 * safe to do here because the config file watcher is installed later, by
 * `session.start`, so this write cannot trigger a reload of itself.
 */
export const ensureAuthToken = async (deps: AuthTokenDeps): Promise<Result<string, Error>> => {
  const configured = deps.configured.trim();
  if (configured !== '') return ok(configured);

  const token = deps.newSecret();
  const existing = await deps.fileSystem.readJson(deps.paths.configFile);
  if (!existing.ok) {
    // Refusing rather than overwriting: an unreadable config.json is a file the
    // user has in some state we do not understand, and replacing it wholesale
    // to add one field would be the wrong way to find that out.
    return err(
      new Error(
        `cannot add an authToken to ${deps.paths.configFile}: ${existing.error.message}. ` +
          'Fix the file, or set network.server.authToken by hand.',
      ),
    );
  }

  const written = await deps.fileSystem.writeJsonAtomically(
    deps.paths.configFile,
    withToken(existing.value, token),
  );
  if (!written.ok) {
    return err(
      new Error(
        `cannot write ${deps.paths.configFile}: ${written.error.message}. ` +
          'Set network.server.authToken by hand to start the server.',
      ),
    );
  }

  // Printed once, deliberately. It is the only moment the operator can learn
  // the value, and they need it to set up a TV; every later mention of the
  // token anywhere in the logs is a leak.
  deps.logger.info(
    `generated an access token and saved it to ${deps.paths.configFile}\n` +
      `\n    ${token}\n\n` +
      '    Clients on this machine pick it up automatically. Enter it on a TV, ' +
      'or append it to the player URL once as ?token=<token>.',
  );
  return ok(token);
};
