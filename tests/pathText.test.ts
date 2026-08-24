import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { directoryOf, fileNameOf, joinPath } from '../src/server/domain/pathText';

/**
 * The domain layer splits paths as text, so the separator is whatever the path
 * happens to carry. A configured directory written with `/` on Windows and a
 * listing that comes back with `\` meet inside the same string, which is why
 * the mixed cases below are the realistic ones rather than the exotic ones.
 */
describe('fileNameOf', () => {
  it('takes the last segment after either separator', () => {
    assert.equal(fileNameOf('X:/videos/holiday/a.mp4'), 'a.mp4');
    assert.equal(fileNameOf('X:\\videos\\holiday\\a.mp4'), 'a.mp4');
  });

  it('uses whichever separator comes last when a path mixes them', () => {
    assert.equal(fileNameOf('X:/videos\\holiday\\a.mp4'), 'a.mp4');
    assert.equal(fileNameOf('X:\\videos/holiday/a.mp4'), 'a.mp4');
  });

  it('returns a bare filename unchanged', () => {
    assert.equal(fileNameOf('a.mp4'), 'a.mp4');
  });

  it('names a file sitting directly under a root', () => {
    assert.equal(fileNameOf('/a.mp4'), 'a.mp4');
    assert.equal(fileNameOf('\\a.mp4'), 'a.mp4');
  });

  it('finds no name after a trailing separator', () => {
    // Directory listings never produce one, so this only has to stay harmless.
    assert.equal(fileNameOf('X:/videos/'), '');
    assert.equal(fileNameOf('X:\\videos\\'), '');
  });
});

describe('directoryOf', () => {
  it('drops the last segment for either separator', () => {
    assert.equal(directoryOf('X:/videos/holiday/a.mp4'), 'X:/videos/holiday');
    assert.equal(directoryOf('X:\\videos\\holiday\\a.mp4'), 'X:\\videos\\holiday');
  });

  it('keeps a mixed path exactly as it was spelled', () => {
    assert.equal(directoryOf('X:/videos\\holiday\\a.mp4'), 'X:/videos\\holiday');
    assert.equal(directoryOf('X:\\videos/holiday/a.mp4'), 'X:\\videos/holiday');
  });

  it('reports the current directory for a bare filename', () => {
    assert.equal(directoryOf('a.mp4'), '.');
  });

  it('keeps the separator for a file directly under a root', () => {
    // `/` rather than the empty string, so the result still names a directory.
    assert.equal(directoryOf('/a.mp4'), '/');
    assert.equal(directoryOf('\\a.mp4'), '\\');
  });

  it('treats a trailing separator as the end of the last segment', () => {
    assert.equal(directoryOf('X:/videos/'), 'X:/videos');
    assert.equal(directoryOf('X:\\videos\\'), 'X:\\videos');
  });
});

describe('joinPath', () => {
  it('inserts the separator the directory already uses', () => {
    assert.equal(joinPath('/var/tmp', 'a.mp4'), '/var/tmp/a.mp4');
    assert.equal(joinPath('C:\\temp', 'a.mp4'), 'C:\\temp\\a.mp4');
  });

  it('prefers the backslash once a directory contains one', () => {
    // Windows accepts both, and a path that already holds a backslash is on a
    // host where the native separator is the safer one to add.
    assert.equal(joinPath('C:\\Users\\me/temp', 'a.mp4'), 'C:\\Users\\me/temp\\a.mp4');
  });

  it('does not double a separator the directory already ends with', () => {
    assert.equal(joinPath('/var/tmp/', 'a.mp4'), '/var/tmp/a.mp4');
    assert.equal(joinPath('C:\\temp\\', 'a.mp4'), 'C:\\temp\\a.mp4');
  });

  it('falls back to a forward slash for a name with no separator at all', () => {
    assert.equal(joinPath('temp', 'a.mp4'), 'temp/a.mp4');
  });

  it('appends to a root without repeating it', () => {
    assert.equal(joinPath('/', 'a.mp4'), '/a.mp4');
  });
});
