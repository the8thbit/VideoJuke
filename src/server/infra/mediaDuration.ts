import { promises as fs } from 'fs';

/*
 * Video lengths read straight from the file, for the length bias.
 *
 * Measuring a library used to start one full ffprobe per file: a process
 * spawn, a read of every stream, and a JSON dump of all of it, for one number.
 * MP4, MOV and M4V files - most of a typical library - state their length in a
 * small header box, which a few short reads find without starting anything.
 */

/** Top-level boxes an ISO media file may start with. Anything else is not one. */
const ISO_LEADING_BOXES = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid'];

/** Gives up on a file whose header boxes go on longer than any real one does. */
const MAX_BOXES = 64;

const HEADER_BYTES = 16;

interface Box {
  readonly type: string;
  /** Offset of the box itself. */
  readonly start: number;
  /** Offset of its payload, past the size and type. */
  readonly body: number;
  /** Offset just past it. */
  readonly end: number;
}

const readAt = async (
  handle: fs.FileHandle,
  position: number,
  length: number,
): Promise<Buffer | null> => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : bytesRead >= 8 ? buffer.subarray(0, bytesRead) : null;
};

const readBox = async (
  handle: fs.FileHandle,
  position: number,
  limit: number,
): Promise<Box | null> => {
  if (position + 8 > limit) return null;
  const header = await readAt(handle, position, Math.min(HEADER_BYTES, limit - position));
  if (header === null) return null;
  const size32 = header.readUInt32BE(0);
  const type = header.toString('latin1', 4, 8);
  let size = size32;
  let headerSize = 8;
  if (size32 === 1) {
    if (header.length < 16) return null;
    size = header.readUInt32BE(8) * 0x100000000 + header.readUInt32BE(12);
    headerSize = 16;
  } else if (size32 === 0) {
    size = limit - position;
  }
  if (size < headerSize || position + size > limit) return null;
  return { type, start: position, body: position + headerSize, end: position + size };
};

/** Seconds from an `mvhd` box, or null when it states none. */
const readMovieHeader = async (handle: fs.FileHandle, box: Box): Promise<number | null> => {
  const body = await readAt(handle, box.body, Math.min(32, box.end - box.body));
  if (body === null || body.length < 20) return null;
  const version = body.readUInt8(0);
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (body.length < 32) return null;
    timescale = body.readUInt32BE(20);
    duration = body.readUInt32BE(24) * 0x100000000 + body.readUInt32BE(28);
  } else {
    timescale = body.readUInt32BE(12);
    duration = body.readUInt32BE(16);
    // All ones means "unknown" in version 0.
    if (duration === 0xffffffff) return null;
  }
  // A fragmented file leaves the movie length at zero and spreads it over the
  // fragments; ffprobe works that out.
  if (timescale === 0 || duration === 0) return null;
  const seconds = duration / timescale;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};

/**
 * The length of an MP4, MOV, M4V or 3GP file from its movie header, in
 * seconds. Null for any other kind of file, or one whose header does not say,
 * so the caller can ask ffprobe instead.
 */
export const readIsoMediaDuration = async (path: string): Promise<number | null> => {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(path, 'r');
    const { size } = await handle.stat();

    let position = 0;
    for (let count = 0; count < MAX_BOXES; count += 1) {
      const box = await readBox(handle, position, size);
      if (box === null) return null;
      if (count === 0 && ISO_LEADING_BOXES.indexOf(box.type) === -1) return null;

      if (box.type === 'moov') {
        let inner = box.body;
        for (let child = 0; child < MAX_BOXES; child += 1) {
          const found = await readBox(handle, inner, box.end);
          if (found === null) return null;
          if (found.type === 'mvhd') return await readMovieHeader(handle, found);
          inner = found.end;
        }
        return null;
      }
      position = box.end;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
};

/** Reads the one number a `-show_entries format=duration` ffprobe prints. */
export const parseProbedDuration = (output: string): number | null => {
  const seconds = Number.parseFloat(output.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
};
