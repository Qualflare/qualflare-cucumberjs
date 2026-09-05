import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { AttachmentBudget } from '../../src/formatter/attachment-budget.js';
import { RunHookTracker } from '../../src/formatter/run-hook-tracker.js';
import type { HookIndex } from '../../src/formatter/hook-index.js';

// A REAL outputDir: screenshots are written there now, so omitting it (which
// the `as never` cast used to allow) would exercise a shape production cannot
// have.
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-hook-att-'));
const config = {
  attachScreenshots: true,
  maxAttachmentBytes: 10_000,
  maxTotalAttachmentBytes: 100_000,
  maxVideoBytes: 50_000_000,
  outputDir,
} as never;

afterAll(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
});
const hookIndex = { get: () => ({ kind: 'beforeAll', name: 'BeforeAll hook' }) } as unknown as HookIndex;

function tracker() {
  return new RunHookTracker(config, new AttachmentBudget(100_000));
}

function attachment(id: string, name = 'shot.png') {
  return {
    body: Buffer.from('bytes').toString('base64'),
    contentEncoding: 'BASE64',
    mediaType: 'image/png',
    fileName: name,
    testRunHookStartedId: id,
  } as never;
}

function finished(id: string, status: string) {
  return {
    testRunHookStartedId: id,
    result: { status, duration: { seconds: 0, nanos: 1_000_000 }, message: status === 'FAILED' ? 'boom' : undefined },
  } as never;
}

describe('BeforeAll/AfterAll attachments', () => {
  // The limitation this closes: a screenshot taken in a failing BeforeAll had
  // nowhere to go, even though a failed hook already becomes a synthetic Case.
  it('lands on the synthetic Case when the hook FAILS', () => {
    const t = tracker();
    t.start({ id: 'h1', hookId: 'hook' } as never);
    expect(t.attachment(attachment('h1'))).toBe(true);
    t.finish(finished('h1', 'FAILED'), hookIndex);

    const suite = t.buildSuite();
    expect(suite).toBeDefined();
    expect(suite!.cases[0].attachments).toHaveLength(1);
    expect(suite!.cases[0].attachments![0].name).toBe('shot.png');
  });

  // A passing hook produces no Case, so its attachments have nowhere to land.
  // They must not accumulate for the rest of the run either.
  it('drops them when the hook passes, spending no budget', () => {
    const budget = new AttachmentBudget(100_000);
    const t = new RunHookTracker(config, budget);
    t.start({ id: 'h1', hookId: 'hook' } as never);
    t.attachment(attachment('h1'));
    t.finish(finished('h1', 'PASSED'), hookIndex);

    expect(t.buildSuite()).toBeUndefined();
    expect(budget.usedBytes).toBe(0);
  });

  // Older cucumber-js does not populate testRunHookStartedId. Unclaimed means
  // the attachment falls through to the previous behaviour rather than being
  // mis-filed against an unrelated hook.
  it('does not claim an attachment with no run-hook id', () => {
    const t = tracker();
    expect(t.attachment({ body: '', contentEncoding: 'IDENTITY', mediaType: 'text/plain' } as never)).toBe(false);
  });

  it('keeps each hook’s attachments separate', () => {
    const t = tracker();
    t.start({ id: 'h1', hookId: 'hook' } as never);
    t.start({ id: 'h2', hookId: 'hook' } as never);
    t.attachment(attachment('h1', 'first.png'));
    t.attachment(attachment('h2', 'second.png'));
    t.finish(finished('h1', 'FAILED'), hookIndex);
    t.finish(finished('h2', 'FAILED'), hookIndex);

    const cases = t.buildSuite()!.cases;
    expect(cases[0].attachments![0].name).toBe('first.png');
    expect(cases[1].attachments![0].name).toBe('second.png');
  });
});
