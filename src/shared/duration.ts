import type { NanosecondDuration } from './types.js';

const NS_PER_MS = 1_000_000;
const NS_PER_SECOND = 1_000_000_000;

/**
 * Converts a plain millisecond duration (e.g. from `Date.now()` deltas used
 * by manual `qualflare.step()` timing) into the wire format's raw-nanosecond
 * integer (see `NanosecondDuration` in ./types.ts).
 *
 * Rounds (not truncates) so fractional-ms input doesn't lose precision by
 * always rounding toward zero. Negative input is clamped to 0 — a negative
 * duration is never legitimate and silently clamping is safer for an
 * ingest payload than throwing and aborting an otherwise-good report.
 */
export function msToNs(ms: number): NanosecondDuration {
  if (!Number.isFinite(ms) || ms <= 0) {
    return 0;
  }
  return Math.round(ms * NS_PER_MS);
}

/**
 * Converts a `@cucumber/messages` structured `Duration` ({seconds, nanos})
 * into the wire format's raw-nanosecond integer, without round-tripping
 * through milliseconds (which would lose sub-millisecond precision Cucumber
 * already reports natively). Negative/malformed input is clamped to 0, same
 * defensive posture as `msToNs`.
 */
export function messageDurationToNs(duration: { seconds: number; nanos: number } | undefined): NanosecondDuration {
  if (!duration || !Number.isFinite(duration.seconds) || !Number.isFinite(duration.nanos)) {
    return 0;
  }
  const total = duration.seconds * NS_PER_SECOND + duration.nanos;
  return total > 0 ? Math.round(total) : 0;
}
