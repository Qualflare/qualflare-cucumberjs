import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AttachmentBudget,
  isVideoLike,
  resolvePendingAttachment,
  resolveVideoAttachment,
} from '../../src/formatter/attachment-budget.js';

const ENDPOINT = 'https://qualflare.test';

const CONFIG = {
  attachScreenshots: true,
  maxAttachmentBytes: 1000,
  maxTotalAttachmentBytes: 2000,
  maxVideoBytes: 50_000_000,
  outputDir: '',
};

let outputDir: string;


let mockAgent: MockAgent;

beforeEach(() => {
  // Video attachments are now pure filesystem work — no HTTP at all. The
  // MockAgent stays only so any OTHER accidental network call in this file
  // fails loudly and immediately rather than hanging.
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-ab-out-'));
  CONFIG.outputDir = outputDir;
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  fs.rmSync(outputDir, { recursive: true, force: true });
  await mockAgent.close();
  vi.restoreAllMocks();
});

describe('AttachmentBudget', () => {
  it('reserves bytes and reports the running total', () => {
    const budget = new AttachmentBudget(100);
    expect(budget.tryReserve(40)).toBe(true);
    expect(budget.usedBytes).toBe(40);
    expect(budget.tryReserve(40)).toBe(true);
    expect(budget.usedBytes).toBe(80);
  });

  it('refuses (and reserves nothing) once the total would be exceeded', () => {
    const budget = new AttachmentBudget(100);
    budget.tryReserve(90);
    expect(budget.tryReserve(20)).toBe(false);
    expect(budget.usedBytes).toBe(90); // unchanged — the failed reservation reserved nothing
  });
});

describe('isVideoLike', () => {
  it('detects a video mimeType', () => {
    expect(isVideoLike('video/mp4', undefined)).toBe(true);
    expect(isVideoLike('VIDEO/WEBM', undefined)).toBe(true);
  });

  it('detects a video file extension even with no/incorrect mimeType', () => {
    expect(isVideoLike(undefined, '/tmp/clip.mp4')).toBe(true);
    expect(isVideoLike('image/png', '/tmp/clip.mov')).toBe(true);
  });

  it('is false for a plain image/text attachment', () => {
    expect(isVideoLike('image/png', '/tmp/shot.png')).toBe(false);
    expect(isVideoLike(undefined, undefined)).toBe(false);
  });
});

describe('resolvePendingAttachment', () => {
  it('returns undefined entirely when attachScreenshots is disabled', () => {
    const budget = new AttachmentBudget(CONFIG.maxTotalAttachmentBytes);
    const result = resolvePendingAttachment(
      { name: 'a', content: Buffer.from('x').toString('base64') },
      { ...CONFIG, attachScreenshots: false },
      budget,
    );
    expect(result).toBeUndefined();
  });

  it('resolves in-memory content, reserving its decoded byte size against the budget', () => {
    const budget = new AttachmentBudget(CONFIG.maxTotalAttachmentBytes);
    const content = Buffer.from('hello world').toString('base64');
    const result = resolvePendingAttachment({ name: 'note', mimeType: 'text/plain', content, stepIndex: 2 }, CONFIG, budget);
    expect(result).toEqual({ name: 'note', mimeType: 'text/plain', content, stepIndex: 2 });
    expect(budget.usedBytes).toBe(Buffer.byteLength(content, 'base64'));
  });

  it('skips in-memory content exceeding the per-attachment cap, without reserving anything', () => {
    const budget = new AttachmentBudget(CONFIG.maxTotalAttachmentBytes);
    const bigContent = Buffer.alloc(CONFIG.maxAttachmentBytes + 1).toString('base64');
    const result = resolvePendingAttachment({ name: 'big', content: bigContent }, CONFIG, budget);
    expect(result).toBeUndefined();
    expect(budget.usedBytes).toBe(0);
  });

  it('skips once the cumulative run budget would be exceeded, keeping earlier ones', () => {
    const budget = new AttachmentBudget(150);
    const small = Buffer.alloc(100).toString('base64');
    const first = resolvePendingAttachment({ name: 'a', content: small }, { ...CONFIG, maxTotalAttachmentBytes: 150 }, budget);
    expect(first).toBeDefined();
    const second = resolvePendingAttachment({ name: 'b', content: small }, { ...CONFIG, maxTotalAttachmentBytes: 150 }, budget);
    expect(second).toBeUndefined();
  });

  it('skips a nonexistent file path gracefully rather than throwing', () => {
    const budget = new AttachmentBudget(CONFIG.maxTotalAttachmentBytes);
    expect(() =>
      resolvePendingAttachment({ name: 'missing', path: '/does/not/exist.png' }, CONFIG, budget),
    ).not.toThrow();
    expect(resolvePendingAttachment({ name: 'missing', path: '/does/not/exist.png' }, CONFIG, budget)).toBeUndefined();
  });

  it('returns undefined when neither content nor path is provided', () => {
    const budget = new AttachmentBudget(CONFIG.maxTotalAttachmentBytes);
    expect(resolvePendingAttachment({ name: 'nothing' }, CONFIG, budget)).toBeUndefined();
  });
});

describe('resolveVideoAttachment', () => {
  it('returns undefined entirely when attachScreenshots is disabled', async () => {
    const result = await resolveVideoAttachment(
      { name: 'clip', mimeType: 'video/mp4', content: 'abc' },
      { ...CONFIG, attachScreenshots: false },
    );
    expect(result).toBeUndefined();
  });

  it('skips an unsupported video mimeType (no path to fall back on)', async () => {
    const result = await resolveVideoAttachment({ name: 'clip', mimeType: 'video/x-flv', content: 'abc' }, CONFIG);
    expect(result).toBeUndefined();
  });

  it('skips in-memory content exceeding maxVideoBytes, writing nothing', async () => {
    const content = Buffer.alloc(101).toString('base64');
    const result = await resolveVideoAttachment(
      { name: 'clip', mimeType: 'video/mp4', content },
      { ...CONFIG, maxVideoBytes: 100 },
    );
    expect(result).toBeUndefined();
    expect(fs.readdirSync(outputDir)).toHaveLength(0);
  });

  it('routes a file-based video attachment through writeVideoAttachment and sets localVideoPath', async () => {
    const src = path.join(outputDir, 'source-clip.mp4');
    fs.writeFileSync(src, 'video-bytes');

    const resolved = await resolveVideoAttachment({ name: 'clip', path: src, mimeType: 'video/mp4' }, CONFIG);

    expect(resolved?.localVideoPath).toBeDefined();
    expect(resolved?.storageKey).toBeUndefined();
    expect(resolved?.content).toBeUndefined();
    expect(fs.readFileSync(path.join(outputDir, resolved!.localVideoPath!), 'utf8')).toBe('video-bytes');
  });

  it('routes an in-memory video attachment through writeVideoAttachment', async () => {
    const original = Buffer.from('memory-bytes');
    const content = original.toString('base64');

    const resolved = await resolveVideoAttachment(
      { name: 'clip', content, mimeType: 'video/mp4', stepIndex: 3 },
      CONFIG,
    );

    expect(resolved?.localVideoPath).toBeDefined();
    expect(resolved?.storageKey).toBeUndefined();
    expect(resolved?.fileSize).toBe(original.length);
    expect(resolved?.stepIndex).toBe(3);
    expect(fs.readFileSync(path.join(outputDir, resolved!.localVideoPath!), 'utf8')).toBe('memory-bytes');
  });

  it('makes zero network calls — the MockAgent has no interceptors and net is disabled', async () => {
    const content = Buffer.from('fake video bytes').toString('base64');
    // Would throw/reject if anything attempted a request.
    const resolved = await resolveVideoAttachment({ name: 'clip', mimeType: 'video/mp4', content }, CONFIG);
    expect(resolved?.localVideoPath).toBeDefined();
  });
});
