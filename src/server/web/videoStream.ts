import { createReadStream, promises as fs } from 'fs';
import { extname, resolve, sep } from 'path';

import type { Request, RequestHandler, Response } from 'express';

import type { Logger } from '../../shared/types/logging';
import { toError } from '../../shared/types/result';
import {
  VIDEO_STREAM_EXPIRES_PARAM,
  VIDEO_STREAM_FILENAME_PARAM,
  VIDEO_STREAM_SIGNATURE_PARAM,
} from '../../shared/types/protocol';
import type { StreamSigner } from './streamUrl';

export interface VideoStreamOptions {
  /** Absolute directory holding the transcodes; nothing outside it is served. */
  readonly tempDirectory: string;
  readonly logger: Logger;
  /**
   * Checks the signature the server put on this URL when it handed the video
   * out. A `<video>` element cannot send an `Authorization` header, so this is
   * how the one unauthenticated-looking route is actually authorised.
   */
  readonly signer: StreamSigner;
  readonly now: () => number;
}

/**
 * Only the containers the preprocessor can emit or carry over. Anything else
 * falls back to mp4, which is what every transcode this app produces actually
 * is; guessing from a mime database would only serve types we never write.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
};

const DEFAULT_CONTENT_TYPE = 'video/mp4';

/** `bytes=` followed by a single `start-end`, either side optionally empty. */
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

type RangeRequest =
  | { readonly kind: 'whole' }
  | { readonly kind: 'partial'; readonly range: ByteRange }
  | { readonly kind: 'unsatisfiable' };

const contentTypeFor = (filename: string): string =>
  CONTENT_TYPES[extname(filename).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;

/**
 * Rejects anything that is not a plain name inside the temp directory. The
 * legacy handler joined the query parameter straight onto the directory, so
 * `../../config.json` read whatever the process could reach. It also called
 * `decodeURIComponent` on a value Express had already decoded, which turned
 * `%252e%252e%252f` into a traversal that the raw query string did not contain.
 */
const isPlainFilename = (filename: string): boolean => {
  if (filename === '' || filename === '.' || filename === '..') return false;
  if (filename.includes('/') || filename.includes('\\')) return false;
  // A colon smuggles in a Windows drive-relative path such as `C:passwords`,
  // and a NUL truncates the name once it reaches the syscall.
  return !filename.includes(':') && !filename.includes('\0');
};

/** Second gate: the resolved path must still sit under the temp directory. */
const isInside = (root: string, candidate: string): boolean => {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
};

const readFilename = (value: unknown): string | null => {
  // Express already percent-decodes query values, and repeats appear as arrays.
  if (typeof value !== 'string') return null;
  return isPlainFilename(value) ? value : null;
};

/**
 * Parses a single-range request against a known file size.
 *
 * The legacy version ran `parseInt` over the header and did arithmetic on the
 * result, so `bytes=abc-` produced `NaN` offsets, a `NaN` content length and a
 * read stream that never delivered anything.
 */
export const parseRangeHeader = (header: string | undefined, size: number): RangeRequest => {
  if (header === undefined) return { kind: 'whole' };

  const match = RANGE_PATTERN.exec(header.trim());
  const rawStart = match?.[1];
  const rawEnd = match?.[2];
  // Not a single `bytes=` range: a unit we do not implement, a multi-range set,
  // or plain nonsense. RFC 7233 says to ignore such a header and answer with the
  // whole representation; answering 416 instead - as this did - left any client
  // that asks for two ranges at once unable to fetch the video at all.
  if (rawStart === undefined || rawEnd === undefined) return { kind: 'whole' };
  if (rawStart === '' && rawEnd === '') return { kind: 'whole' };
  // Syntax is fine from here on, so an impossible range is a real 416.
  if (size === 0) return { kind: 'unsatisfiable' };

  // `bytes=-500` asks for the last 500 bytes, not for everything up to 500.
  if (rawStart === '') {
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', range: { start: Math.max(0, size - suffixLength), end: size - 1 } };
  }

  const start = Number(rawStart);
  if (start >= size) return { kind: 'unsatisfiable' };

  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return { kind: 'unsatisfiable' };
  return { kind: 'partial', range: { start, end } };
};

const readParam = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Serves the transcoded file with byte-range support.
 *
 * This is one of the few places outside `server/infra` that touches `node:fs`
 * directly: the shared `FileSystem` deliberately exposes no streaming surface,
 * and buffering a multi-gigabyte video to hand it over as a string is not an
 * option.
 */
export const createVideoStreamHandler = ({
  tempDirectory,
  logger,
  signer,
  now,
}: VideoStreamOptions): RequestHandler => {
  const root = resolve(tempDirectory);

  const pipeFile = (
    response: Response,
    path: string,
    filename: string,
    range: ByteRange | null,
  ): void => {
    // The client can go away during the `stat` this function is called after, in
    // which case `close` has already fired and a handler registered below would
    // never run - leaving an open descriptor for a response nobody will read.
    // Seeking in a long video aborts a request on every drag, so these add up.
    if (response.destroyed || response.writableEnded) {
      logger.debug(`abandoning ${filename}: the client had already gone`);
      return;
    }

    const stream = range === null ? createReadStream(path) : createReadStream(path, range);

    stream.on('error', (thrown: unknown) => {
      logger.warn(`streaming ${filename} failed: ${toError(thrown).message}`);
      response.destroy();
    });
    // A viewer who seeks or closes the tab aborts mid-transfer; without this the
    // read stream keeps pulling from disk for a response nobody is reading.
    response.on('close', () => {
      stream.destroy();
    });

    // One last check: `createReadStream` opens asynchronously, so a close that
    // landed between the guard above and the listener above is caught here.
    if (response.destroyed) {
      stream.destroy();
      return;
    }

    stream.pipe(response);
  };

  const serve = async (request: Request, response: Response): Promise<void> => {
    const filename = readFilename(request.query[VIDEO_STREAM_FILENAME_PARAM]);
    if (filename === null) {
      logger.warn('rejected a video request with a missing or unsafe filename');
      response.status(400).json({ error: 'Missing or unsafe filename parameter' });
      return;
    }

    const verdict = signer.verify(
      {
        filename,
        expires: readParam(request.query[VIDEO_STREAM_EXPIRES_PARAM]),
        signature: readParam(request.query[VIDEO_STREAM_SIGNATURE_PARAM]),
      },
      now(),
    );
    if (verdict !== 'ok') {
      // 410 for a link that was genuinely ours and has simply aged out, so the
      // difference is visible in a log without having to reason about it.
      logger.warn(`rejected a ${verdict} stream signature for ${filename}`);
      response.status(verdict === 'expired' ? 410 : 403).json({ error: `${verdict} signature` });
      return;
    }

    const path = resolve(root, filename);
    if (!isInside(root, path)) {
      logger.warn(`rejected a video request that escapes the temp directory: ${filename}`);
      response.status(400).json({ error: 'Missing or unsafe filename parameter' });
      return;
    }

    const stats = await fs.stat(path).catch(() => null);
    if (stats === null || !stats.isFile()) {
      logger.debug(`video file not found: ${filename}`);
      response.status(404).json({ error: 'Video file not found' });
      return;
    }

    const size = stats.size;
    const parsed = parseRangeHeader(request.headers.range, size);

    if (parsed.kind === 'unsatisfiable') {
      logger.debug(`unsatisfiable range for ${filename}: ${String(request.headers.range)}`);
      response.setHeader('Content-Range', `bytes */${size}`);
      response.status(416).json({ error: 'Requested range not satisfiable' });
      return;
    }

    response.setHeader('Content-Type', contentTypeFor(filename));
    response.setHeader('Accept-Ranges', 'bytes');

    if (parsed.kind === 'whole') {
      response.setHeader('Content-Length', size);
      response.status(200);
      pipeFile(response, path, filename, null);
      return;
    }

    const { start, end } = parsed.range;
    response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    response.setHeader('Content-Length', end - start + 1);
    response.status(206);
    pipeFile(response, path, filename, parsed.range);
  };

  return (request, response) => {
    serve(request, response).catch((thrown: unknown) => {
      const error = toError(thrown);
      logger.error('failed to serve a video file', error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.status(500).json({ error: error.message });
    });
  };
};
