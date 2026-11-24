/**
 * Whether a GIF holds an animation, read from its block structure.
 *
 * An animated GIF plays through once at its own pace instead of being held for
 * `images.displayDuration`, so the preprocessor has to know which kind it has.
 * ffprobe cannot say cheaply: it reports a duration for a single-frame GIF too,
 * and counting frames means decoding the whole file. The container answers it
 * in a few hundred bytes of reading - each frame is an image descriptor block,
 * so two of them make an animation.
 *
 * Layout (GIF89a): a 6-byte signature, a 7-byte logical screen descriptor whose
 * packed byte may announce a global colour table, then blocks until the 0x3B
 * trailer. An extension is 0x21, a label, and data sub-blocks; an image is
 * 0x2C, 9 bytes of descriptor, an optional local colour table, the LZW code
 * size, and data sub-blocks. Sub-blocks are length-prefixed and end with a
 * zero length.
 */

const SIGNATURE_BYTES = 6;
const SCREEN_DESCRIPTOR_BYTES = 7;
const IMAGE_DESCRIPTOR_BYTES = 9;
const EXTENSION = 0x21;
const IMAGE = 0x2c;
const TRAILER = 0x3b;
const COLOUR_TABLE_FLAG = 0x80;

const isGif = (bytes: Uint8Array): boolean =>
  bytes.length >= SIGNATURE_BYTES + SCREEN_DESCRIPTOR_BYTES &&
  bytes[0] === 0x47 && // G
  bytes[1] === 0x49 && // I
  bytes[2] === 0x46; // F

/** Bytes taken by a colour table announced in a packed field, or 0 for none. */
const colourTableBytes = (packed: number): number =>
  (packed & COLOUR_TABLE_FLAG) === 0 ? 0 : 3 * 2 ** ((packed & 0x07) + 1);

/** The position just past a run of sub-blocks, or -1 if they run off the end. */
const skipSubBlocks = (bytes: Uint8Array, start: number): number => {
  let at = start;
  while (at < bytes.length) {
    const length = bytes[at] ?? 0;
    at += 1;
    if (length === 0) return at;
    at += length;
  }
  return -1;
};

/** The number of frames in a GIF, counting no further than `limit`. */
export const countGifFrames = (bytes: Uint8Array, limit = Number.POSITIVE_INFINITY): number => {
  if (!isGif(bytes)) return 0;

  let at = SIGNATURE_BYTES + SCREEN_DESCRIPTOR_BYTES + colourTableBytes(bytes[10] ?? 0);
  let frames = 0;
  while (at < bytes.length && frames < limit) {
    const block = bytes[at];
    if (block === TRAILER) break;
    if (block === EXTENSION) {
      at = skipSubBlocks(bytes, at + 2);
    } else if (block === IMAGE) {
      frames += 1;
      const packed = bytes[at + IMAGE_DESCRIPTOR_BYTES] ?? 0;
      // Past the descriptor, its local colour table and the LZW code size.
      at = skipSubBlocks(bytes, at + 1 + IMAGE_DESCRIPTOR_BYTES + colourTableBytes(packed) + 1);
    } else {
      break;
    }
    if (at < 0) break;
  }
  return frames;
};

/** Whether `bytes` is a GIF with more than one frame. */
export const isAnimatedGif = (bytes: Uint8Array): boolean => countGifFrames(bytes, 2) >= 2;
