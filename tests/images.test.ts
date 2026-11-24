import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyConfigChange } from '../src/shared/config/changeImpact';
import { normalizeConfig } from '../src/shared/config/normalize';
import type { AppConfig } from '../src/shared/types/config';
import { asIsoTimestamp } from '../src/shared/types/brand';
import { err, ok, type Result } from '../src/shared/types/result';
import { extensionOf, indexedExtensions, isImagePath } from '../src/shared/video/mediaKind';
import { countGifFrames, isAnimatedGif } from '../src/shared/video/gif';
import { firstWebpFrame, isAnimatedWebp } from '../src/shared/video/webp';
import { createVideoIndex } from '../src/server/domain/videoIndex';
import { createVideoPathGuard } from '../src/server/domain/videoPaths';
import type { DirectoryListing, FileSystem } from '../src/server/infra/fileSystem';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

const configOf = (raw: Record<string, unknown>): AppConfig => normalizeConfig(raw).config;

describe('image settings', () => {
  it('ships images on at 2.5 seconds, WebP and GIF included, and scanning not recursive', () => {
    const { config } = normalizeConfig({ directories: ['/videos'] });
    assert.equal(config.images.enabled, true);
    assert.equal(config.images.displayDuration, 2500);
    assert.ok(config.images.extensions.includes('.webp'));
    assert.ok(config.images.extensions.includes('.gif'));
    assert.equal(config.files.recursive, false);
  });

  it('refuses a display time too short to see', () => {
    const { config, issues } = normalizeConfig({
      directories: ['/videos'],
      images: { displayDuration: 10 },
    });
    assert.equal(config.images.displayDuration, 500);
    assert.equal(issues.length, 1);
  });

  it('normalises image extensions like video ones', () => {
    const { config } = normalizeConfig({ directories: ['/videos'], images: { extensions: ['PNG', '.Jpg'] } });
    assert.deepEqual(config.images.extensions, ['.png', '.jpg']);
  });

  it('re-indexes for what gets scanned, and only requeues for how long images show', () => {
    const base = configOf({ directories: ['/videos'] });
    assert.equal(classifyConfigChange(base, configOf({ directories: ['/videos'], images: { enabled: false } })), 'reindex');
    assert.equal(classifyConfigChange(base, configOf({ directories: ['/videos'], files: { recursive: true } })), 'reindex');
    assert.equal(
      classifyConfigChange(base, configOf({ directories: ['/videos'], images: { extensions: ['.png'] } })),
      'reindex',
    );
    assert.equal(
      classifyConfigChange(base, configOf({ directories: ['/videos'], images: { displayDuration: 4000 } })),
      'requeue',
    );
  });
});

describe('telling images from videos', () => {
  const config = configOf({ directories: ['/videos'] });

  it('reads the extension of the last segment only', () => {
    assert.equal(extensionOf('C:\\pics.d\\Photo.JPG'), '.jpg');
    assert.equal(extensionOf('/a.b/readme'), null);
    assert.equal(extensionOf('/a/.keep'), null);
  });

  it('knows a picture by its extension, in any case', () => {
    assert.equal(isImagePath('/videos/a.webp', config), true);
    assert.equal(isImagePath('/videos/a.PNG', config), true);
    assert.equal(isImagePath('/videos/a.mp4', config), false);
  });

  it('lets a video extension win when one is listed as both', () => {
    const both = configOf({ directories: ['/videos'], images: { extensions: ['.mp4', '.png'] } });
    assert.equal(isImagePath('/videos/a.mp4', both), false);
  });

  it('indexes no pictures, and calls nothing one, when images are off', () => {
    const off = configOf({ directories: ['/videos'], images: { enabled: false } });
    assert.equal(isImagePath('/videos/a.png', off), false);
    assert.deepEqual(indexedExtensions(off), off.files.supportedVideoExtensions);
    assert.ok(indexedExtensions(config).includes('.webp'));
  });
});

/** A chunk of `<fourcc> <size> <data>`, padded to an even length. */
const chunk = (id: string, data: readonly number[]): number[] => {
  const size = data.length;
  const bytes = [...id].map((character) => character.charCodeAt(0));
  bytes.push(size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff, ...data);
  if (size % 2 === 1) bytes.push(0);
  return bytes;
};

const riff = (body: readonly number[]): Uint8Array => {
  const size = body.length + 4;
  return Uint8Array.from([
    ...'RIFF'.split('').map((character) => character.charCodeAt(0)),
    size & 0xff,
    (size >> 8) & 0xff,
    (size >> 16) & 0xff,
    (size >> 24) & 0xff,
    ...'WEBP'.split('').map((character) => character.charCodeAt(0)),
    ...body,
  ]);
};

/** 16 bytes of frame placement and timing: offset 0,0, the given size, 100ms. */
const anmfHeader = (width: number, height: number): number[] => [
  0, 0, 0, 0, 0, 0,
  (width - 1) & 0xff, ((width - 1) >> 8) & 0xff, 0,
  (height - 1) & 0xff, ((height - 1) >> 8) & 0xff, 0,
  100, 0, 0, 0,
];

const VP8X_ANIMATED = chunk('VP8X', [0x12, 0, 0, 0, 63, 1, 0, 239, 0, 0]);
const ANIM = chunk('ANIM', [0, 0, 0, 0, 0, 0]);

describe('animated WebP', () => {
  it('tells an animation from a still', () => {
    assert.equal(isAnimatedWebp(riff([...VP8X_ANIMATED, ...ANIM])), true);
    assert.equal(isAnimatedWebp(riff(chunk('VP8 ', [1, 2, 3]))), false);
    assert.equal(isAnimatedWebp(Uint8Array.from([1, 2, 3])), false);
  });

  it('lifts a lossless first frame out as a plain still', () => {
    const picture = chunk('VP8L', [0x2f, 1, 2, 3, 4]);
    const animated = riff([
      ...VP8X_ANIMATED,
      ...ANIM,
      ...chunk('ANMF', [...anmfHeader(320, 240), ...picture]),
      ...chunk('ANMF', [...anmfHeader(320, 240), ...chunk('VP8L', [9, 9])]),
    ]);
    assert.deepEqual(firstWebpFrame(animated), riff(picture));
  });

  it('gives a lossy frame with alpha the header that announces it', () => {
    const alpha = chunk('ALPH', [0, 7, 7]);
    const picture = chunk('VP8 ', [5, 6]);
    const still = firstWebpFrame(
      riff([...VP8X_ANIMATED, ...ANIM, ...chunk('ANMF', [...anmfHeader(320, 240), ...alpha, ...picture])]),
    );
    const header = chunk('VP8X', [0x10, 0, 0, 0, 63, 1, 0, 239, 0, 0]);
    assert.deepEqual(still, riff([...header, ...alpha, ...picture]));
  });

  it('leaves a still, or a file it cannot follow, alone', () => {
    assert.equal(firstWebpFrame(riff(chunk('VP8 ', [1, 2]))), null);
    assert.equal(firstWebpFrame(riff([...VP8X_ANIMATED, ...ANIM])), null);
  });
});

/**
 * A minimal GIF89a: header, a screen descriptor with an optional global colour
 * table, then one graphic control extension and one image per frame.
 */
const gif = (frames: number, { globalTable = false, localTable = false } = {}): Uint8Array => {
  const bytes = [...'GIF89a'].map((character) => character.charCodeAt(0));
  // 2x2 canvas; packed byte announces a 2-entry global table when asked.
  bytes.push(2, 0, 2, 0, globalTable ? 0x80 : 0, 0, 0);
  if (globalTable) bytes.push(0, 0, 0, 255, 255, 255);
  for (let frame = 0; frame < frames; frame += 1) {
    bytes.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0);
    bytes.push(0x2c, 0, 0, 0, 0, 2, 0, 2, 0, localTable ? 0x80 : 0);
    if (localTable) bytes.push(0, 0, 0, 255, 255, 255);
    bytes.push(2, 3, 0x44, 0x01, 0x05, 0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
};

describe('animated GIF', () => {
  it('counts frames past extensions and colour tables', () => {
    assert.equal(countGifFrames(gif(1)), 1);
    assert.equal(countGifFrames(gif(5, { globalTable: true })), 5);
    assert.equal(countGifFrames(gif(3, { localTable: true })), 3);
  });

  it('calls two frames an animation and one a still', () => {
    assert.equal(isAnimatedGif(gif(2)), true);
    assert.equal(isAnimatedGif(gif(1, { globalTable: true })), false);
  });

  it('is not fooled by a file that is not a GIF, or one cut short', () => {
    assert.equal(isAnimatedGif(Uint8Array.from([1, 2, 3])), false);
    const cut = gif(2);
    assert.equal(countGifFrames(cut.subarray(0, 30)), 1);
  });
});

describe('scanning a directory', () => {
  const ROOT = 'C:/media';
  const files: Readonly<Record<string, readonly string[]>> = {
    [ROOT]: [`${ROOT}/clip.mp4`, `${ROOT}/photo.jpg`, `${ROOT}/notes.txt`],
    [`${ROOT}/nested`]: [`${ROOT}/nested/deep.mp4`, `${ROOT}/nested/deep.webp`],
  };

  const fileSystem = {
    exists: async () => true,
    listFiles: async (directory: string): Promise<Result<readonly string[]>> =>
      files[directory] === undefined ? err(new Error('missing')) : ok(files[directory] ?? []),
    listFilesRecursively: async (directory: string): Promise<Result<DirectoryListing>> =>
      ok({
        files: Object.keys(files)
          .filter((key) => key === directory || key.startsWith(`${directory}/`))
          .flatMap((key) => files[key] ?? []),
        unreadable: [],
      }),
    ensureDirectory: async () => ok(undefined),
    writeJsonAtomically: async () => ok(undefined),
  } as unknown as FileSystem;

  const scan = async (raw: Record<string, unknown>) => {
    const config = configOf({ directories: [ROOT], ...raw });
    const measured: string[] = [];
    const index = createVideoIndex({
      fileSystem,
      measureDuration: async (path) => {
        measured.push(path);
        return 60;
      },
      paths: {
        workingDirectory: 'C:/app',
        installDirectory: 'C:/app',
        configFile: 'C:/app/config.json',
        defaultConfigFile: 'C:/app/config.default.json',
        cacheDirectory: 'C:/app/cache',
        tempDirectory: 'C:/app/temp',
        archiveDirectory: 'C:/app/archive',
        videoIndexFile: 'C:/app/cache/video-index.json',
        queueStateFile: 'C:/app/cache/queue-state.json',
        historyFile: 'C:/app/cache/persisted-history.json',
        archiveFlagsFile: 'C:/app/flagged_for_archive.json',
      },
      clock: {
        now: () => 0,
        nowIso: () => asIsoTimestamp('2026-01-01T00:00:00.000Z'),
        localFacts: () => ({ epochMs: 0, dayOfWeek: 4, hour: 0, minute: 0, dayOfMonth: 1, month: 1, year: 2026 }),
      },
      logger: silentLogger,
      random: () => 0,
      digest: (input) => input,
      config: () => config,
      videoPaths: createVideoPathGuard({ tempDirectory: 'C:/app/temp', config: () => config }),
    });
    const { snapshot } = await index.rebuild();
    return { snapshot, measured, paths: snapshot.regular.map((entry) => entry.originalPath).sort() };
  };

  it('indexes only the top level by default, pictures included', async () => {
    const { paths } = await scan({});
    assert.deepEqual(paths, [`${ROOT}/clip.mp4`, `${ROOT}/photo.jpg`]);
  });

  it('descends into subfolders when asked', async () => {
    const { paths } = await scan({ files: { recursive: true } });
    assert.deepEqual(paths, [
      `${ROOT}/clip.mp4`,
      `${ROOT}/nested/deep.mp4`,
      `${ROOT}/nested/deep.webp`,
      `${ROOT}/photo.jpg`,
    ]);
  });

  it('leaves pictures out when images are off', async () => {
    const { paths } = await scan({ files: { recursive: true }, images: { enabled: false } });
    assert.deepEqual(paths, [`${ROOT}/clip.mp4`, `${ROOT}/nested/deep.mp4`]);
  });

  it('never measures a picture, so it weighs in the middle of the length bias', async () => {
    const { snapshot, measured } = await scan({ selection: { lengthBias: { enabled: true } } });
    assert.deepEqual(measured, [`${ROOT}/clip.mp4`]);
    assert.equal(snapshot.durations[`${ROOT}/photo.jpg`], null);
    assert.equal(snapshot.durations[`${ROOT}/clip.mp4`], 60);
  });
});
