import { promises as fs } from 'fs';
import { join } from 'path';

import { attemptAsync, err, ok, type Result } from '../../shared/types/result';

export interface FileStats {
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
}

/**
 * The outcome of walking a directory tree.
 *
 * `unreadable` exists because a partial scan and a complete one must not look
 * alike to the caller. A permission-denied subdirectory, or a network share that
 * blinked, used to abort the whole walk and report an empty root; the index then
 * saved that emptiness as the truth and the session deleted every transcode to
 * match it. Now the readable part still comes back, and the caller can see that
 * it is not the whole story.
 */
export interface DirectoryListing {
  readonly files: readonly string[];
  readonly unreadable: readonly string[];
}

/**
 * The server's entire filesystem surface. Domain modules depend on this
 * interface rather than on `fs`, which is what makes them testable without a
 * disk and keeps every I/O failure visible as a `Result` instead of a throw.
 */
export interface FileSystem {
  readonly exists: (path: string) => Promise<boolean>;
  readonly ensureDirectory: (path: string) => Promise<Result<void>>;
  readonly readText: (path: string) => Promise<Result<string>>;
  readonly writeText: (path: string, contents: string) => Promise<Result<void>>;
  readonly readJson: (path: string) => Promise<Result<unknown>>;
  readonly writeJson: (path: string, value: unknown) => Promise<Result<void>>;
  readonly remove: (path: string) => Promise<Result<boolean>>;
  /** Moves a file, across volumes if it has to. */
  readonly moveFile: (from: string, to: string) => Promise<Result<void>>;
  readonly stat: (path: string) => Promise<Result<FileStats>>;
  readonly listFiles: (directory: string) => Promise<Result<readonly string[]>>;
  readonly listFilesRecursively: (directory: string) => Promise<Result<DirectoryListing>>;
  /** Writes via a temp file and a rename, so a crash cannot truncate the target. */
  readonly writeJsonAtomically: (path: string, value: unknown) => Promise<Result<void>>;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * A file that vanished or is momentarily locked by another process is an
 * expected outcome of racing with ffmpeg and the OS, not an error worth
 * surfacing, so deletion reports whether it removed anything.
 */
const isIgnorableRemovalError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'EBUSY' || code === 'EPERM';
};

export const nodeFileSystem: FileSystem = {
  exists,

  ensureDirectory: async (path) => {
    const result = await attemptAsync(async () => {
      await fs.mkdir(path, { recursive: true });
    });
    return result;
  },

  readText: (path) => attemptAsync(() => fs.readFile(path, 'utf8')),

  writeText: (path, contents) =>
    attemptAsync(async () => {
      await fs.writeFile(path, contents, 'utf8');
    }),

  readJson: async (path) => {
    const text = await attemptAsync(() => fs.readFile(path, 'utf8'));
    if (!text.ok) return text;
    try {
      return ok(JSON.parse(text.value) as unknown);
    } catch (thrown) {
      return err(new Error(`${path} is not valid JSON: ${(thrown as Error).message}`));
    }
  },

  writeJson: (path, value) =>
    attemptAsync(async () => {
      await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    }),

  /**
   * The queue, the history and the index are each one file rewritten in full on
   * every save. `writeFile` truncates before it writes, so a process killed
   * mid-save - which is precisely when the shutdown save runs - left a
   * half-written file that the next start could only discard. Writing beside the
   * target and renaming over it makes the replacement atomic.
   */
  writeJsonAtomically: async (path, value) => {
    const temporary = `${path}.tmp`;
    const written = await attemptAsync(async () => {
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await fs.rename(temporary, path);
    });
    if (written.ok) return written;

    // A failed rename leaves the scratch file behind; nothing reads it, but it
    // would otherwise accumulate one copy per failure.
    await fs.unlink(temporary).catch(() => undefined);
    return written;
  },

  /**
   * `rename` is atomic and instant, but only within one volume: an archive
   * directory on a different drive - which is much of the point of having one -
   * fails with EXDEV. Copying and then unlinking is the fallback, in that order,
   * so a failure midway leaves the original where it was rather than losing it.
   */
  moveFile: async (from, to) =>
    attemptAsync(async () => {
      try {
        await fs.rename(from, to);
        return;
      } catch (thrown) {
        if ((thrown as NodeJS.ErrnoException).code !== 'EXDEV') throw thrown;
      }
      await fs.copyFile(from, to);
      await fs.unlink(from);
    }),

  remove: async (path) => {
    try {
      await fs.unlink(path);
      return ok(true);
    } catch (thrown) {
      return isIgnorableRemovalError(thrown) ? ok(false) : err(thrown as Error);
    }
  },

  stat: async (path) => {
    const stats = await attemptAsync(() => fs.stat(path));
    if (!stats.ok) return stats;
    return ok({ sizeBytes: stats.value.size, modifiedAtMs: stats.value.mtimeMs });
  },

  listFiles: async (directory) => {
    const entries = await attemptAsync(() => fs.readdir(directory, { withFileTypes: true }));
    if (!entries.ok) return entries;
    return ok(
      entries.value.filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name)),
    );
  },

  /**
   * Walks the tree a directory at a time rather than with `readdir`'s recursive
   * option.
   *
   * The built-in walk throws on the first directory it cannot read, which turns
   * one unreadable subfolder anywhere under a library into an empty library. It
   * also reports each entry's parent through `Dirent.parentPath`, which only
   * exists from Node 20.12; on anything older every nested file came back joined
   * to the root instead, so the index was full of paths that do not exist.
   * Tracking the parent here answers both.
   */
  listFilesRecursively: async (directory) => {
    const files: string[] = [];
    const unreadable: string[] = [];
    const pending: string[] = [directory];

    while (pending.length > 0) {
      // `pop` rather than `shift`: the order of a set of files is irrelevant
      // here and a library can hold tens of thousands of directories.
      const current = pending.pop() as string;
      const entries = await attemptAsync(() => fs.readdir(current, { withFileTypes: true }));
      if (!entries.ok) {
        // The root itself failing is a real error; a subdirectory failing is a
        // gap the caller is told about and can still act on.
        if (current === directory) return err(entries.error);
        unreadable.push(current);
        continue;
      }

      for (const entry of entries.value) {
        const path = join(current, entry.name);
        // Symbolic links are neither followed nor indexed: following them can
        // loop forever, and a link's target is either already in the tree or
        // outside the library the user configured.
        if (entry.isFile()) files.push(path);
        else if (entry.isDirectory()) pending.push(path);
      }
    }

    return ok({ files, unreadable });
  },
};
