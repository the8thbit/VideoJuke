import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRangeHeader } from '../src/server/web/videoStream';

const SIZE = 1000;

describe('parseRangeHeader', () => {
  it('serves the whole file when no range is asked for', () => {
    assert.deepEqual(parseRangeHeader(undefined, SIZE), { kind: 'whole' });
  });

  it('reads an explicit range, clamping the end to the last byte', () => {
    assert.deepEqual(parseRangeHeader('bytes=0-499', SIZE), {
      kind: 'partial',
      range: { start: 0, end: 499 },
    });
    assert.deepEqual(parseRangeHeader('bytes=500-', SIZE), {
      kind: 'partial',
      range: { start: 500, end: 999 },
    });
    assert.deepEqual(parseRangeHeader('bytes=0-99999', SIZE), {
      kind: 'partial',
      range: { start: 0, end: 999 },
    });
  });

  it('reads a suffix range as the last N bytes', () => {
    assert.deepEqual(parseRangeHeader('bytes=-500', SIZE), {
      kind: 'partial',
      range: { start: 500, end: 999 },
    });
    // Asking for more than there is yields the whole file, not a negative start.
    assert.deepEqual(parseRangeHeader('bytes=-99999', SIZE), {
      kind: 'partial',
      range: { start: 0, end: 999 },
    });
  });

  it('answers 416 only for a range that is well formed and impossible', () => {
    assert.deepEqual(parseRangeHeader('bytes=1000-', SIZE), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('bytes=500-400', SIZE), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('bytes=-0', SIZE), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRangeHeader('bytes=0-0', 0), { kind: 'unsatisfiable' });
  });

  it('ignores a header it cannot parse rather than refusing the video', () => {
    // RFC 7233 says an unsatisfiable *syntax* is to be ignored, not rejected.
    // Answering 416 meant a client that asks for two ranges at once - or names a
    // unit we do not implement - could never fetch the file at all.
    for (const header of [
      'bytes=abc-',
      'bytes=0-99,200-299',
      'items=0-99',
      'bytes=-',
      'nonsense',
      '',
    ]) {
      assert.deepEqual(parseRangeHeader(header, SIZE), { kind: 'whole' }, header);
    }
  });

  it('tolerates surrounding whitespace', () => {
    assert.deepEqual(parseRangeHeader('  bytes=0-9  ', SIZE), {
      kind: 'partial',
      range: { start: 0, end: 9 },
    });
  });
});
