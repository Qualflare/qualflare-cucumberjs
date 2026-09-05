import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveImageMimeType, writeImageAttachment } from '../../src/formatter/video-writer.js';

let dir: string;
let out: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-cuke-image-'));
  out = path.join(dir, 'results');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_B64 = PNG.toString('base64');

describe('resolveImageMimeType', () => {
  it("prefers the file's extension, which cannot disagree with itself", () => {
    // The upload endpoint cross-checks extension against MIME, so a caller's
    // claim losing to the real file is what keeps a screenshot off a 400.
    expect(resolveImageMimeType('image/gif', '/tmp/a.png')).toEqual({ mimeType: 'image/png', extension: '.png' });
  });

  it('falls back to the declared type when there is no file, the World.attach() case', () => {
    expect(resolveImageMimeType('image/png', undefined)).toEqual({ mimeType: 'image/png', extension: '.png' });
    expect(resolveImageMimeType('image/jpeg', undefined)).toEqual({ mimeType: 'image/jpeg', extension: '.jpg' });
  });

  it('declines anything the upload endpoint does not accept', () => {
    expect(resolveImageMimeType('image/bmp', undefined)).toBeUndefined();
    expect(resolveImageMimeType('text/plain', undefined)).toBeUndefined();
    expect(resolveImageMimeType(undefined, '/tmp/a.svg')).toBeUndefined();
    expect(resolveImageMimeType(undefined, undefined)).toBeUndefined();
  });
});

describe('writeImageAttachment', () => {
  it('writes in-memory content out — the common shape in cucumber-js', () => {
    // Screenshots usually arrive through World.attach() from a browser driver,
    // with no file to copy. Refusing this shape would leave most screenshots
    // inline and defeat the change.
    const r = writeImageAttachment({ name: 'shot', mimeType: 'image/png', content: PNG_B64 }, out, 1_000_000)!;
    expect(r.localImagePath).toMatch(/\.png$/);
    expect(path.isAbsolute(r.localImagePath)).toBe(false);
    expect(fs.readFileSync(path.join(out, r.localImagePath)).equals(PNG)).toBe(true);
    expect(r.fileSize).toBe(PNG.length);
  });

  it('copies a real file when one is named', () => {
    const src = path.join(dir, 'shot.png');
    fs.writeFileSync(src, PNG);
    const r = writeImageAttachment({ name: 'shot', mimeType: 'image/png', path: src }, out, 1_000_000)!;
    expect(fs.readFileSync(path.join(out, r.localImagePath)).equals(PNG)).toBe(true);
  });

  it('declines a non-image, leaving it to the inline path', () => {
    expect(writeImageAttachment({ name: 'log', mimeType: 'text/plain', content: PNG_B64 }, out, 1_000_000)).toBeUndefined();
    expect(writeImageAttachment({ name: 'x', mimeType: 'image/bmp', content: PNG_B64 }, out, 1_000_000)).toBeUndefined();
  });

  it('respects the cap for both shapes', () => {
    const big = Buffer.alloc(4096).toString('base64');
    expect(writeImageAttachment({ name: 'big', mimeType: 'image/png', content: big }, out, 1024)).toBeUndefined();
    const src = path.join(dir, 'big.png');
    fs.writeFileSync(src, Buffer.alloc(4096));
    expect(writeImageAttachment({ name: 'big', mimeType: 'image/png', path: src }, out, 1024)).toBeUndefined();
    // Stat happens BEFORE the copy, so nothing is written just to be rejected.
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toHaveLength(0);
  });

  it('returns undefined rather than throwing when outputDir is missing', () => {
    // A formatter must never throw over an attachment. Without the guard this
    // is a TypeError out of path.join.
    expect(() =>
      writeImageAttachment({ name: 'shot', mimeType: 'image/png', content: PNG_B64 }, undefined as never, 1_000_000),
    ).not.toThrow();
  });

  it('returns undefined when there is neither content nor a path', () => {
    expect(writeImageAttachment({ name: 'shot', mimeType: 'image/png' }, out, 1_000_000)).toBeUndefined();
  });

  it('gives each screenshot its own filename', () => {
    const a = writeImageAttachment({ name: 'a', mimeType: 'image/png', content: PNG_B64 }, out, 1_000_000)!;
    const b = writeImageAttachment({ name: 'b', mimeType: 'image/png', content: PNG_B64 }, out, 1_000_000)!;
    expect(a.localImagePath).not.toBe(b.localImagePath);
    expect(fs.readdirSync(out)).toHaveLength(2);
  });
});
