import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyConfigChange } from '../src/shared/config/changeImpact';
import { normalizeConfig } from '../src/shared/config/normalize';
import { applyConfigPatch, requiresRestart } from '../src/shared/config/patch';
import type { AppConfig } from '../src/shared/types/config';
import { err, ok, type Result } from '../src/shared/types/result';
import { createConfigService } from '../src/server/domain/configService';
import type { DirectoryListing, FileStats, FileSystem } from '../src/server/infra/fileSystem';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const configOf = (raw: unknown): AppConfig => normalizeConfig(raw).config;

const BASE = { directories: ['/videos'] };

describe('classifyConfigChange', () => {
  const base = configOf(BASE);

  it('asks for nothing when only playback-side settings change', () => {
    const next = configOf({ ...BASE, crossfade: { duration: 3000 }, ui: { infoDuration: 9000 } });
    assert.equal(classifyConfigChange(base, next), 'none');
  });

  it('asks for a fresh queue when a directory bias changes', () => {
    const next = configOf({ directories: [{ directory: '/videos', bias: 2 }] });
    assert.equal(classifyConfigChange(base, next), 'requeue');
  });

  it('asks for a fresh queue when biases stop scaling with directory size', () => {
    const next = configOf({ ...BASE, selection: { scaleBiasByDirectorySize: false } });
    assert.equal(classifyConfigChange(base, next), 'requeue');
  });

  it('asks for a fresh queue when the length bias changes', () => {
    const next = configOf({ ...BASE, selection: { lengthBias: { enabled: true } } });
    assert.equal(classifyConfigChange(base, next), 'requeue');
  });

  it('asks for a fresh queue when the transcoded audio would differ', () => {
    const channels = base.audio.outputChannels === 2 ? 6 : 2;
    const next = configOf({ ...BASE, audio: { outputChannels: channels } });
    assert.equal(classifyConfigChange(base, next), 'requeue');
  });

  it('asks for a re-index when the library itself changes', () => {
    assert.equal(classifyConfigChange(base, configOf({ directories: ['/other'] })), 'reindex');
    assert.equal(
      classifyConfigChange(base, configOf({ ...BASE, files: { supportedVideoExtensions: ['.mkv'] } })),
      'reindex',
    );
  });
});

describe('applyConfigPatch', () => {
  it('lays only the changed fields over the file, keeping everything else', () => {
    const raw = {
      _comment: 'mine',
      directories: ['/videos'],
      video: { playbackQueueSize: 5, somethingNew: true },
    };
    const { value, touched } = applyConfigPatch(raw, { video: { preprocessedQueueSize: 7 } });
    assert.deepEqual(value, {
      _comment: 'mine',
      directories: ['/videos'],
      video: { playbackQueueSize: 5, somethingNew: true, preprocessedQueueSize: 7 },
    });
    assert.deepEqual(touched, ['video.preprocessedQueueSize']);
    // Pure: the input is left as it was.
    assert.deepEqual(raw.video, { playbackQueueSize: 5, somethingNew: true });
  });

  it('replaces a list wholesale', () => {
    const { value } = applyConfigPatch(
      { files: { supportedVideoExtensions: ['.mp4', '.mkv'] } },
      { files: { supportedVideoExtensions: ['.webm'] } },
    );
    assert.deepEqual(value, { files: { supportedVideoExtensions: ['.webm'] } });
  });

  it('removes the old spelling of a setting it writes', () => {
    const { value } = applyConfigPatch(
      { audio: { enabled51Processing: true, normalization: { targetLUFS: -20 } } },
      { audio: { surroundProcessingEnabled: false, normalization: { targetLufs: -16 } } },
    );
    assert.deepEqual(value, {
      audio: { surroundProcessingEnabled: false, normalization: { targetLufs: -16 } },
    });
  });

  it('writes a directory with the neutral bias as a bare path', () => {
    const { value } = applyConfigPatch(
      {},
      {
        directories: [
          { directory: '/plain', bias: 1 },
          { directory: '/biased', bias: 2 },
        ],
      },
    );
    assert.deepEqual(value, { directories: ['/plain', { directory: '/biased', bias: 2 }] });
  });

  it('never writes the access token, and ignores fields that are not settings', () => {
    const { value, touched, ignored } = applyConfigPatch(
      { network: { server: { authToken: 'secret' } } },
      { network: { server: { authToken: 'stolen', port: 4000 } }, nonsense: 1 },
    );
    assert.deepEqual(value, { network: { server: { authToken: 'secret', port: 4000 } } });
    assert.deepEqual(touched, ['network.server.port']);
    assert.deepEqual(ignored.slice().sort(), ['network.server.authToken', 'nonsense']);
  });

  it('refuses a value where a section belongs', () => {
    const { value, ignored } = applyConfigPatch({ video: { playbackQueueSize: 5 } }, { video: 3 });
    assert.deepEqual(value, { video: { playbackQueueSize: 5 } });
    assert.deepEqual(ignored, ['video']);
  });
});

describe('requiresRestart', () => {
  it('marks the settings only read at startup', () => {
    assert.equal(requiresRestart('network.server.port'), true);
    assert.equal(requiresRestart('system.tempDirectory'), true);
    assert.equal(requiresRestart('ui.startFullscreen'), true);
    assert.equal(requiresRestart('video.playbackQueueSize'), false);
    assert.equal(requiresRestart('selection.lengthBias.maxRatio'), false);
  });
});

const CONFIG_FILE = 'C:/videojuke/config.json';

const paths = {
  workingDirectory: 'C:/videojuke',
  installDirectory: 'C:/videojuke',
  configFile: CONFIG_FILE,
  defaultConfigFile: 'C:/videojuke/config.default.json',
  cacheDirectory: 'C:/videojuke/cache',
  tempDirectory: 'C:/videojuke/temp',
  archiveDirectory: 'C:/videojuke/archive',
  videoIndexFile: 'C:/videojuke/cache/video-index.json',
  queueStateFile: 'C:/videojuke/cache/queue-state.json',
  historyFile: 'C:/videojuke/cache/persisted-history.json',
  archiveFlagsFile: 'C:/videojuke/flagged_for_archive.json',
  favoritesFile: 'C:/vj/favorites.json',
};

/** Just enough of a filesystem for config.json to be read and written. */
const memoryFileSystem = (files: Map<string, string>): FileSystem => ({
  exists: async (path) => files.has(path),
  ensureDirectory: async () => ok(undefined),
  readText: async (path): Promise<Result<string>> => {
    const text = files.get(path);
    return text === undefined ? err(new Error(`no such file ${path}`)) : ok(text);
  },
  writeText: async (path, contents) => {
    files.set(path, contents);
    return ok(undefined);
  },
  readJson: async (path) => {
    const text = files.get(path);
    return text === undefined ? err(new Error('missing')) : ok(JSON.parse(text) as unknown);
  },
  writeJson: async (path, value) => {
    files.set(path, JSON.stringify(value));
    return ok(undefined);
  },
  writeJsonAtomically: async (path, value) => {
    files.set(path, JSON.stringify(value));
    return ok(undefined);
  },
  moveFile: async () => ok(undefined),
  remove: async (path) => ok(files.delete(path)),
  stat: async (): Promise<Result<FileStats>> => ok({ sizeBytes: 0, modifiedAtMs: 0 }),
  listFiles: async () => ok([]),
  listFilesRecursively: async (): Promise<Result<DirectoryListing>> =>
    ok({ files: [], unreadable: [] }),
});

const serviceWith = async (raw: unknown) => {
  const files = new Map([[CONFIG_FILE, JSON.stringify(raw, null, 2)]]);
  const service = await createConfigService({
    fileSystem: memoryFileSystem(files),
    paths,
    logger: silentLogger,
  });
  return { files, service };
};

describe('saving settings', () => {
  it('writes the change, applies it, and tells the listeners', async () => {
    const { files, service } = await serviceWith({
      directories: ['/videos'],
      network: { server: { authToken: 'secret' } },
    });
    const heard: AppConfig[] = [];
    service.watch((config) => {
      heard.push(config);
    });
    const before = service.revision();

    const result = await service.save({ directories: [{ directory: '/videos', bias: 3 }] });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.impact, 'requeue');
    assert.equal(service.current().directories[0]?.bias, 3);
    assert.equal(heard.length, 1);
    assert.ok(service.revision() > before);
    const written = JSON.parse(files.get(CONFIG_FILE) ?? '') as Record<string, unknown>;
    assert.deepEqual(written['directories'], [{ directory: '/videos', bias: 3 }]);
    // The token was in the file and stays there, untouched by the save.
    assert.deepEqual(written['network'], { server: { authToken: 'secret' } });
  });

  it('refuses a value it would have had to change, and writes nothing', async () => {
    const { files, service } = await serviceWith({ directories: ['/videos'] });
    const original = files.get(CONFIG_FILE);

    const result = await service.save({ selection: { lengthBias: { maxRatio: -4 } } });

    assert.equal(result.ok, false);
    assert.equal(files.get(CONFIG_FILE), original);
    assert.equal(service.current().selection.lengthBias.maxRatio, 10);
  });

  it('will not overwrite a file it cannot parse', async () => {
    const files = new Map([[CONFIG_FILE, '{ "directories": [ "/videos", ']]);
    const service = await createConfigService({
      fileSystem: memoryFileSystem(files),
      paths,
      logger: silentLogger,
    });

    const result = await service.save({ video: { playbackQueueSize: 3 } });

    assert.equal(result.ok, false);
    assert.equal(files.get(CONFIG_FILE), '{ "directories": [ "/videos", ');
  });

  it('names the settings that wait for a restart', async () => {
    const { service } = await serviceWith({ directories: ['/videos'] });
    const result = await service.save({ network: { server: { port: 4123 } } });
    assert.deepEqual(result.ok ? result.restartRequired : null, ['network.server.port']);
  });

  it('hands the panel the effective settings without the token', async () => {
    const { service } = await serviceWith({
      directories: ['/videos'],
      seasonalDirectories: [{ directory: '/xmas', likelihood: 0.5, conditions: { months: [12] } }],
      network: { server: { authToken: 'secret' } },
    });
    const editable = await service.editable();
    assert.equal(editable.config.network.server.authToken, '');
    assert.equal(editable.config.video.playbackQueueSize, configOf(BASE).video.playbackQueueSize);
    assert.deepEqual(editable.seasonalDirectories, [
      { directory: '/xmas', likelihood: 0.5, conditions: { months: [12] } },
    ]);
  });
});
