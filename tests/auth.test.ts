import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/shared/config/normalize';
import { toClientConfig } from '../src/shared/types/config';
import { ok, type Result } from '../src/shared/types/result';
import { readBearerToken } from '../src/server/web/apiAuth';
import { ensureAuthToken } from '../src/server/web/authToken';
import { createStreamSigner } from '../src/server/web/streamUrl';
import { isTokenSubprotocolSafe, newSecret } from '../src/server/infra/system';
import type { DirectoryListing, FileStats, FileSystem } from '../src/server/infra/fileSystem';

const SECRET = 'a4f1c9d20b7e46138a5c0e9f2b3d7a61';
const HOUR = 3600000;

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

describe('generated tokens', () => {
  it('are long, and safe everywhere they have to travel', () => {
    for (let i = 0; i < 20; i += 1) {
      const token = newSecret();
      assert.equal(token.length, 32, '128 bits of hex');
      assert.ok(isTokenSubprotocolSafe(token));
      // Also has to survive a URL and a JSON file untouched.
      assert.equal(encodeURIComponent(token), token);
      assert.equal(JSON.parse(JSON.stringify(token)), token);
    }
  });

  it('are all different', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newSecret()));
    assert.equal(seen.size, 200);
  });

  it('spots a hand-edited token a WebSocket cannot carry', () => {
    // The transport falls back to polling rather than failing, so without this
    // check the socket silently never works.
    assert.equal(isTokenSubprotocolSafe('has space'), false);
    assert.equal(isTokenSubprotocolSafe('comma,separated'), false);
    assert.equal(isTokenSubprotocolSafe(''), false);
    assert.equal(isTokenSubprotocolSafe('perfectly-fine_1'), true);
  });
});

describe('readBearerToken', () => {
  it('accepts a well-formed header, whatever the scheme case', () => {
    assert.equal(readBearerToken(`Bearer ${SECRET}`), SECRET);
    assert.equal(readBearerToken(`bearer ${SECRET}`), SECRET);
    assert.equal(readBearerToken(`BEARER   ${SECRET}  `), SECRET);
  });

  it('refuses anything that is not a bearer credential', () => {
    // A bare token is refused on purpose: being lenient about the shape of a
    // credential is how a header meant for one server is accepted by another.
    assert.equal(readBearerToken(SECRET), null);
    assert.equal(readBearerToken(`Basic ${SECRET}`), null);
    assert.equal(readBearerToken('Bearer '), null);
    assert.equal(readBearerToken(''), null);
    assert.equal(readBearerToken(undefined), null);
  });
});

describe('signed stream URLs', () => {
  const signer = createStreamSigner({ secret: SECRET, lifetimeMs: 12 * HOUR });
  const now = 1_700_000_000_000;

  const parse = (query: string) => {
    const params = new URLSearchParams(query);
    return {
      filename: params.get('filename') ?? '',
      expires: params.get('expires') ?? undefined,
      signature: params.get('sig') ?? undefined,
    };
  };

  it('signs a URL that verifies', () => {
    const request = parse(signer.sign('processed_abc.mp4', now));
    assert.equal(request.filename, 'processed_abc.mp4');
    assert.equal(signer.verify(request, now), 'ok');
  });

  it('never puts the secret in the URL', () => {
    assert.equal(signer.sign('processed_abc.mp4', now).includes(SECRET), false);
  });

  it('stays valid right up to the deadline and not past it', () => {
    const request = parse(signer.sign('processed_abc.mp4', now));
    assert.equal(signer.verify(request, now + 12 * HOUR), 'ok');
    assert.equal(signer.verify(request, now + 12 * HOUR + 1), 'expired');
  });

  it('refuses a forged or altered signature', () => {
    const request = parse(signer.sign('processed_abc.mp4', now));
    assert.equal(signer.verify({ ...request, signature: 'forged' }, now), 'invalid');
    assert.equal(signer.verify({ ...request, signature: undefined }, now), 'invalid');
  });

  it('will not let a signature be moved to another file', () => {
    // The whole point of signing the filename: one URL authorises one video.
    const request = parse(signer.sign('processed_abc.mp4', now));
    assert.equal(signer.verify({ ...request, filename: 'processed_other.mp4' }, now), 'invalid');
  });

  it('will not let the deadline be pushed back', () => {
    const request = parse(signer.sign('processed_abc.mp4', now));
    const later = String(Number(request.expires) + HOUR);
    assert.equal(signer.verify({ ...request, expires: later }, now), 'invalid');
  });

  it('rejects a nonsense expiry rather than trusting it', () => {
    const request = parse(signer.sign('processed_abc.mp4', now));
    for (const expires of ['soon', '', 'NaN', undefined]) {
      assert.equal(signer.verify({ ...request, expires }, now), 'invalid', String(expires));
    }
  });

  it('is keyed, so another server cannot sign for this one', () => {
    const other = createStreamSigner({ secret: newSecret(), lifetimeMs: 12 * HOUR });
    const request = parse(other.sign('processed_abc.mp4', now));
    assert.equal(signer.verify(request, now), 'invalid');
  });

  it('survives a filename that needs escaping', () => {
    const awkward = 'processed_a b&c=d.mp4';
    const request = parse(signer.sign(awkward, now));
    assert.equal(request.filename, awkward, 'the query must round-trip the name');
    assert.equal(signer.verify(request, now), 'ok');
  });
});

describe('the token in the configuration', () => {
  it('leaves the shipped defaults free of complaints', () => {
    const { config, issues } = normalizeConfig({ directories: ['/videos'] });
    assert.equal(config.network.server.authToken, '', 'empty means "generate one"');
    assert.deepEqual(issues.filter((issue) => issue.path.includes('authToken')), []);
  });

  it('never echoes a bad token into an issue message', () => {
    // Issues are logged, and every log entry is broadcast to every client.
    const secret = 'super-secret-value';
    const { issues } = normalizeConfig({
      directories: ['/videos'],
      network: { server: { authToken: { nested: secret } } },
    });
    const about = issues.filter((issue) => issue.path.includes('authToken'));
    assert.equal(about.length, 1);
    assert.equal(about[0]?.message.includes(secret), false, 'the value must not appear');
  });

  it('trims a token someone pasted with whitespace', () => {
    const { config } = normalizeConfig({
      directories: ['/videos'],
      network: { server: { authToken: `  ${SECRET}\n` } },
    });
    assert.equal(config.network.server.authToken, SECRET);
  });

  it('never leaves the server: ClientConfig has no network section', () => {
    const { config } = normalizeConfig({
      directories: ['/videos'],
      network: { server: { authToken: SECRET } },
    });
    const client = toClientConfig(config);
    assert.equal('network' in client, false);
    assert.equal(JSON.stringify(client).includes(SECRET), false);
  });
});

describe('ensureAuthToken', () => {
  const paths = {
    workingDirectory: 'C:/vj',
    installDirectory: 'C:/vj',
    configFile: 'C:/vj/config.json',
    defaultConfigFile: 'C:/vj/config.default.json',
    cacheDirectory: 'C:/vj/cache',
    tempDirectory: 'C:/vj/temp',
    archiveDirectory: 'C:/vj/archive',
    videoIndexFile: 'C:/vj/cache/video-index.json',
    queueStateFile: 'C:/vj/cache/queue-state.json',
    historyFile: 'C:/vj/cache/persisted-history.json',
    archiveFlagsFile: 'C:/vj/flagged_for_archive.json',
  };

  const fakeFileSystem = (
    contents: unknown,
    options: { readonly readFails?: boolean; readonly writeFails?: boolean } = {},
  ) => {
    const written: unknown[] = [];
    const system: FileSystem = {
      exists: async () => true,
      ensureDirectory: async () => ok(undefined),
      readText: async () => ok(''),
      writeText: async () => ok(undefined),
      readJson: async () =>
        options.readFails === true
          ? { ok: false as const, error: new Error('not valid JSON') }
          : ok(contents),
      writeJson: async () => ok(undefined),
      writeJsonAtomically: async (_path, value) => {
        if (options.writeFails === true) {
          return { ok: false as const, error: new Error('read-only file system') };
        }
        written.push(value);
        return ok(undefined);
      },
      moveFile: async () => ok(undefined),
      remove: async () => ok(true),
      stat: async (): Promise<Result<FileStats>> => ok({ sizeBytes: 0, modifiedAtMs: 0 }),
      listFiles: async () => ok([]),
      listFilesRecursively: async (): Promise<Result<DirectoryListing>> =>
        ok({ files: [], unreadable: [] }),
    };
    return { system, written };
  };

  const run = (
    configured: string,
    contents: unknown,
    options?: { readonly readFails?: boolean; readonly writeFails?: boolean },
  ) => {
    const disk = fakeFileSystem(contents, options);
    return {
      disk,
      result: ensureAuthToken({
        fileSystem: disk.system,
        paths,
        logger: silentLogger,
        configured,
        newSecret: () => SECRET,
      }),
    };
  };

  it('keeps a token that is already configured, and writes nothing', async () => {
    const { disk, result } = run(SECRET, {});
    const outcome = await result;
    assert.equal(outcome.ok && outcome.value, SECRET);
    assert.deepEqual(disk.written, [], 'an existing token must not be rewritten');
  });

  it('generates one and saves it under network.server', async () => {
    const { disk, result } = run('', { directories: ['/videos'] });
    const outcome = await result;

    assert.equal(outcome.ok && outcome.value, SECRET);
    const saved = disk.written[0] as Record<string, Record<string, Record<string, unknown>>>;
    assert.equal(saved['network']?.['server']?.['authToken'], SECRET);
    assert.deepEqual(saved['directories'], ['/videos'], 'the rest of the file survives');
  });

  it('builds the nested sections when the config has none', async () => {
    const { disk, result } = run('', {});
    await result;
    const saved = disk.written[0] as Record<string, Record<string, Record<string, unknown>>>;
    assert.equal(saved['network']?.['server']?.['authToken'], SECRET);
  });

  it('preserves other network settings', async () => {
    const { disk, result } = run('', { network: { server: { port: 9999, host: '0.0.0.0' } } });
    await result;
    const saved = disk.written[0] as Record<string, Record<string, Record<string, unknown>>>;
    assert.equal(saved['network']?.['server']?.['port'], 9999);
    assert.equal(saved['network']?.['server']?.['host'], '0.0.0.0');
  });

  it('refuses rather than overwriting a config it could not read', async () => {
    // A half-finished hand edit is not a file to replace wholesale just to add
    // one field to it.
    const { disk, result } = run('', {}, { readFails: true });
    const outcome = await result;
    assert.equal(outcome.ok, false);
    assert.deepEqual(disk.written, []);
  });

  it('refuses when the token cannot be saved', async () => {
    // Returning the token anyway would mean it worked once and never again.
    const outcome = await run('', {}, { writeFails: true }).result;
    assert.equal(outcome.ok, false);
  });

  it('treats a whitespace-only token as unset', async () => {
    const { disk, result } = run('   ', {});
    const outcome = await result;
    assert.equal(outcome.ok && outcome.value, SECRET);
    assert.equal(disk.written.length, 1);
  });
});
