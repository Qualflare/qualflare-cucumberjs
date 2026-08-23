import { TestStepResultStatus } from '@cucumber/messages';
import { describe, expect, it } from 'vitest';

import { RunHookTracker } from '../../src/formatter/run-hook-tracker.js';
import { buildHookIndexFromRaw } from './support/fake-hook-index.js';

function timestamp() {
  return { seconds: 0, nanos: 0 };
}

describe('RunHookTracker', () => {
  it('produces no Case at all for a passing BeforeAll/AfterAll — no signal, so no noise', () => {
    const tracker = new RunHookTracker();
    const hookIndex = buildHookIndexFromRaw([{ id: 'hook-1', kind: 'beforeAll' }]);

    tracker.start({ id: 'started-1', hookId: 'hook-1', testRunStartedId: 'run-1', timestamp: timestamp() });
    tracker.finish(
      { testRunHookStartedId: 'started-1', result: { duration: { seconds: 0, nanos: 1000 }, status: TestStepResultStatus.PASSED }, timestamp: timestamp() },
      hookIndex,
    );

    expect(tracker.buildSuite()).toBeUndefined();
  });

  it('builds a "(global hooks)" suite with one failed Case for a failing BeforeAll', () => {
    const tracker = new RunHookTracker();
    const hookIndex = buildHookIndexFromRaw([{ id: 'hook-1', kind: 'beforeAll' }]);

    tracker.start({ id: 'started-1', hookId: 'hook-1', testRunStartedId: 'run-1', timestamp: timestamp() });
    tracker.finish(
      {
        testRunHookStartedId: 'started-1',
        result: {
          duration: { seconds: 0, nanos: 5000 },
          status: TestStepResultStatus.FAILED,
          message: 'setup boom',
          exception: { type: 'Error', message: 'setup boom', stackTrace: 'Error: setup boom' },
        },
        timestamp: timestamp(),
      },
      hookIndex,
    );

    const suite = tracker.buildSuite();
    expect(suite).toBeDefined();
    expect(suite!.name).toBe('(global hooks)');
    expect(suite!.category).toBe('cucumber');
    expect(suite!.cases).toHaveLength(1);
    expect(suite!.cases[0]).toMatchObject({ name: 'BeforeAll hook', status: 'failed', duration: 5000, error: 'setup boom' });
  });

  it('distinguishes a failing AfterAll from a failing BeforeAll by name', () => {
    const tracker = new RunHookTracker();
    const hookIndex = buildHookIndexFromRaw([{ id: 'hook-1', kind: 'afterAll' }]);

    tracker.start({ id: 'started-1', hookId: 'hook-1', testRunStartedId: 'run-1', timestamp: timestamp() });
    tracker.finish(
      {
        testRunHookStartedId: 'started-1',
        result: { duration: { seconds: 0, nanos: 1000 }, status: TestStepResultStatus.FAILED, message: 'teardown boom' },
        timestamp: timestamp(),
      },
      hookIndex,
    );

    expect(tracker.buildSuite()!.cases[0]!.name).toBe('AfterAll hook');
  });

  it('accumulates multiple failed run-hooks into one suite', () => {
    const tracker = new RunHookTracker();
    const hookIndex = buildHookIndexFromRaw([
      { id: 'hook-1', kind: 'beforeAll' },
      { id: 'hook-2', kind: 'afterAll' },
    ]);

    for (const [startedId, hookId] of [
      ['s1', 'hook-1'],
      ['s2', 'hook-2'],
    ] as const) {
      tracker.start({ id: startedId, hookId, testRunStartedId: 'run-1', timestamp: timestamp() });
      tracker.finish(
        {
          testRunHookStartedId: startedId,
          result: { duration: { seconds: 0, nanos: 1000 }, status: TestStepResultStatus.FAILED, message: 'boom' },
          timestamp: timestamp(),
        },
        hookIndex,
      );
    }

    expect(tracker.buildSuite()!.cases).toHaveLength(2);
  });
});
