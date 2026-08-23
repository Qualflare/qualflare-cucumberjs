import { describe, expect, it } from 'vitest';

import { collapseAttempts, type AttemptSnapshot } from '../../src/formatter/case-builder.js';

function attempt(overrides: Partial<AttemptSnapshot> = {}): AttemptSnapshot {
  return {
    status: 'passed',
    duration: 1000,
    steps: [],
    manualSteps: [],
    labels: [],
    links: [],
    tags: [],
    properties: {},
    attachments: [],
    ...overrides,
  };
}

describe('collapseAttempts', () => {
  it('throws for an empty attempts array', () => {
    expect(() => collapseAttempts([])).toThrow(/at least one attempt/);
  });

  it('a single passing attempt has retryCount 0 and is not flaky', () => {
    const result = collapseAttempts([attempt({ status: 'passed' })]);
    expect(result.status).toBe('passed');
    expect(result.retryCount).toBe(0);
    expect(result.isFlaky).toBe(false);
  });

  it('a single failing attempt keeps its error', () => {
    const result = collapseAttempts([attempt({ status: 'failed', error: 'boom' })]);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom');
  });

  it('sums duration across every attempt, not just the final one', () => {
    const result = collapseAttempts([attempt({ duration: 100 }), attempt({ duration: 200 }), attempt({ duration: 300 })]);
    expect(result.duration).toBe(600);
  });

  it('marks flaky when an earlier attempt failed but the final one passed', () => {
    const result = collapseAttempts([attempt({ status: 'failed' }), attempt({ status: 'passed' })]);
    expect(result.status).toBe('passed');
    expect(result.retryCount).toBe(1);
    expect(result.isFlaky).toBe(true);
  });

  it('does NOT mark flaky when every attempt (including the final one) failed', () => {
    const result = collapseAttempts([attempt({ status: 'failed' }), attempt({ status: 'failed' })]);
    expect(result.status).toBe('failed');
    expect(result.isFlaky).toBe(false);
  });

  it('clears error when the final attempt passed, even if an earlier attempt had one', () => {
    const result = collapseAttempts([attempt({ status: 'failed', error: 'first try boom' }), attempt({ status: 'passed' })]);
    expect(result.error).toBeUndefined();
  });

  it('discards all but the FINAL attempt\'s steps — an abandoned attempt never contributes steps', () => {
    const result = collapseAttempts([
      attempt({ steps: [{ name: 'first-attempt-step', status: 'failed', duration: 1 }] }),
      attempt({ status: 'passed', steps: [{ name: 'second-attempt-step', status: 'passed', duration: 1 }] }),
    ]);
    expect(result.steps).toHaveLength(1);
    expect(result.steps![0]!.name).toBe('second-attempt-step');
  });

  it('appends manual steps after real steps, offsetting parentIndex by the real-steps count', () => {
    const result = collapseAttempts([
      attempt({
        steps: [{ name: 'real step', status: 'passed', duration: 1 }],
        manualSteps: [
          { name: 'manual root', status: 'passed', startedAt: 0, durationMs: 5 },
          { name: 'manual child', status: 'passed', startedAt: 1, durationMs: 2, parentIndex: 0 },
        ],
      }),
    ]);
    expect(result.steps).toHaveLength(3);
    expect(result.steps![1]).toMatchObject({ name: 'manual root', duration: 5_000_000 });
    // parentIndex 0 (relative to the manual-steps array) shifted by realSteps.length (1) -> 1
    expect(result.steps![2]).toMatchObject({ name: 'manual child', parentIndex: 1 });
  });

  it('returns undefined steps when there are neither real nor manual steps', () => {
    const result = collapseAttempts([attempt({ steps: [], manualSteps: [] })]);
    expect(result.steps).toBeUndefined();
  });
});
