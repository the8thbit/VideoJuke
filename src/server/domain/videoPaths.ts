import type { AppConfig } from '../../shared/types/config';

/**
 * Decides whether a path a client handed us is one this server is willing to
 * act on.
 *
 * Video records arrive from three places that are not the scan: an HTTP body, an
 * IPC payload, and a cache file that an earlier version - or an earlier attack -
 * may already have written. Every one of them carries `originalPath` and
 * `processedPath` as plain strings, and the server goes on to `unlink` the
 * second one and to feed the first to ffmpeg. Without this gate a single
 * `POST /api/sync-playback-queue` naming `C:\Users\me\taxes.pdf` is persisted to
 * `queue-state.json` and deleted by `retainPlayable` on the next start.
 *
 * So the rule is the same one `videoStream` applies to the filename it serves:
 * a transcode must live inside the temp directory, and a source must live inside
 * a directory the user actually configured. Anything else is not a video this
 * application knows about, whoever says otherwise.
 */
export interface VideoPathGuard {
  /** True when the path names a file inside a configured source directory. */
  readonly acceptsSource: (path: string) => boolean;
  /** True when the path names a file inside the temp directory. */
  readonly acceptsProcessed: (path: string) => boolean;
}

export interface VideoPathGuardDeps {
  /** Absolute, as `resolveAppPaths` produced it. */
  readonly tempDirectory: string;
  /** Read per call, so a reconfigured library takes effect without rewiring. */
  readonly config: () => AppConfig;
}

/**
 * Both separators are treated alike and case is ignored, because a directory
 * typed into config.json may be spelled `X:/Videos` while the scan reports
 * `X:\videos`. Comparing case-insensitively can only ever *accept* a path a
 * case-sensitive filesystem would spell differently, and such a path fails the
 * `exists` check that follows anyway; rejecting a legitimate Windows path would
 * be the worse mistake.
 */
const toComparable = (path: string): string => {
  const slashes = path.replace(/\\/g, '/');
  // A leading `//` is a UNC root and has to survive; every other run collapses.
  const unc = slashes.slice(0, 2) === '//' ? '//' : '';
  return `${unc}${slashes.slice(unc.length).replace(/\/{2,}/g, '/')}`.toLowerCase();
};

/**
 * Rejects anything that is not already resolved. `..` is the traversal itself,
 * and a bare `.` means the caller sent a path the filesystem would still have to
 * interpret - which is exactly the interpretation this gate is trying to avoid
 * having to reason about.
 */
const isResolved = (comparable: string): boolean =>
  comparable.split('/').every((segment) => segment !== '..' && segment !== '.');

/**
 * The same collapsing `path.join` performs, applied to a configured root.
 *
 * A candidate has to arrive already resolved - that is `isResolved`, and it is a
 * security rule. A root is different: it is text a person typed into config.json,
 * and `"./seasonal/xmas"` is the very form the README documents. The scan joins
 * that root onto each file name and `join` strips the `./` on the way, so every
 * scanned path came back as `seasonal\xmas\a.mp4` while the prefix built here
 * still carried the `./` and could never match. Nothing failed loudly: the saved
 * queue and the history were dropped on every restart, every archive flag for
 * those videos was discarded, and the library was re-transcoded from scratch
 * each start.
 *
 * `..` is collapsed rather than rejected, because that is what the filesystem
 * does with it - so the comparison describes the directory that will actually be
 * read. A leading `..` with nothing to collapse into is kept, and simply fails to
 * match the paths a scan produces.
 */
const collapseDotSegments = (comparable: string): string => {
  if (comparable.indexOf('.') === -1) return comparable;

  const kept: string[] = [];
  for (const segment of comparable.split('/')) {
    if (segment === '.') continue;
    // Never past the first segment: that one carries the root - a drive letter,
    // the empty string of a leading `/`, or the `` of a `//` UNC prefix.
    if (segment === '..' && kept.length > 1 && kept[kept.length - 1] !== '..') {
      kept.pop();
      continue;
    }
    kept.push(segment);
  }
  return kept.join('/');
};

const isInside = (root: string, comparable: string): boolean => {
  if (root === '') return false;
  const base = collapseDotSegments(toComparable(root));
  // A root that collapses away entirely is no longer a root.
  if (base === '') return false;
  const prefix = base.slice(-1) === '/' ? base : `${base}/`;
  // Strictly longer: the directory itself is not a file inside it.
  return comparable.length > prefix.length && comparable.slice(0, prefix.length) === prefix;
};

/**
 * Whether `path` names something underneath `root`, comparing the way the rest
 * of this module does. Exported because the index needs the same question
 * answered about its own scan results, not just about client input.
 */
export const isPathInside = (root: string, path: string): boolean =>
  isInside(root, toComparable(path));

export const createVideoPathGuard = (deps: VideoPathGuardDeps): VideoPathGuard => {
  const sourceRoots = (): readonly string[] => {
    const current = deps.config();
    return [
      ...current.directories,
      ...current.seasonalDirectories.map((entry) => entry.directory),
    ];
  };

  const accepts = (roots: readonly string[], path: string): boolean => {
    // A NUL truncates the name once it reaches the syscall, so the string that
    // was checked and the string that is opened would not be the same one.
    if (path === '' || path.indexOf('\0') !== -1) return false;
    const comparable = toComparable(path);
    if (!isResolved(comparable)) return false;
    return roots.some((root) => isInside(root, comparable));
  };

  return {
    acceptsSource: (path) => accepts(sourceRoots(), path),
    acceptsProcessed: (path) => accepts([deps.tempDirectory], path),
  };
};

/**
 * The same guard, but indifferent to where the transcode lives.
 *
 * Playback history is a record of what was watched, keyed by the source file;
 * the transcode beside it is incidental and can always be rebuilt. The temp
 * directory, meanwhile, moves more easily than it looks - it defaults to
 * `./temp` under the *working* directory, so merely starting the app from
 * somewhere else relocates it. Applying the strict rule to history would answer
 * that by silently discarding every one of up to `persistedHistorySize` entries.
 *
 * Safe only because the two places that delete a transcode check the path
 * themselves before unlinking it.
 */
export const withUncheckedProcessed = (guard: VideoPathGuard): VideoPathGuard => ({
  acceptsSource: guard.acceptsSource,
  acceptsProcessed: () => true,
});

/**
 * Accepts every path. For the decoders' own tests and for call sites reading
 * records this process produced itself in the same run; never for anything that
 * crossed a transport or came off disk.
 */
export const UNCHECKED_VIDEO_PATHS: VideoPathGuard = {
  acceptsSource: () => true,
  acceptsProcessed: () => true,
};

/**
 * How a transcode is named, in one place, because two things depend on agreeing
 * about it: the preprocessor that writes the file and the sweep that deletes it.
 *
 * `system.tempDirectory` is a path the user chooses. Pointed at a directory that
 * already holds something - a Downloads folder, a scratch drive - the sweep used
 * to delete every unreferenced file in it that was over an hour old, whether or
 * not this application had ever heard of it. Matching the name we write means
 * the sweep can only ever remove its own litter.
 */
const TRANSCODE_PREFIX = 'processed_';
const TRANSCODE_SUFFIX = '.mp4';

export const transcodeFileName = (id: string): string =>
  `${TRANSCODE_PREFIX}${id}${TRANSCODE_SUFFIX}`;

export const isTranscodeFileName = (name: string): boolean =>
  name.length > TRANSCODE_PREFIX.length + TRANSCODE_SUFFIX.length &&
  name.slice(0, TRANSCODE_PREFIX.length) === TRANSCODE_PREFIX &&
  name.slice(-TRANSCODE_SUFFIX.length).toLowerCase() === TRANSCODE_SUFFIX;
