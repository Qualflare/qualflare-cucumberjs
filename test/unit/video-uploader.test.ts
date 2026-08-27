import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeVideoAttachment } from '../../src/formatter/video-uploader.js';

describe('writeVideoAttachment', () => {
  let tmpDir: string;
  let outputDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-video-src-'));
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-video-out-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('copies a real file into outputDir and returns localVideoPath', () => {
    const src = path.join(tmpDir, 'a.mp4');
    fs.writeFileSync(src, 'file-video-bytes');

    const result = writeVideoAttachment({ name: 'v', path: src }, outputDir, 1_000_000);

    expect(result).toBeDefined();
    expect(result!.mimeType).toBe('video/mp4');
    expect(result!.fileSize).toBe('file-video-bytes'.length);
    expect(fs.readFileSync(path.join(outputDir, result!.localVideoPath), 'utf8')).toBe('file-video-bytes');
  });

  it('writes in-memory base64 content into outputDir and returns localVideoPath', () => {
    const content = Buffer.from('memory-video-bytes').toString('base64');

    const result = writeVideoAttachment({ name: 'v', content, mimeType: 'video/mp4' }, outputDir, 1_000_000);

    expect(result).toBeDefined();
    expect(fs.readFileSync(path.join(outputDir, result!.localVideoPath), 'utf8')).toBe('memory-video-bytes');
  });

  it('skips oversized in-memory content without writing anything', () => {
    const content = Buffer.from('this-is-way-too-big').toString('base64');

    const result = writeVideoAttachment({ name: 'v', content, mimeType: 'video/mp4' }, outputDir, 3);

    expect(result).toBeUndefined();
    expect(fs.readdirSync(outputDir)).toHaveLength(0);
  });

  it('skips an oversized real file without copying anything', () => {
    const src = path.join(tmpDir, 'big.mp4');
    fs.writeFileSync(src, 'far-too-many-bytes');

    const result = writeVideoAttachment({ name: 'v', path: src }, outputDir, 3);

    expect(result).toBeUndefined();
    expect(fs.readdirSync(outputDir)).toHaveLength(0);
  });

  it('skips an unreadable source file rather than throwing', () => {
    const result = writeVideoAttachment({ name: 'v', path: path.join(tmpDir, 'nope.mp4') }, outputDir, 1_000_000);
    expect(result).toBeUndefined();
  });

  it('skips an unresolvable mime/extension pair', () => {
    const result = writeVideoAttachment({ name: 'v', content: 'eA==' }, outputDir, 1_000_000);
    expect(result).toBeUndefined();
  });

  it('gives each written video a unique filename so shards never collide', () => {
    const content = Buffer.from('x').toString('base64');
    const a = writeVideoAttachment({ name: 'v', content, mimeType: 'video/mp4' }, outputDir, 1_000_000);
    const b = writeVideoAttachment({ name: 'v', content, mimeType: 'video/mp4' }, outputDir, 1_000_000);

    expect(a!.localVideoPath).not.toBe(b!.localVideoPath);
    expect(fs.readdirSync(outputDir)).toHaveLength(2);
  });
});
