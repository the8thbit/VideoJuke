import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseProbedDuration, readIsoMediaDuration } from '../src/server/infra/mediaDuration';

const directory = mkdtempSync(join(tmpdir(), 'vj-duration-'));
after(() => rmSync(directory, { recursive: true, force: true }));

const box = (type: string, ...payload: Buffer[]): Buffer => {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
};

const mvhd0 = (timescale: number, duration: number): Buffer => {
  const body = Buffer.alloc(100);
  body.writeUInt32BE(timescale, 12);
  body.writeUInt32BE(duration, 16);
  return box('mvhd', body);
};

const mvhd1 = (timescale: number, duration: number): Buffer => {
  const body = Buffer.alloc(112);
  body.writeUInt8(1, 0);
  body.writeUInt32BE(timescale, 20);
  body.writeUInt32BE(Math.floor(duration / 0x100000000), 24);
  body.writeUInt32BE(duration % 0x100000000, 28);
  return box('mvhd', body);
};

let counter = 0;
const file = (...parts: Buffer[]): string => {
  counter += 1;
  const path = join(directory, `clip${counter}.mp4`);
  writeFileSync(path, Buffer.concat(parts));
  return path;
};

const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2mp41', 'latin1'));

describe('reading a length from an MP4 header', () => {
  it('reads a version 0 movie header with the moov at the front', async () => {
    const path = file(ftyp, box('moov', mvhd0(1000, 93500), box('trak')), box('mdat', Buffer.alloc(64)));
    assert.equal(await readIsoMediaDuration(path), 93.5);
  });

  it('finds a moov written after the media data', async () => {
    const path = file(ftyp, box('free'), box('mdat', Buffer.alloc(4096)), box('moov', box('udta'), mvhd0(600, 1800)));
    assert.equal(await readIsoMediaDuration(path), 3);
  });

  it('reads a version 1 movie header with a 64-bit length', async () => {
    const path = file(ftyp, box('moov', mvhd1(90000, 90000 * 7200)));
    assert.equal(await readIsoMediaDuration(path), 7200);
  });

  it('leaves a fragmented file, whose movie length is zero, to ffprobe', async () => {
    const path = file(ftyp, box('moov', mvhd0(1000, 0)), box('moof'));
    assert.equal(await readIsoMediaDuration(path), null);
  });

  it('leaves files of other kinds to ffprobe', async () => {
    const mkv = file(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88]), Buffer.alloc(64));
    assert.equal(await readIsoMediaDuration(mkv), null);
    assert.equal(await readIsoMediaDuration(file(Buffer.from('GIF89a'))), null);
  });

  it('gives up on a truncated or corrupt header instead of looping', async () => {
    const broken = Buffer.alloc(16);
    broken.writeUInt32BE(4, 0);
    broken.write('ftyp', 4, 'latin1');
    assert.equal(await readIsoMediaDuration(file(broken)), null);
    const cut = file(ftyp, box('moov', mvhd0(1000, 5000)).subarray(0, 20));
    assert.equal(await readIsoMediaDuration(cut), null);
  });

  it('answers null for a file that is not there', async () => {
    assert.equal(await readIsoMediaDuration(join(directory, 'missing.mp4')), null);
  });
});

describe('reading the length ffprobe prints', () => {
  it('takes the number and refuses what is not one', () => {
    assert.equal(parseProbedDuration('12.480000\r\n'), 12.48);
    assert.equal(parseProbedDuration('N/A\n'), null);
    assert.equal(parseProbedDuration(''), null);
    assert.equal(parseProbedDuration('0.000000'), null);
  });
});
