import {
  getWorstTestStepResult,
  type Attachment as MessageAttachment,
  type Pickle,
  type TestCase,
  type TestCaseFinished,
  type TestCaseStarted,
  type TestStepFinished,
  type TestStepResult,
  type TestStepStarted,
} from '@cucumber/messages';

import { RESERVED_MESSAGE_MEDIA_TYPE, MAX_STEPS_PER_TEST_ATTEMPT } from '../shared/constants.js';
import { messageDurationToNs } from '../shared/duration.js';
import { logger } from '../shared/logger.js';
import type { ManualStepRecord, RuntimeMessage } from '../runtime/message-types.js';
import type { Attachment, CasePriority, Label, Link, Step } from '../shared/types.js';
import {
  AttachmentBudget,
  isVideoLike,
  resolvePendingAttachment,
  resolveVideoAttachment,
  type AttachmentBudgetConfig,
  type PendingAttachment,
} from './attachment-budget.js';
import { collapseAttempts, type AttemptSnapshot, type CollapsedResult } from './case-builder.js';
import type { GherkinIndex } from './gherkin-index.js';
import type { HookIndex } from './hook-index.js';
import { mapHookStep, mapPickleStep, mapStatus } from './step-mapper.js';

export interface FinishedAttempts {
  uri: string;
  pickleId: string;
  collapsed: CollapsedResult;
}

interface AttemptRecord {
  testCase: TestCase;
  pickle: Pickle;
  attempt: number;
  startedAtMs: number;
  steps: Step[];
  stepResults: TestStepResult[];
  /** Maps a `TestStep.id` to its index in `steps`, once finished — used to
   * correlate a same-step attachment's `stepIndex` on the wire. */
  stepIndexByTestStepId: Map<string, number>;
  currentTestStepId?: string;
  manualSteps: ManualStepRecord[];
  manualStepStack: number[];
  labels: Label[];
  links: Link[];
  tags: string[];
  description?: string;
  priority?: CasePriority;
  properties: Record<string, string>;
  attachments: Attachment[];
  stepCapWarned: boolean;
  /** Not-yet-settled video writes (see `resolveVideoAttachment`) started
   * during this attempt. Each one, once settled, pushes its resulting
   * `Attachment` onto `attachments` above (mutating the array in place —
   * never reassigning it — so a reference already captured elsewhere still
   * sees the push; see `finish()`'s doc comment for why this matters).
   * `finish()` awaits every attempt's own queue before collapsing, so
   * `attachments` is always complete by the time it's read.
   *
   * Still genuinely needed even though writing a video is now synchronous
   * filesystem work rather than an upload: `resolveVideoAttachment` remains
   * an `async` function, so the `.then()` that performs the push runs on a
   * microtask, not inline. Dropping this queue would reintroduce exactly the
   * bug `finish()` documents. */
  pendingVideoWrites: Promise<void>[];
}

/**
 * The retry-safe core. Two lookup layers, both required because
 * cucumber-js's *grouping* key (a logical scenario, stable across retries —
 * `testCase.id`) and its *live-event-addressing* key (one specific attempt
 * — `testCaseStarted.id`) are genuinely different fields on the wire.
 * `testCaseFinished.willBeRetried === false` is the sole authoritative
 * "this scenario is really done" signal — no hash-based grouping anywhere
 * (the deliberate fix for `allure-framework/allure-js#625`/`#1502`, both
 * real bugs caused by Allure's content-hash retry/outline-row grouping).
 */
export class AttemptTracker {
  private readonly byTestCaseId = new Map<string, AttemptRecord[]>();
  private readonly byTestCaseStartedId = new Map<string, AttemptRecord>();

  constructor(
    private readonly hookIndex: HookIndex,
    private readonly gherkin: GherkinIndex,
    private readonly config: { includeStepHooks: boolean } & AttachmentBudgetConfig,
    private readonly attachmentBudget: AttachmentBudget,
  ) {}

  begin(e: TestCaseStarted, testCase: TestCase, pickle: Pickle): void {
    const record: AttemptRecord = {
      testCase,
      pickle,
      attempt: e.attempt,
      startedAtMs: timestampMs(e.timestamp),
      steps: [],
      stepResults: [],
      stepIndexByTestStepId: new Map(),
      manualSteps: [],
      manualStepStack: [],
      labels: [],
      links: [],
      tags: [],
      properties: {},
      attachments: [],
      stepCapWarned: false,
      pendingVideoWrites: [],
    };
    this.byTestCaseStartedId.set(e.id, record);
    const attempts = this.byTestCaseId.get(testCase.id) ?? [];
    attempts.push(record);
    this.byTestCaseId.set(testCase.id, attempts);
  }

  stepStarted(e: TestStepStarted): void {
    const record = this.byTestCaseStartedId.get(e.testCaseStartedId);
    if (!record) {
      return;
    }
    record.currentTestStepId = e.testStepId;
  }

  stepFinished(e: TestStepFinished): void {
    const record = this.byTestCaseStartedId.get(e.testCaseStartedId);
    if (!record) {
      return;
    }
    record.currentTestStepId = undefined;
    record.stepResults.push(e.testStepResult);

    const testStep = record.testCase.testSteps.find((s) => s.id === e.testStepId);
    if (!testStep) {
      return;
    }

    let step: Step | undefined;
    if (testStep.pickleStepId) {
      const pickleStep = record.pickle.steps.find((s) => s.id === testStep.pickleStepId);
      if (pickleStep) {
        step = mapPickleStep(record.pickle.uri, pickleStep, e.testStepResult, this.gherkin);
      }
    } else if (testStep.hookId) {
      const hook = this.hookIndex.get(testStep.hookId);
      if (hook && (hook.kind === 'before' || hook.kind === 'after')) {
        step = mapHookStep(hook, e.testStepResult);
      } else if (hook && (hook.kind === 'beforeStep' || hook.kind === 'afterStep') && this.config.includeStepHooks) {
        // Deliberately NOT nested under the pickle step it wraps: BeforeStep
        // fires (and is pushed here) BEFORE that step, so "the most recently
        // pushed step" would be the PREVIOUS, unrelated step at that point —
        // an earlier version of this nested BeforeStep under the wrong
        // parent. AfterStep could be nested correctly (its wrapped step is
        // already pushed by the time it fires), but nesting one and not the
        // other would be inconsistent, so both stay flat, root-level steps —
        // still informative via their position immediately adjacent to the
        // step they wrap in the flat, chronologically-ordered array.
        step = mapHookStep(hook, e.testStepResult);
      }
    }

    if (!step) {
      return;
    }
    if (record.steps.length >= MAX_STEPS_PER_TEST_ATTEMPT) {
      if (!record.stepCapWarned) {
        record.stepCapWarned = true;
        logger.warn(
          `reached the ${MAX_STEPS_PER_TEST_ATTEMPT}-step-per-attempt cap — further steps in this scenario attempt will not be uploaded.`,
        );
      }
      return;
    }
    record.stepIndexByTestStepId.set(e.testStepId, record.steps.length);
    record.steps.push(step);
  }

  /** Handles both a real user `World.attach()` call (becomes a wire
   * `Attachment`) and a `qualflare.*()` reserved-media-type message
   * (unwrapped and applied as a model mutation instead). */
  attachment(e: MessageAttachment): void {
    if (!e.testCaseStartedId) {
      // A BeforeAll/AfterAll-scoped attachment (`testRunHookStartedId` set
      // instead) never reaches here: formatter.ts offers it to RunHookTracker
      // first, which claims it for the synthetic (global hooks) Case. Anything
      // still arriving without a testCaseStartedId has no home at all.
      return;
    }
    const record = this.byTestCaseStartedId.get(e.testCaseStartedId);
    if (!record) {
      return;
    }

    if (e.mediaType === RESERVED_MESSAGE_MEDIA_TYPE) {
      let message: RuntimeMessage;
      try {
        message = JSON.parse(e.contentEncoding === 'BASE64' ? Buffer.from(e.body, 'base64').toString('utf8') : e.body);
      } catch {
        logger.warn('received a malformed qualflare runtime message — ignoring it.');
        return;
      }
      this.applyRuntimeMessage(record, message, e.testStepId);
      return;
    }

    const stepIndex = this.resolveStepIndex(record, e.testStepId);
    const content = e.contentEncoding === 'BASE64' ? e.body : Buffer.from(e.body, 'utf8').toString('base64');
    this.resolveAttachment(record, { name: e.fileName || 'attachment', mimeType: e.mediaType, content, stepIndex });
  }

  /** Resolves one pending attachment, routing a video-like one through the
   * write-to-`outputDir` flow (tracked in `record.pendingVideoWrites` so
   * `finish()` can wait for it) and everything else through the synchronous
   * inline path — shared by the real `World.attach()` handler above and both
   * `qualflare.attachment()`/`attachmentFromFile()` runtime-message cases
   * below. */
  private resolveAttachment(record: AttemptRecord, pending: PendingAttachment): void {
    if (isVideoLike(pending.mimeType, pending.path)) {
      const write = resolveVideoAttachment(pending, this.config).then((resolved) => {
        if (resolved) {
          record.attachments.push(resolved);
        }
      });
      record.pendingVideoWrites.push(write);
      return;
    }
    const resolved = resolvePendingAttachment(pending, this.config, this.attachmentBudget);
    if (resolved) {
      record.attachments.push(resolved);
    }
  }

  /** Resolves which step index an attachment (real or `qualflare.*()`
   * message) belongs to. `stepIndexByTestStepId` only gets an entry once a
   * step is FINISHED — but `World.attach()` (the only channel available,
   * used by both a real user attachment and every `qualflare.*()` call) is
   * always called from WITHIN a step's body, i.e. strictly BETWEEN that
   * step's `testStepStarted` and `testStepFinished`. So the map lookup
   * alone can never resolve the step that's currently attaching — this was
   * a real bug found in self-review, caught by a unit test that attaches
   * mid-step instead of only after it finishes. While a step is in flight,
   * `record.steps.length` (the array's CURRENT length, before that step has
   * been pushed) is exactly the index it will occupy once it does finish —
   * single-threaded, event-ordered execution guarantees nothing else can be
   * pushed in between. */
  private resolveStepIndex(record: AttemptRecord, testStepId: string | undefined): number | undefined {
    if (testStepId === undefined) {
      return undefined;
    }
    if (record.currentTestStepId === testStepId) {
      return record.steps.length;
    }
    return record.stepIndexByTestStepId.get(testStepId);
  }

  private applyRuntimeMessage(record: AttemptRecord, message: RuntimeMessage, testStepId: string | undefined): void {
    switch (message.type) {
      case 'label':
        record.labels.push({ name: message.name, value: message.value });
        return;
      case 'link':
        record.links.push({ type: message.linkType ?? 'custom', name: message.name, url: message.url });
        return;
      case 'tag':
        record.tags.push(...message.tags);
        return;
      case 'description':
        record.description = message.text;
        return;
      case 'priority':
        record.priority = message.value;
        return;
      case 'parameter': {
        const openStepIndex = record.manualStepStack[record.manualStepStack.length - 1];
        if (openStepIndex !== undefined) {
          const step = record.manualSteps[openStepIndex]!;
          step.parameters = step.parameters ?? [];
          step.parameters.push({ name: message.name, value: message.value, masked: message.masked });
        } else {
          record.properties[message.name] = message.value ?? '';
        }
        return;
      }
      case 'attachment': {
        const stepIndex = testStepId !== undefined ? record.stepIndexByTestStepId.get(testStepId) : undefined;
        this.resolveAttachment(record, { name: message.name, mimeType: message.mimeType, content: message.contentBase64, stepIndex });
        return;
      }
      case 'attachment_from_file': {
        const stepIndex = testStepId !== undefined ? record.stepIndexByTestStepId.get(testStepId) : undefined;
        this.resolveAttachment(record, { name: message.name, mimeType: message.mimeType, path: message.path, stepIndex });
        return;
      }
      case 'step_start': {
        const parentIndex = record.manualStepStack.length > 0 ? record.manualStepStack[record.manualStepStack.length - 1] : undefined;
        const step: ManualStepRecord = { name: message.name, status: 'passed', startedAt: message.timestamp, parentIndex };
        record.manualStepStack.push(record.manualSteps.length);
        record.manualSteps.push(step);
        return;
      }
      case 'step_stop': {
        const openIndex = record.manualStepStack.pop();
        if (openIndex === undefined) {
          return;
        }
        const step = record.manualSteps[openIndex]!;
        step.status = message.status;
        step.error = message.error;
        step.durationMs = Math.max(0, message.timestamp - step.startedAt);
        return;
      }
    }
  }

  /** Returns the collapsed result once all attempts of this logical
   * scenario have arrived, or `undefined` if more attempts are coming
   * (`willBeRetried === true`).
   *
   * Async because it must first await every attempt's own
   * `pendingVideoWrites` (any video attached anywhere across every retry
   * of this scenario). This is load-bearing, not just tidiness:
   * `collapseAttempts`/`buildCase` read `attachments` by REFERENCE, not by
   * copy, and `buildCase` runs synchronously right after this resolves — a
   * scenario whose ONLY attachment is a still-uploading video would have an
   * EMPTY `attachments` array at that instant, and `buildCase` captures
   * `attachments.length > 0 ? attachments : undefined` as a plain
   * `undefined` VALUE right then, permanently — a later push onto the
   * (still-live) array reference would no longer be visible through
   * `undefined`. Awaiting here first guarantees `attachments` is complete
   * before `buildCase` ever reads it. */
  async finish(e: TestCaseFinished): Promise<FinishedAttempts | undefined> {
    const record = this.byTestCaseStartedId.get(e.testCaseStartedId);
    this.byTestCaseStartedId.delete(e.testCaseStartedId);
    if (!record) {
      return undefined;
    }
    if (e.willBeRetried) {
      return undefined;
    }

    const testCaseId = record.testCase.id;
    const attempts = this.byTestCaseId.get(testCaseId) ?? [record];
    this.byTestCaseId.delete(testCaseId);

    const pendingWrites = attempts.flatMap((a) => a.pendingVideoWrites);
    if (pendingWrites.length > 0) {
      await Promise.all(pendingWrites);
    }

    const snapshots: AttemptSnapshot[] = attempts.map((a) => {
      const worst = a.stepResults.length > 0 ? getWorstTestStepResult(a.stepResults) : undefined;
      const duration = a.stepResults.reduce((sum, r) => sum + messageDurationToNs(r.duration), 0);
      return {
        status: worst ? mapStatus(worst.status) : 'passed',
        duration,
        // `message` first — see `step-mapper.ts`'s `formatError()` doc
        // comment for why (verified empirically across the peer-dependency
        // range; `exception.stackTrace` is not version-safe).
        error: worst?.message || worst?.exception?.stackTrace || worst?.exception?.message,
        steps: a.steps,
        manualSteps: a.manualSteps,
        labels: a.labels,
        links: a.links,
        tags: a.tags,
        description: a.description,
        priority: a.priority,
        properties: a.properties,
        attachments: a.attachments,
      };
    });

    return {
      uri: record.pickle.uri,
      pickleId: record.testCase.pickleId,
      collapsed: collapseAttempts(snapshots),
    };
  }
}

function timestampMs(ts: { seconds: number; nanos: number }): number {
  return ts.seconds * 1000 + Math.floor(ts.nanos / 1_000_000);
}
