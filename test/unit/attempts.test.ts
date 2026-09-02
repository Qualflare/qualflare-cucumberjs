import { describe, expect, it } from 'vitest';

import { collapseAttempts, type AttemptSnapshot } from '../../src/formatter/case-builder.js';
import { MAX_ATTEMPTS_PER_CASE } from '../../src/shared/constants.js';

/** cucumber-js reports nanosecond precision natively, so — unlike the Cypress
 * port this module was derived from — there is no millisecond round-trip
 * anywhere on this path. Durations here are nanoseconds throughout. */
const NS = 1_000_000;

function snapshot(status: AttemptSnapshot['status'], durationMs: number, error?: string): AttemptSnapshot {
  return {
    status,
    duration: durationMs * NS,
    error,
    steps: [],
    manualSteps: [],
    labels: [],
    links: [],
    tags: [],
    attachments: [],
    properties: {},
  } as unknown as AttemptSnapshot;
}

describe('collapseAttempts attempt history', () => {
  // A scenario that ran once has no history beyond what the Case already
  // carries. The server discards a one-element array, so sending one spends
  // payload against the 10MB body limit for a row it drops.
  it('sends no history for a scenario that was not retried', () => {
    expect(collapseAttempts([snapshot('passed', 120)]).attempts).toBeUndefined();
  });

  it('numbers attempts 1..N in execution order and keeps nanoseconds', () => {
    const result = collapseAttempts([
      snapshot('failed', 100, 'boom'),
      snapshot('failed', 100, 'boom again'),
      snapshot('passed', 90),
    ]);

    expect(result.attempts).toHaveLength(3);
    expect(result.attempts!.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(result.attempts!.map((a) => a.status)).toEqual(['failed', 'failed', 'passed']);
    // No conversion on this path — the snapshot unit IS the wire unit.
    expect(result.attempts!.map((a) => a.duration)).toEqual([100 * NS, 100 * NS, 90 * NS]);
  });

  // The final attempt must be present. The server overwrites its status and
  // duration from the Case but keeps its message — omitting it would lose the
  // error text of the execution that actually counted.
  it('includes the final attempt, not only the failed ones', () => {
    const result = collapseAttempts([snapshot('failed', 100, 'boom'), snapshot('passed', 90)]);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts![1]!.status).toBe('passed');
  });

  // The collapsed `error` is dropped when the final attempt passed — exactly
  // when the earlier failure is most worth keeping. This is the gap the
  // attempt history closes.
  it('preserves an earlier failure that the collapsed error discards', () => {
    const result = collapseAttempts([
      snapshot('failed', 100, 'Step failed: Given a broken fixture'),
      snapshot('passed', 90),
    ]);

    expect(result.error).toBeUndefined();
    expect(result.attempts![0]!.message).toBe('Step failed: Given a broken fixture');
    expect(result.attempts![1]!.message).toBeUndefined();
  });

  // Over the cap the server keeps the first 49 plus the final one. Trimming the
  // same way here means the bytes are never sent, and the FINAL attempt
  // survives — a plain slice(0, 50) would drop it.
  it('caps at the server limit while preserving the final attempt', () => {
    const attempts = [
      ...Array.from({ length: 60 }, () => snapshot('failed', 100, 'boom')),
      snapshot('passed', 999),
    ];
    const result = collapseAttempts(attempts);

    expect(result.attempts).toHaveLength(MAX_ATTEMPTS_PER_CASE);
    expect(result.attempts![MAX_ATTEMPTS_PER_CASE - 1]!.status).toBe('passed');
    expect(result.attempts![MAX_ATTEMPTS_PER_CASE - 1]!.duration).toBe(999 * NS);
    expect(result.attempts!.map((a) => a.attempt)).toEqual(
      Array.from({ length: MAX_ATTEMPTS_PER_CASE }, (_, i) => i + 1),
    );
  });

  it('stays consistent with retryCount and isFlaky', () => {
    const result = collapseAttempts([
      snapshot('failed', 100, 'boom'),
      snapshot('failed', 100, 'boom'),
      snapshot('passed', 90),
    ]);
    expect(result.retryCount).toBe(2);
    expect(result.attempts).toHaveLength(result.retryCount + 1);
    expect(result.isFlaky).toBe(true);
  });
});
