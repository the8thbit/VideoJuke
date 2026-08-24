import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/shared/config/normalize';
import type { AppConfig } from '../src/shared/types/config';
import { decodePreprocessedVideo } from '../src/server/domain/videoRecords';
import { decodeIndexSnapshot } from '../src/server/domain/videoIndex';
import {
  createVideoPathGuard,
  isTranscodeFileName,
  transcodeFileName,
  withUncheckedProcessed,
} from '../src/server/domain/videoPaths';

const TEMP = 'C:/Users/ann/videojuke/temp';

const configWith = (overrides: Record<string, unknown> = {}): AppConfig =>
  normalizeConfig({ directories: ['X:/videos'], ...overrides }).config;

const guardFor = (config: AppConfig = configWith()) =>
  createVideoPathGuard({ tempDirectory: TEMP, config: () => config });

describe('createVideoPathGuard', () => {
  it('accepts the paths this application actually produces', () => {
    const guard = guardFor();
    assert.equal(guard.acceptsProcessed(`${TEMP}/processed_abc.mp4`), true);
    assert.equal(guard.acceptsSource('X:/videos/holiday/clip.mp4'), true);
  });

  it('treats separators and case the way Windows does', () => {
    // A directory typed as `X:/videos` in config.json comes back from the scan
    // spelled `X:\Videos`; both name the same place and both have to pass.
    const guard = guardFor();
    assert.equal(guard.acceptsSource('X:\\Videos\\clip.mp4'), true);
    assert.equal(guard.acceptsProcessed(TEMP.replace(/\//g, '\\') + '\\processed_a.mp4'), true);
    assert.equal(guard.acceptsProcessed(`${TEMP}//processed_a.mp4`), true);
  });

  it('refuses anything outside the directories it was given', () => {
    const guard = guardFor();
    assert.equal(guard.acceptsProcessed('C:/Users/ann/Documents/taxes.pdf'), false);
    assert.equal(guard.acceptsSource('C:/Users/ann/Documents/taxes.pdf'), false);
    // A sibling whose name merely starts the same way is not inside it.
    assert.equal(guard.acceptsProcessed('C:/Users/ann/videojuke/temporary/x.mp4'), false);
    // Nor is the directory itself a file within it.
    assert.equal(guard.acceptsProcessed(TEMP), false);
  });

  it('refuses traversal, unresolved paths, empties and embedded NUL', () => {
    const guard = guardFor();
    assert.equal(guard.acceptsProcessed(`${TEMP}/../../Documents/taxes.pdf`), false);
    assert.equal(guard.acceptsProcessed(`${TEMP}/./processed_a.mp4`), false);
    assert.equal(guard.acceptsProcessed(''), false);
    // A NUL truncates at the syscall, so the checked string and the opened one
    // would not be the same string.
    assert.equal(guard.acceptsProcessed(`${TEMP}/processed_a.mp4\u0000.txt`), false);
  });

  it('follows the configured libraries as they change', () => {
    let config = configWith();
    const guard = createVideoPathGuard({ tempDirectory: TEMP, config: () => config });
    assert.equal(guard.acceptsSource('Y:/more/clip.mp4'), false);

    config = configWith({ directories: ['X:/videos', 'Y:/more'] });
    assert.equal(guard.acceptsSource('Y:/more/clip.mp4'), true);
  });

  it('counts seasonal directories as source directories', () => {
    const guard = guardFor(
      configWith({
        seasonalDirectories: [{ directory: 'Z:/christmas', likelihood: 1, conditions: {} }],
      }),
    );
    assert.equal(guard.acceptsSource('Z:/christmas/santa.mp4'), true);
  });
});

describe('decodePreprocessedVideo path gating', () => {
  const record = (overrides: Record<string, unknown> = {}) => ({
    originalPath: 'X:/videos/clip.mp4',
    filename: 'clip.mp4',
    processedPath: `${TEMP}/processed_abc.mp4`,
    ...overrides,
  });

  it('keeps a record whose paths are both where they should be', () => {
    assert.notEqual(decodePreprocessedVideo(record(), guardFor()), null);
  });

  it('rejects the record a client would use to have a file deleted', () => {
    // The whole attack: name any file as the transcode of a source that does
    // not exist, and `retainPlayable` unlinks it on the next start.
    const poisoned = record({
      originalPath: 'Z:/does-not-exist',
      processedPath: 'C:/Users/ann/Documents/taxes.pdf',
    });
    assert.equal(decodePreprocessedVideo(poisoned, guardFor()), null);
  });

  it('rejects a source path outside every configured library', () => {
    // Otherwise `ensurePlayable` feeds it to ffmpeg and streams back the result.
    const stolen = record({ originalPath: 'C:/Users/ann/private/diary.mp4' });
    assert.equal(decodePreprocessedVideo(stolen, guardFor()), null);
  });

  it('still reads history written under a different temp directory', () => {
    // The temp directory moves whenever the app is started from elsewhere, and
    // a history entry is a record of what was watched, not of a live file.
    const moved = record({ processedPath: 'D:/old-temp/processed_abc.mp4' });
    const lenient = withUncheckedProcessed(guardFor());
    assert.equal(decodePreprocessedVideo(moved, guardFor()), null);
    assert.notEqual(decodePreprocessedVideo(moved, lenient), null);
    // Lenient about the transcode, never about the source.
    assert.equal(
      decodePreprocessedVideo(record({ originalPath: 'C:/elsewhere/x.mp4' }), lenient),
      null,
    );
  });
});

describe('transcode file names', () => {
  it('recognises exactly the names the preprocessor writes', () => {
    assert.equal(isTranscodeFileName(transcodeFileName('abc123')), true);
    assert.equal(isTranscodeFileName('processed_abc.MP4'), true);
  });

  it('leaves anything else in the temp directory alone', () => {
    // `system.tempDirectory` is a path the user chooses; the sweep must not
    // delete files it never wrote.
    assert.equal(isTranscodeFileName('holiday.mp4'), false);
    assert.equal(isTranscodeFileName('processed_.mp4'), false);
    assert.equal(isTranscodeFileName('processed_abc.txt'), false);
    assert.equal(isTranscodeFileName('.mp4'), false);
    assert.equal(isTranscodeFileName(''), false);
  });
});

describe('configured roots that are not already resolved', () => {
  /**
   * `path.join` collapses `.` and `..` out of every path the scan produces, so a
   * root that still carries them can never match one. The README documents the
   * `./` form for seasonal directories, which made this the default way to get a
   * guard that rejects the entire library.
   */
  it('accepts a library configured with a leading ./', () => {
    const guard = guardFor(configWith({ directories: ['./videos'] }));
    // Exactly what `join('./videos', 'a.mp4')` yields on Windows.
    assert.equal(guard.acceptsSource('videos\\a.mp4'), true);
    assert.equal(guard.acceptsSource('videos/nested/a.mp4'), true);
  });

  it('accepts a seasonal directory configured with a leading ./', () => {
    const guard = guardFor(
      configWith({
        directories: ['X:/videos'],
        seasonalDirectories: [
          { directory: './seasonal/xmas', likelihood: 0.1, conditions: { month: [12] } },
        ],
      }),
    );
    assert.equal(guard.acceptsSource('seasonal/xmas/jingle.mp4'), true);
  });

  it('reads a root containing .. the way the filesystem would', () => {
    const guard = guardFor(configWith({ directories: ['X:/media/../videos'] }));
    assert.equal(guard.acceptsSource('X:/videos/a.mp4'), true);
    assert.equal(guard.acceptsSource('X:/media/a.mp4'), false);
  });

  it('still refuses a candidate that has not been resolved', () => {
    // Collapsing applies to the configured root only. A path arriving from a
    // request is checked, not interpreted, which is the whole point of the gate.
    const guard = guardFor(configWith({ directories: ['X:/videos'] }));
    assert.equal(guard.acceptsSource('X:/videos/../../windows/system32/config/sam'), false);
    assert.equal(guard.acceptsSource('X:/videos/./a.mp4'), false);
  });

  it('does not let a collapsed root reach outside itself', () => {
    const guard = guardFor(configWith({ directories: ['./videos'] }));
    assert.equal(guard.acceptsSource('videos-other/a.mp4'), false);
    assert.equal(guard.acceptsSource('a.mp4'), false);
  });
});

describe('the video index cache is untrusted input too', () => {
  const snapshotWith = (originalPath: string) => ({
    fingerprint: 'anything',
    builtAt: '2026-01-01T00:00:00.000Z',
    regular: [
      {
        originalPath,
        filename: 'a.mp4',
        directory: 'X:/videos',
        addedAt: '2026-01-01T00:00:00.000Z',
        seasonalDirectory: null,
      },
    ],
    seasonal: {},
  });

  it('keeps a record naming a file inside a configured directory', () => {
    const decoded = decodeIndexSnapshot(snapshotWith('X:/videos/a.mp4'), guardFor());
    assert.equal(decoded?.regular.length, 1);
  });

  /**
   * The cache is a file an earlier run wrote, and `originalPath` out of it is
   * handed to ffmpeg and then streamed. Every other cache reader checks it; this
   * one used not to, which made it the only route by which a record naming
   * something outside the library reached the selection pool. The fingerprint is
   * not that check - it is a hash of the configuration, so anything able to
   * write the cache can write a matching one.
   */
  it('drops a record naming a file outside every configured directory', () => {
    const decoded = decodeIndexSnapshot(
      snapshotWith('C:/Users/ann/Documents/taxes.pdf'),
      guardFor(),
    );
    assert.deepEqual(decoded?.regular, []);
  });

  it('drops a seasonal record the same way', () => {
    const poisoned = {
      ...snapshotWith('X:/videos/a.mp4'),
      seasonal: {
        'Z:/christmas': [
          {
            originalPath: 'C:/Windows/System32/config/SAM',
            filename: 'SAM',
            directory: 'C:/Windows/System32/config',
            addedAt: '2026-01-01T00:00:00.000Z',
            seasonalDirectory: 'Z:/christmas',
          },
        ],
      },
    };
    const decoded = decodeIndexSnapshot(poisoned, guardFor());
    assert.deepEqual(decoded?.seasonal['Z:/christmas'], []);
  });
});
