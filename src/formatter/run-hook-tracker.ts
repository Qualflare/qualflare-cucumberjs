import type { Attachment as MessageAttachment, TestRunHookFinished, TestRunHookStarted } from '@cucumber/messages';

import { messageDurationToNs } from '../shared/duration.js';
import type { Case } from '../shared/types.js';
import type { AttachmentBudget, AttachmentBudgetConfig, PendingAttachment } from './attachment-budget.js';
import { resolvePendingAttachment } from './attachment-budget.js';
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
 *
 * Attachments made from inside a run hook (`this.attach()`, which sets
 * `testRunHookStartedId` rather than `testCaseStartedId`) are buffered here and
 * land on that synthetic Case. They are buffered RAW and only resolved once the
 * hook is known to have failed: a passing hook produces no Case, so resolving
 * eagerly would spend the run's attachment budget on bytes that are then thrown
 * away.
 */
export class RunHookTracker {
  /** `testRunHookStartedId` -> the hook it started, so `finish()` can look
   * up its kind/name. `TestRunHookFinished.result.duration` already gives
   * an accurate duration directly — no start/finish timestamp delta needed. */
  private readonly started = new Map<string, string>();
  private readonly failed: Case[] = [];
  /** `testRunHookStartedId` -> attachments made during that hook, unresolved. */
  private readonly pending = new Map<string, PendingAttachment[]>();

  constructor(
    private readonly config: AttachmentBudgetConfig,
    private readonly budget: AttachmentBudget,
  ) {}

  start(e: TestRunHookStarted): void {
    this.started.set(e.id, e.hookId);
  }

  /**
   * Buffers one attachment made from inside a `BeforeAll`/`AfterAll`. Returns
   * whether it was claimed, so the caller can tell a run-hook attachment from
   * one that simply has no home.
   *
   * `testRunHookStartedId` is optional in the message schema and only populated
   * by newer cucumber-js; when it is absent this returns false and the
   * attachment is dropped exactly as it was before.
   */
  attachment(e: MessageAttachment): boolean {
    if (!e.testRunHookStartedId) {
      return false;
    }
    const content = e.contentEncoding === 'BASE64' ? e.body : Buffer.from(e.body, 'utf8').toString('base64');
    const list = this.pending.get(e.testRunHookStartedId) ?? [];
    list.push({ name: e.fileName || 'attachment', mimeType: e.mediaType, content });
    this.pending.set(e.testRunHookStartedId, list);
    return true;
  }

  finish(e: TestRunHookFinished, hookIndex: HookIndex): void {
    const hookId = this.started.get(e.testRunHookStartedId);
    this.started.delete(e.testRunHookStartedId);
    const status = mapStatus(e.result.status);
    if (status === 'passed' || status === 'skipped') {
      // No Case will exist for this hook, so its buffered attachments have
      // nowhere to go. Dropped rather than left to grow for the whole run.
      this.pending.delete(e.testRunHookStartedId);
      return;
    }
    const hook = hookId ? hookIndex.get(hookId) : undefined;
    const label = hook?.kind === 'afterAll' ? 'AfterAll hook' : 'BeforeAll hook';
    const attachments = this.takeAttachments(e.testRunHookStartedId);
    this.failed.push({
      id: `global-hook:${e.testRunHookStartedId}`,
      name: hook?.name || label,
      status,
      duration: messageDurationToNs(e.result.duration),
      // `result.message` first — see `step-mapper.ts`'s `formatError()` doc
      // comment for why (verified empirically to be the version-safe field
      // across the peer-dependency range; `exception.stackTrace` is not).
      error: e.result.message || e.result.exception?.stackTrace || e.result.exception?.message,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }

  /** Resolves and clears the buffer for one hook. Called only for a FAILED
   * hook, so the budget is never spent on a passing one's attachments. */
  private takeAttachments(testRunHookStartedId: string) {
    const buffered = this.pending.get(testRunHookStartedId) ?? [];
    this.pending.delete(testRunHookStartedId);
    return buffered
      .map((pending) => resolvePendingAttachment(pending, this.config, this.budget))
      .filter((a): a is NonNullable<typeof a> => a !== undefined);
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
