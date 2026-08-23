import { describe, expect, it } from 'vitest';

import { AttachmentBudget, resolvePendingAttachment } from '../../src/formatter/attachment-budget.js';

const CONFIG = { attachScreenshots: true, maxAttachmentBytes: 1000, maxTotalAttachmentBytes: 2000 };

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

  it('refuses a video mimeType outright', () => {
    const budget = new AttachmentBudget(CONFIG.maxTotalAttachmentBytes);
    const result = resolvePendingAttachment({ name: 'clip', mimeType: 'video/mp4', content: 'abc' }, CONFIG, budget);
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
