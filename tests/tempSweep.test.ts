import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeConfigHash } from '../src/shared/config/hash';
import { normalizeConfig } from '../src/shared/config/normalize';
import { createFixedClock } from '../src/shared/time/clock';
import type { AppConfig } from '../src/shared/types/config';
import { ok, type Result } from '../src/shared/types/result';
import {
  TEMP_FILE_MAX_AGE_MS,
  createQueuePersistence,
} from '../src/server/domain/queuePersistence';
import { createVideoPathGuard } from '../src/server/domain/videoPaths';
import type { DirectoryListing, FileStats, FileSystem } from '../src/server/infra/fileSystem';

const TEMP = 'C:/videojuke/temp';
const CACHE = 'C:/videojuke/cache';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const paths = {
  workingDirectory: 'C:/videojuke',
  installDirectory: 'C:/videojuke',
  configFile: 'C:/videojuke/config.json',
  defaultConfigFile: 'C:/videojuke/config.default.json',
  cacheDirectory: CACHE,
  tempDirectory: TEMP,
  archiveDirectory: 'C:/videojuke/archive',
  videoIndexFile: `${CACHE}/video-index.json`,
  queueStateFile: `${CACHE}/queue-state.json`,
  historyFile: `${CACHE}/persisted-history.json`,
  archiveFlagsFile: 'C:/videojuke/flagged_for_archive.json',
};

/** An in-memory filesystem holding only what the sweep looks at. */
const fakeFileSystem = (files: Map<string, number>) => {
  const removed: string[] = [];
  const system: FileSystem = {
    exists: async (path) => path === TEMP || files.has(path),
    ensureDirectory: async () => ok(undefined),
    readText: async () => ok(''),
    writeText: async () => ok(undefined),
    readJson: async () => ok(undefined),
    writeJson: async () => ok(undefined),
    writeJsonAtomically: async () => ok(undefined),
    moveFile: async () => ok(undefined),
    remove: async (path) => {
      removed.push(path);
      files.delete(path);
      return ok(true);
    },
    stat: async (path): Promise<Result<FileStats>> =>
      ok({ sizeBytes: 1024, modifiedAtMs: files.get(path) ?? 0 }),
    listFiles: async () => ok([...files.keys()]),
    listFilesRecursively: async (): Promise<Result<DirectoryListing>> =>
      ok({ files: [...files.keys()], unreadable: [] }),
  };
  return { system, removed };
};

const sweepAt = async (
  nowMs: number,
  files: Map<string, number>,
  protectedPaths: ReadonlySet<string>,
) => {
  const config: AppConfig = normalizeConfig({ directories: ['X:/videos'] }).config;
  const { system, removed } = fakeFileSystem(files);
  const persistence = createQueuePersistence({
    fileSystem: system,
    paths,
    clock: createFixedClock(nowMs),
    logger: silentLogger,
    config: () => config,
    digest: (input) => `len:${input.length}`,
    videoPaths: createVideoPathGuard({ tempDirectory: TEMP, config: () => config }),
  });
  const count = await persistence.cleanupTempDirectory(protectedPaths);
  return { removed, count };
};

/** Long enough that everything written at t=0 is well past the grace period. */
const MUCH_LATER = TEMP_FILE_MAX_AGE_MS * 9;

describe('temp sweep during a very long pause', () => {
  it('spares the transcode that is still being watched', async () => {
    // A viewer who pauses overnight is the case this exists for: the file backing
    // the frame on screen ages past the grace period while nothing else touches
    // it, and sweeping it would pull the video out from under the player.
    const watching = `${TEMP}/processed_watching.mp4`;
    const files = new Map([
      [watching, 0],
      [`${TEMP}/processed_orphan.mp4`, 0],
    ]);

    const { removed } = await sweepAt(MUCH_LATER, files, new Set([watching]));

    assert.deepEqual(removed, [`${TEMP}/processed_orphan.mp4`]);
    assert.ok(files.has(watching), 'the video being watched must survive');
  });

  it('keeps sparing it however many times the sweep runs', async () => {
    const watching = `${TEMP}/processed_watching.mp4`;
    const files = new Map([[watching, 0]]);

    // The sweep is on a timer, so a long pause means many passes over the same
    // file, each one further past the grace period than the last.
    for (let pass = 1; pass <= 20; pass += 1) {
      const { removed } = await sweepAt(
        TEMP_FILE_MAX_AGE_MS * pass * 3,
        files,
        new Set([watching]),
      );
      assert.deepEqual(removed, [], `pass ${pass} removed something`);
    }
    assert.ok(files.has(watching));
  });

  it('leaves a young orphan alone, since ffmpeg may still be writing it', async () => {
    const files = new Map([[`${TEMP}/processed_fresh.mp4`, TEMP_FILE_MAX_AGE_MS]]);
    const { removed } = await sweepAt(TEMP_FILE_MAX_AGE_MS + 1000, files, new Set());
    assert.deepEqual(removed, []);
  });

  it('removes an unprotected transcode once it is genuinely stale', async () => {
    const files = new Map([[`${TEMP}/processed_stale.mp4`, 0]]);
    const { removed, count } = await sweepAt(MUCH_LATER, files, new Set());
    assert.deepEqual(removed, [`${TEMP}/processed_stale.mp4`]);
    assert.equal(count, 1);
  });

  it('never touches a file it did not write', async () => {
    // `system.tempDirectory` is a path the user chooses, and it may not be empty.
    const files = new Map([
      [`${TEMP}/holiday-photos.mp4`, 0],
      [`${TEMP}/notes.txt`, 0],
      [`${TEMP}/processed_stale.mp4`, 0],
      [`${TEMP}/processed_but_not_ours.mkv`, 0],
    ]);

    const { removed } = await sweepAt(MUCH_LATER, files, new Set());

    assert.deepEqual(removed, [`${TEMP}/processed_stale.mp4`]);
    assert.ok(files.has(`${TEMP}/holiday-photos.mp4`));
    assert.ok(files.has(`${TEMP}/notes.txt`));
    assert.ok(files.has(`${TEMP}/processed_but_not_ours.mkv`));
  });

  it('matches protection by name, so a moved temp directory still shields it', async () => {
    // The queue entry and the file on disk can spell the same location
    // differently once the temp directory has moved under the working directory.
    const files = new Map([[`${TEMP}/processed_watching.mp4`, 0]]);
    const { removed } = await sweepAt(
      MUCH_LATER,
      files,
      new Set(['D:/somewhere/else/processed_watching.mp4']),
    );
    assert.deepEqual(removed, []);
  });
});

/**
 * A filesystem where a chosen set of paths is readable and nothing else is,
 * which is what an unmounted share looks like from `fs.access`.
 */
const fakeVolume = (present: ReadonlySet<string>, state: { readonly queued: unknown }) => {
  const removed: string[] = [];
  const system: FileSystem = {
    exists: async (path) => present.has(path),
    ensureDirectory: async () => ok(undefined),
    readText: async () => ok(''),
    readJson: async () => ok(state.queued),
    writeText: async () => ok(undefined),
    writeJson: async () => ok(undefined),
    writeJsonAtomically: async () => ok(undefined),
    moveFile: async () => ok(undefined),
    remove: async (path) => {
      removed.push(path);
      return ok(true);
    },
    stat: async (): Promise<Result<FileStats>> => ok({ sizeBytes: 1, modifiedAtMs: 0 }),
    listFiles: async () => ok([]),
    listFilesRecursively: async (): Promise<Result<DirectoryListing>> =>
      ok({ files: [], unreadable: [] }),
  };
  return { system, removed };
};

describe('restoring a saved queue when the library is not mounted yet', () => {
  const config: AppConfig = normalizeConfig({ directories: ['Z:/videos'] }).config;
  const digest = (input: string) => `len:${input.length}`;
  const transcode = `${TEMP}/processed_a.mp4`;

  const savedState = () => ({
    savedAt: '2026-01-01T00:00:00.000Z',
    fingerprint: computeConfigHash(config, digest),
    queued: [
      {
        originalPath: 'Z:/videos/a.mp4',
        filename: 'a.mp4',
        directory: 'Z:/videos',
        addedAt: '2026-01-01T00:00:00.000Z',
        seasonalDirectory: null,
        processedPath: transcode,
        processedAt: '2026-01-01T00:00:00.000Z',
        metadata: null,
        crossfadeTiming: null,
      },
    ],
    recentHistory: [],
  });

  const restore = async (present: ReadonlySet<string>) => {
    const { system, removed } = fakeVolume(present, { queued: savedState() });
    const persistence = createQueuePersistence({
      fileSystem: system,
      paths,
      clock: createFixedClock(0),
      logger: silentLogger,
      config: () => config,
      digest,
      videoPaths: createVideoPathGuard({ tempDirectory: TEMP, config: () => config }),
    });
    return { snapshot: await persistence.load(), removed };
  };

  it('keeps the transcode when the source directory cannot be read at all', async () => {
    // A machine that autostarts before its share maps sees every source at once
    // as "deleted". Answering that by unlinking the transcodes throws away every
    // hour of encoding the previous run did, seconds before the share appears.
    const { snapshot, removed } = await restore(
      new Set([paths.cacheDirectory, paths.queueStateFile, transcode]),
    );

    assert.deepEqual(removed, [], 'an unreachable volume is not a deleted file');
    assert.deepEqual(snapshot?.queued, [], 'the entry is still dropped from the restored queue');
  });

  it('still removes the orphan when the directory is readable and the file is gone', async () => {
    const { snapshot, removed } = await restore(
      new Set([paths.cacheDirectory, paths.queueStateFile, transcode, 'Z:/videos']),
    );

    assert.deepEqual(removed, [transcode], 'a source that is provably gone leaves an orphan');
    assert.deepEqual(snapshot?.queued, []);
  });

  it('restores the entry untouched when both files are there', async () => {
    const { snapshot, removed } = await restore(
      new Set([
        paths.cacheDirectory,
        paths.queueStateFile,
        transcode,
        'Z:/videos',
        'Z:/videos/a.mp4',
      ]),
    );

    assert.deepEqual(removed, []);
    assert.equal(snapshot?.queued.length, 1);
  });
});
