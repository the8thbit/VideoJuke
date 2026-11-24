/**
 * Just enough of the WebP container to turn an animation into a still.
 *
 * The bundled ffmpeg decodes still WebP, lossy and lossless alike, but has no
 * decoder for the animated kind: it reports invalid data for every frame, and
 * looped as an image input it retries for ever. An animated WebP is a RIFF file
 * whose frames each carry an ordinary still bitstream, so the first one can be
 * lifted out into a WebP file of its own, which ffmpeg then reads like any
 * other picture.
 *
 * Layout (https://developers.google.com/speed/webp/docs/riff_container):
 * `RIFF <size> WEBP`, then chunks of `<fourcc> <size, little-endian> <data>`
 * padded to an even length. An animation starts with a `VP8X` chunk whose flags
 * byte has the animation bit set, and holds its frames in `ANMF` chunks: 16
 * bytes of placement and timing, then the frame's own `ALPH`, `VP8 ` or `VP8L`
 * chunks.
 */

const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const ANIMATION_FLAG = 0x02;
const ALPHA_FLAG = 0x10;
const ANMF_HEADER_BYTES = 16;

const fourcc = (bytes: Uint8Array, at: number): string =>
  String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);

const readUint24 = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);

const readUint32 = (bytes: Uint8Array, at: number): number =>
  (readUint24(bytes, at) + (bytes[at + 3] ?? 0) * 0x1000000) >>> 0;

const writeUint24 = (target: Uint8Array, at: number, value: number): void => {
  target[at] = value & 0xff;
  target[at + 1] = (value >>> 8) & 0xff;
  target[at + 2] = (value >>> 16) & 0xff;
};

const writeUint32 = (target: Uint8Array, at: number, value: number): void => {
  writeUint24(target, at, value);
  target[at + 3] = (value >>> 24) & 0xff;
};

const writeFourcc = (target: Uint8Array, at: number, code: string): void => {
  for (let index = 0; index < 4; index += 1) target[at + index] = code.charCodeAt(index);
};

interface Chunk {
  readonly id: string;
  /** The whole chunk, header and padding included, ready to copy. */
  readonly raw: Uint8Array;
  readonly data: Uint8Array;
}

/** The chunks laid end to end in `bytes`, stopping at the first one that overruns. */
const readChunks = (bytes: Uint8Array): Chunk[] => {
  const chunks: Chunk[] = [];
  let at = 0;
  while (at + CHUNK_HEADER_BYTES <= bytes.length) {
    const size = readUint32(bytes, at + 4);
    const end = at + CHUNK_HEADER_BYTES + size;
    if (end > bytes.length) break;
    const padded = Math.min(bytes.length, end + (size % 2));
    chunks.push({
      id: fourcc(bytes, at),
      raw: bytes.subarray(at, padded),
      data: bytes.subarray(at + CHUNK_HEADER_BYTES, end),
    });
    at = padded;
  }
  return chunks;
};

const isWebp = (bytes: Uint8Array): boolean =>
  bytes.length >= HEADER_BYTES && fourcc(bytes, 0) === 'RIFF' && fourcc(bytes, 8) === 'WEBP';

/** Whether `bytes` is a WebP file that holds an animation rather than one picture. */
export const isAnimatedWebp = (bytes: Uint8Array): boolean => {
  if (!isWebp(bytes)) return false;
  const first = readChunks(bytes.subarray(HEADER_BYTES))[0];
  return first !== undefined && first.id === 'VP8X' && ((first.data[0] ?? 0) & ANIMATION_FLAG) !== 0;
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  let length = 0;
  for (const part of parts) length += part.length;
  const result = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
};

/**
 * A still WebP file holding the first frame of an animated one, or null when
 * `bytes` is not an animated WebP or its first frame cannot be found.
 *
 * A lossy frame with a separate alpha channel needs a `VP8X` header announcing
 * the alpha and the frame's size; a lossless frame carries its own alpha and
 * stands on its own.
 */
export const firstWebpFrame = (bytes: Uint8Array): Uint8Array | null => {
  if (!isAnimatedWebp(bytes)) return null;

  const frame = readChunks(bytes.subarray(HEADER_BYTES)).find((chunk) => chunk.id === 'ANMF');
  if (frame === undefined || frame.data.length <= ANMF_HEADER_BYTES) return null;

  const width = readUint24(frame.data, 6) + 1;
  const height = readUint24(frame.data, 9) + 1;
  const inner = readChunks(frame.data.subarray(ANMF_HEADER_BYTES));
  const picture = inner.find((chunk) => chunk.id === 'VP8 ' || chunk.id === 'VP8L');
  if (picture === undefined) return null;
  const alpha = picture.id === 'VP8 ' ? inner.find((chunk) => chunk.id === 'ALPH') : undefined;

  const body: Uint8Array[] = [];
  if (alpha !== undefined) {
    const header = new Uint8Array(CHUNK_HEADER_BYTES + 10);
    writeFourcc(header, 0, 'VP8X');
    writeUint32(header, 4, 10);
    header[8] = ALPHA_FLAG;
    writeUint24(header, 12, width - 1);
    writeUint24(header, 15, height - 1);
    body.push(header, alpha.raw);
  }
  body.push(picture.raw);

  const content = concat(body);
  const riff = new Uint8Array(HEADER_BYTES);
  writeFourcc(riff, 0, 'RIFF');
  writeUint32(riff, 4, content.length + 4);
  writeFourcc(riff, 8, 'WEBP');
  return concat([riff, content]);
};
