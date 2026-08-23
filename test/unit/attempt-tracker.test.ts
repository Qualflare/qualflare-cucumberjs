import { AttachmentContentEncoding, TestStepResultStatus } from '@cucumber/messages';
import { describe, expect, it } from 'vitest';

import { AttachmentBudget } from '../../src/formatter/attachment-budget.js';
import { AttemptTracker } from '../../src/formatter/attempt-tracker.js';
import { GherkinIndex } from '../../src/formatter/gherkin-index.js';
import { buildHookIndexFromRaw } from './support/fake-hook-index.js';

const CONFIG = {
  includeStepHooks: false,
  attachScreenshots: true,
  maxAttachmentBytes: 1_500_000,
  maxTotalAttachmentBytes: 750_000,
};

function passedResult(nanos = 1000) {
  return { duration: { seconds: 0, nanos }, status: TestStepResultStatus.PASSED };
}

function failedResult(message: string, nanos = 1000) {
  return {
    duration: { seconds: 0, nanos },
    status: TestStepResultStatus.FAILED,
    message,
    exception: { type: 'Error', message, stackTrace: message },
  };
}

function makeTracker(hookIndex = buildHookIndexFromRaw([])) {
  const gherkin = new GherkinIndex();
  const budget = new AttachmentBudget(CONFIG.maxTotalAttachmentBytes);
  const tracker = new AttemptTracker(hookIndex, gherkin, CONFIG, budget);
  return { tracker, gherkin, budget };
}

function pickleStep(id: string, text: string) {
  return { id, text, astNodeIds: [], type: 'Action' as const };
}

function pickle(overrides: Partial<{ id: string; uri: string; name: string; steps: ReturnType<typeof pickleStep>[] }> = {}) {
  return {
    id: overrides.id ?? 'pickle-1',
    uri: overrides.uri ?? 'features/a.feature',
    name: overrides.name ?? 'a scenario',
    language: 'en',
    steps: overrides.steps ?? [pickleStep('step-1', 'a step')],
    tags: [],
    astNodeIds: ['scenario-1'],
  };
}

function testCase(steps: { id: string; pickleStepId?: string; hookId?: string }[], overrides: { id?: string; pickleId?: string } = {}) {
  return {
    id: overrides.id ?? 'testcase-1',
    pickleId: overrides.pickleId ?? 'pickle-1',
    testSteps: steps,
  };
}

function timestamp() {
  return { seconds: 0, nanos: 0 };
}

describe('AttemptTracker', () => {
  it('builds a single passing attempt with no retry', () => {
    const { tracker } = makeTracker();
    const tc = testCase([{ id: 'ts-1', pickleStepId: 'step-1' }]);
    const p = pickle();

    tracker.begin({ id: 'tcs-1', testCaseId: tc.id, attempt: 0, timestamp: timestamp() }, tc, p);
    tracker.stepStarted({ testCaseStartedId: 'tcs-1', testStepId: 'ts-1', timestamp: timestamp() });
    tracker.stepFinished({ testCaseStartedId: 'tcs-1', testStepId: 'ts-1', testStepResult: passedResult(), timestamp: timestamp() });
    const finished = tracker.finish({ testCaseStartedId: 'tcs-1', timestamp: timestamp(), willBeRetried: false });

    expect(finished).toBeDefined();
    expect(finished!.collapsed.status).toBe('passed');
    expect(finished!.collapsed.retryCount).toBe(0);
    expect(finished!.collapsed.isFlaky).toBe(false);
    expect(finished!.collapsed.steps).toHaveLength(1);
  });

  it('returns undefined while willBeRetried is true, then collapses all attempts once the final one lands', () => {
    const { tracker } = makeTracker();
    const tc = testCase([{ id: 'ts-1', pickleStepId: 'step-1' }]);
    const p = pickle();

    // Attempt 0: fails, will be retried.
    tracker.begin({ id: 'tcs-1', testCaseId: tc.id, attempt: 0, timestamp: timestamp() }, tc, p);
    tracker.stepFinished({
      testCaseStartedId: 'tcs-1',
      testStepId: 'ts-1',
      testStepResult: failedResult('boom'),
      timestamp: timestamp(),
    });
    const midRetry = tracker.finish({ testCaseStartedId: 'tcs-1', timestamp: timestamp(), willBeRetried: true });
    expect(midRetry).toBeUndefined();

    // Attempt 1: passes, final.
    tracker.begin({ id: 'tcs-2', testCaseId: tc.id, attempt: 1, timestamp: timestamp() }, tc, p);
    tracker.stepFinished({ testCaseStartedId: 'tcs-2', testStepId: 'ts-1', testStepResult: passedResult(), timestamp: timestamp() });
    const finished = tracker.finish({ testCaseStartedId: 'tcs-2', timestamp: timestamp(), willBeRetried: false });

    expect(finished).toBeDefined();
    expect(finished!.collapsed.status).toBe('passed');
    expect(finished!.collapsed.retryCount).toBe(1);
    expect(finished!.collapsed.isFlaky).toBe(true);
    // Duration is the SUM across both attempts, not just the final one.
    expect(finished!.collapsed.duration).toBe(2000);
  });

  it('always includes a Before/After hook as a synthetic step', () => {
    const hookIndex = buildHookIndexFromRaw([{ id: 'hook-before', kind: 'before' }]);
    const { tracker } = makeTracker(hookIndex);
    const tc = testCase([{ id: 'ts-hook', hookId: 'hook-before' }, { id: 'ts-1', pickleStepId: 'step-1' }]);
    const p = pickle();

    tracker.begin({ id: 'tcs-1', testCaseId: tc.id, attempt: 0, timestamp: timestamp() }, tc, p);
    tracker.stepFinished({ testCaseStartedId: 'tcs-1', testStepId: 'ts-hook', testStepResult: passedResult(), timestamp: timestamp() });
    tracker.stepFinished({ testCaseStartedId: 'tcs-1', testStepId: 'ts-1', testStepResult: passedResult(), timestamp: timestamp() });
    const finished = tracker.finish({ testCaseStartedId: 'tcs-1', timestamp: timestamp(), willBeRetried: false })!;

    expect(finished.collapsed.steps).toHaveLength(2);
    expect(finished.collapsed.steps![0]).toMatchObject({ keyword: 'Before', status: 'passed' });
  });

  it('excludes BeforeStep/AfterStep by default, and includes them as flat (un-nested) steps when enabled', () => {
    const hookIndex = buildHookIndexFromRaw([
      { id: 'hook-before-step', kind: 'beforeStep' },
      { id: 'hook-after-step', kind: 'afterStep' },
    ]);
    const tc = testCase([
      { id: 'ts-before-step', hookId: 'hook-before-step' },
      { id: 'ts-1', pickleStepId: 'step-1' },
      { id: 'ts-after-step', hookId: 'hook-after-step' },
    ]);
    const p = pickle();

    // Default: excluded entirely.
    {
      const { tracker } = makeTracker(hookIndex);
      tracker.begin({ id: 'tcs-1', testCaseId: tc.id, attempt: 0, timestamp: timestamp() }, tc, p);
      for (const id of ['ts-before-step', 'ts-1', 'ts-after-step']) {
        tracker.stepFinished({ testCaseStartedId: 'tcs-1', testStepId: id, testStepResult: passedResult(), timestamp: timestamp() });
      }
      const finished = tracker.finish({ testCaseStartedId: 'tcs-1', timestamp: timestamp(), willBeRetried: false })!;
      expect(finished.collapsed.steps).toHaveLength(1);
    }

    // Enabled: both show up, in chronological order, and — this is the
    // regression case for a real bug found in self-review — BeforeStep must
    // NOT be nested under the step that happened to be pushed immediately
    // before it (there is none here, so an incorrect implementation would
    // either crash resolving a bogus parentIndex or silently mis-nest once a
    // preceding step exists).
    {
      const gherkin = new GherkinIndex();
      const budget = new AttachmentBudget(CONFIG.maxTotalAttachmentBytes);
      const tracker = new AttemptTracker(hookIndex, gherkin, { ...CONFIG, includeStepHooks: true }, budget);
      tracker.begin({ id: 'tcs-1', testCaseId: tc.id, attempt: 0, timestamp: timestamp() }, tc, p);
      for (const id of ['ts-before-step', 'ts-1', 'ts-after-step']) {
        tracker.stepFinished({ testCaseStartedId: 'tcs-1', testStepId: id, testStepResult: passedResult(), timestamp: timestamp() });
      }
      const finished = tracker.finish({ testCaseStartedId: 'tcs-1', timestamp: timestamp(), willBeRetried: false })!;
      expect(finished.collapsed.steps).toHaveLength(3);
      expect(finished.collapsed.steps!.map((s) => s.keyword)).toEqual(['BeforeStep', undefined, 'AfterStep']);
      // Neither hook step is nested under an unrelated sibling.
      expect(finished.collapsed.steps![0]!.parentIndex).toBeUndefined();
      expect(finished.collapsed.steps![2]!.parentIndex).toBeUndefined();
    }
  });

  it('applies a reserved-media-type runtime message as a model mutation, not a literal attachment', () => {
    const { tracker } = makeTracker();
    const tc = testCase([{ id: 'ts-1', pickleStepId: 'step-1' }]);
    const p = pickle();

    tracker.begin({ id: 'tcs-1', testCaseId: tc.id, attempt: 0, timestamp: timestamp() }, tc, p);
    tracker.attachment({
      body: JSON.stringify({ type: 'label', name: 'epic', value: 'Checkout' }),
      contentEncoding: AttachmentContentEncoding.IDENTITY,
      mediaType: 'application/vnd.qualflare.message+json',
      testCaseStartedId: 'tcs-1',
    });
    tracker.stepFinished({ testCaseStartedId: 'tcs-1', testStepId: 'ts-1', testStepResult: passedResult(), timestamp: timestamp() });
    const finished = tracker.finish({ testCaseStartedId: 'tcs-1', timestamp: timestamp(), willBeRetried: false })!;

    expect(finished.collapsed.labels).toEqual([{ name: 'epic', value: 'Checkout' }]);
    expect(finished.collapsed.attachments).toHaveLength(0);
  });

  it('resolves a real attachment and correlates it to the step it was attached during', () => {
    const { tracker } = makeTracker();
    const tc = testCase([{ id: 'ts-1', pickleStepId: 'step-1' }]);
    const p = pickle();

    tracker.begin({ id: 'tcs-1', testCaseId: tc.id, attempt: 0, timestamp: timestamp() }, tc, p);
    tracker.stepStarted({ testCaseStartedId: 'tcs-1', testStepId: 'ts-1', timestamp: timestamp() });
    tracker.attachment({
      body: Buffer.from('hello').toString('base64'),
      contentEncoding: AttachmentContentEncoding.BASE64,
      mediaType: 'text/plain',
      fileName: 'note.txt',
      testCaseStartedId: 'tcs-1',
      testStepId: 'ts-1',
    });
    tracker.stepFinished({ testCaseStartedId: 'tcs-1', testStepId: 'ts-1', testStepResult: passedResult(), timestamp: timestamp() });
    const finished = tracker.finish({ testCaseStartedId: 'tcs-1', timestamp: timestamp(), willBeRetried: false })!;

    expect(finished.collapsed.attachments).toHaveLength(1);
    expect(finished.collapsed.attachments[0]).toMatchObject({ name: 'note.txt', mimeType: 'text/plain', stepIndex: 0 });
  });
});
