import type { TestRunHookFinished, TestRunHookStarted } from '@cucumber/messages';

import { messageDurationToNs } from '../shared/duration.js';
import type { Case } from '../shared/types.js';
import type { HookIndex } from './hook-index.js';
import { mapStatus } from './step-mapper.js';

/**
 * `BeforeAll`/`AfterAll` run outside any test case (`testRunHookStarted`/
 * `Finished`, never a `Case`) — `allure-cucumberjs` drops these entirely
 * (confirmed by reading its real source: no case for them anywhere in its
 * envelope-dispatch switch). This tracker does not: a FAILED run-hook
 * becomes a synthetic `Case` in a `(global hooks)` Suite (design decision
 * (b) in the plan); a passing one produces nothing — a passing `BeforeAll`
 * has no useful signal to report, and would be pure noise on every run.
 */
export class RunHookTracker {
  /** `testRunHookStartedId` -> the hook it started, so `finish()` can look
   * up its kind/name. `TestRunHookFinished.result.duration` already gives
   * an accurate duration directly — no start/finish timestamp delta needed. */
  private readonly started = new Map<string, string>();
  private readonly failed: Case[] = [];

  start(e: TestRunHookStarted): void {
    this.started.set(e.id, e.hookId);
  }

  finish(e: TestRunHookFinished, hookIndex: HookIndex): void {
    const hookId = this.started.get(e.testRunHookStartedId);
    this.started.delete(e.testRunHookStartedId);
    const status = mapStatus(e.result.status);
    if (status === 'passed' || status === 'skipped') {
      return;
    }
    const hook = hookId ? hookIndex.get(hookId) : undefined;
    const label = hook?.kind === 'afterAll' ? 'AfterAll hook' : 'BeforeAll hook';
    this.failed.push({
      id: `global-hook:${e.testRunHookStartedId}`,
      name: hook?.name || label,
      status,
      duration: messageDurationToNs(e.result.duration),
      // `result.message` first — see `step-mapper.ts`'s `formatError()` doc
      // comment for why (verified empirically to be the version-safe field
      // across the peer-dependency range; `exception.stackTrace` is not).
      error: e.result.message || e.result.exception?.stackTrace || e.result.exception?.message,
    });
  }

  /** Returns `undefined` if no run-hook failed — see the class doc comment
   * for why a passing BeforeAll/AfterAll produces no Case at all. */
  buildSuite(): { name: string; category: 'cucumber'; duration: number; cases: Case[] } | undefined {
    if (this.failed.length === 0) {
      return undefined;
    }
    return {
      name: '(global hooks)',
      category: 'cucumber',
      duration: this.failed.reduce((sum, c) => sum + c.duration, 0),
      cases: this.failed,
    };
  }
}
