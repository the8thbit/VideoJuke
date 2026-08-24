import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/shared/config/normalize';
import { createFixedClock } from '../src/shared/time/clock';
import { asIsoTimestamp, asSourceVideoPath } from '../src/shared/types/brand';
import { ok, type Result } from '../src/shared/types/result';
import type { ArchiveFlag, IndexedVideo } from '../src/shared/types/video';
import { countOutcomes, moveFlaggedVideos } from '../src/server/archive/mover';
import {
  createArchiveFlagsStore,
  decodeArchiveFlags,
} from '../src/server/domain/archiveFlags';
import { createVideoPathGuard } from '../src/server/domain/videoPaths';
import type { DirectoryListing, FileStats, FileSystem } from '../src/server/infra/fileSystem';

const LIBRARY = 'X:/videos';
const ARCHIVE = 'X:/archive';
const FLAGS_FILE = 'C:/videojuke/flagged_for_archive.json';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const config = normalizeConfig({
  directories: [LIBRARY],
  system: { archiveDirectory: ARCHIVE },
}).config;

const guard = createVideoPathGuard({
  tempDirectory: 'C:/videojuke/temp',
  config: () => config,
});

const indexed = (name: string): IndexedVideo => ({
  originalPath: asSourceVideoPath(`${LIBRARY}/${name}`),
  filename: name,
  directory: LIBRARY,
  addedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
  seasonalDirectory: null,
});

const flag = (name: string): ArchiveFlag => ({
  originalPath: asSourceVideoPath(`${LIBRARY}/${name}`),
  filename: name,
  flaggedAt: asIsoTimestamp('2026-01-01T00:00:00.000Z'),
});

/** An in-memory disk: a set of paths that exist, plus a record of what moved. */
const fakeFileSystem = (present: Set<string>, failMoves: ReadonlySet<string> = new Set()) => {
  const moves: { from: string; to: string }[] = [];
  const written = new Map<string, unknown>();
  const removed: string[] = [];
  const directories: string[] = [];

  const system: FileSystem = {
    exists: async (path) => present.has(path),
    ensureDirectory: async (path) => {
      directories.push(path);
      return ok(undefined);
    },
    readText: async () => ok(''),
    writeText: async () => ok(undefined),
    readJson: async (path) => ok(written.get(path)),
    writeJson: async () => ok(undefined),
    writeJsonAtomically: async (path, value) => {
      written.set(path, value);
      present.add(path);
      return ok(undefined);
    },
    remove: async (path) => {
      removed.push(path);
      present.delete(path);
      written.delete(path);
      return ok(true);
    },
    moveFile: async (from, to) => {
      if (failMoves.has(from)) return { ok: false as const, error: new Error('device is busy') };
      moves.push({ from, to });
      present.delete(from);
      present.add(to);
      return ok(undefined);
    },
    stat: async (): Promise<Result<FileStats>> => ok({ sizeBytes: 1, modifiedAtMs: 0 }),
    listFiles: async () => ok([]),
    listFilesRecursively: async (): Promise<Result<DirectoryListing>> =>
      ok({ files: [], unreadable: [] }),
  };

  return { system, moves, written, removed, directories };
};

const paths = {
  workingDirectory: 'C:/videojuke',
  installDirectory: 'C:/videojuke',
  configFile: 'C:/videojuke/config.json',
  defaultConfigFile: 'C:/videojuke/config.default.json',
  cacheDirectory: 'C:/videojuke/cache',
  tempDirectory: 'C:/videojuke/temp',
  archiveDirectory: ARCHIVE,
  videoIndexFile: 'C:/videojuke/cache/video-index.json',
  queueStateFile: 'C:/videojuke/cache/queue-state.json',
  historyFile: 'C:/videojuke/cache/persisted-history.json',
  archiveFlagsFile: FLAGS_FILE,
};

const makeStore = (present = new Set<string>()) => {
  const disk = fakeFileSystem(present);
  const store = createArchiveFlagsStore({
    fileSystem: disk.system,
    paths,
    clock: createFixedClock(Date.UTC(2026, 0, 2, 3, 4, 5)),
    logger: silentLogger,
    videoPaths: guard,
  });
  return { store, disk };
};

describe('archive flag list', () => {
  it('flags a video and reports that it is now flagged', async () => {
    const { store, disk } = makeStore();
    assert.equal(await store.toggle(indexed('a.mp4')), true);

    assert.equal(store.list().length, 1);
    assert.equal(store.isFlagged(`${LIBRARY}/a.mp4`), true);
    const file = disk.written.get(FLAGS_FILE) as { flagged: readonly ArchiveFlag[] };
    assert.equal(file.flagged.length, 1, 'the flag must reach disk immediately');
    assert.equal(file.flagged[0]?.filename, 'a.mp4');
  });

  it('unflags the same video on a second press', async () => {
    const { store, disk } = makeStore();
    await store.toggle(indexed('a.mp4'));
    assert.equal(await store.toggle(indexed('a.mp4')), false);

    assert.deepEqual(store.list(), []);
    assert.equal(store.isFlagged(`${LIBRARY}/a.mp4`), false);
    const file = disk.written.get(FLAGS_FILE) as { flagged: readonly ArchiveFlag[] };
    assert.deepEqual(file.flagged, []);
  });

  it('keeps several videos apart', async () => {
    const { store } = makeStore();
    await store.toggle(indexed('a.mp4'));
    await store.toggle(indexed('b.mp4'));
    await store.toggle(indexed('c.mp4'));
    await store.toggle(indexed('b.mp4'));

    assert.deepEqual(
      store.list().map((entry) => entry.filename),
      ['a.mp4', 'c.mp4'],
    );
  });

  it('survives the key being held down', async () => {
    // Every toggle writes through, so the writes must queue rather than race.
    const { store, disk } = makeStore();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.toggle(indexed(`v${i}.mp4`))),
    );

    assert.equal(store.list().length, 20);
    const file = disk.written.get(FLAGS_FILE) as { flagged: readonly ArchiveFlag[] };
    assert.equal(file.flagged.length, 20, 'the last write must hold every flag');
  });

  it('reloads what it wrote', async () => {
    const present = new Set<string>();
    const { store, disk } = makeStore(present);
    await store.toggle(indexed('a.mp4'));

    const second = createArchiveFlagsStore({
      fileSystem: disk.system,
      paths,
      clock: createFixedClock(0),
      logger: silentLogger,
      videoPaths: guard,
    });
    await second.load();
    assert.equal(second.isFlagged(`${LIBRARY}/a.mp4`), true);
  });
});

describe('archive flag decoding', () => {
  it('rejects a path outside every configured library', () => {
    // The file is meant to be edited by hand, and `npm run archive` moves what
    // it names, so a path pointing anywhere else is not acted on.
    const decoded = decodeArchiveFlags(
      [
        { originalPath: `${LIBRARY}/keep.mp4`, filename: 'keep.mp4' },
        { originalPath: 'C:/Users/ann/Documents/taxes.pdf', filename: 'taxes.pdf' },
        { originalPath: `${LIBRARY}/../escape.mp4`, filename: 'escape.mp4' },
      ],
      guard,
    );

    assert.deepEqual(
      decoded.map((entry) => entry.filename),
      ['keep.mp4'],
    );
  });

  it('shrugs off entries that are not flags at all', () => {
    assert.deepEqual(decodeArchiveFlags([null, 'nope', {}, 42], guard), []);
    assert.deepEqual(decodeArchiveFlags(undefined, guard), []);
    assert.deepEqual(decodeArchiveFlags({ flagged: [] }, guard), []);
  });

  it('fills in a filename the hand-edited file left out', () => {
    const decoded = decodeArchiveFlags([{ originalPath: `${LIBRARY}/sub/clip.mp4` }], guard);
    assert.equal(decoded[0]?.filename, 'clip.mp4');
  });
});

describe('moving flagged videos', () => {
  it('moves each one into the archive and keeps nothing on the list', async () => {
    const present = new Set([`${LIBRARY}/a.mp4`, `${LIBRARY}/b.mp4`]);
    const disk = fakeFileSystem(present);

    const { outcomes, remaining } = await moveFlaggedVideos([flag('a.mp4'), flag('b.mp4')], {
      fileSystem: disk.system,
      archiveDirectory: ARCHIVE,
      logger: silentLogger,
    });

    assert.deepEqual(countOutcomes(outcomes), { moved: 2, missing: 0, failed: 0 });
    assert.deepEqual(remaining, []);
    assert.deepEqual(disk.moves, [
      { from: `${LIBRARY}/a.mp4`, to: `${ARCHIVE}/a.mp4` },
      { from: `${LIBRARY}/b.mp4`, to: `${ARCHIVE}/b.mp4` },
    ]);
    assert.deepEqual(disk.directories, [ARCHIVE], 'the archive is created on demand');
  });

  it('never overwrites a file already in the archive', async () => {
    // Two libraries can hold a `trailer.mp4` each.
    const present = new Set([`${LIBRARY}/trailer.mp4`, `${ARCHIVE}/trailer.mp4`]);
    const disk = fakeFileSystem(present);

    await moveFlaggedVideos([flag('trailer.mp4')], {
      fileSystem: disk.system,
      archiveDirectory: ARCHIVE,
      logger: silentLogger,
    });

    assert.deepEqual(disk.moves, [
      { from: `${LIBRARY}/trailer.mp4`, to: `${ARCHIVE}/trailer (2).mp4` },
    ]);
    assert.ok(present.has(`${ARCHIVE}/trailer.mp4`), 'the original archive entry survives');
  });

  it('counts a vanished source as done rather than failed', async () => {
    const disk = fakeFileSystem(new Set());
    const { outcomes, remaining } = await moveFlaggedVideos([flag('gone.mp4')], {
      fileSystem: disk.system,
      archiveDirectory: ARCHIVE,
      logger: silentLogger,
    });

    assert.deepEqual(countOutcomes(outcomes), { moved: 0, missing: 1, failed: 0 });
    assert.deepEqual(remaining, [], 'a flag with nothing behind it is not carried forward');
    assert.deepEqual(disk.moves, []);
  });

  it('keeps a failed move on the list and leaves the file alone', async () => {
    const present = new Set([`${LIBRARY}/locked.mp4`, `${LIBRARY}/fine.mp4`]);
    const disk = fakeFileSystem(present, new Set([`${LIBRARY}/locked.mp4`]));

    const { outcomes, remaining } = await moveFlaggedVideos(
      [flag('locked.mp4'), flag('fine.mp4')],
      { fileSystem: disk.system, archiveDirectory: ARCHIVE, logger: silentLogger },
    );

    assert.deepEqual(countOutcomes(outcomes), { moved: 1, missing: 0, failed: 1 });
    assert.deepEqual(
      remaining.map((entry) => entry.filename),
      ['locked.mp4'],
      'the next run retries it',
    );
    assert.ok(present.has(`${LIBRARY}/locked.mp4`), 'a file that could not move is not lost');
  });

  it('does nothing at all for an empty list', async () => {
    const disk = fakeFileSystem(new Set());
    const { outcomes, remaining } = await moveFlaggedVideos([], {
      fileSystem: disk.system,
      archiveDirectory: ARCHIVE,
      logger: silentLogger,
    });

    assert.deepEqual(outcomes, []);
    assert.deepEqual(remaining, []);
    assert.deepEqual(disk.directories, [], 'no archive directory is created for nothing');
  });
});
