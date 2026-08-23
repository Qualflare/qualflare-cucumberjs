import * as fs from 'node:fs';

import { Formatter, type IFormatterOptions } from '@cucumber/cucumber';
import type { Envelope, GherkinDocument, Pickle, TestCase } from '@cucumber/messages';

import { resolveConfig, type QualflareCucumberOptions, type ResolvedFormatterConfig } from '../config/resolve-config.js';
import { QualflareHttpClient } from '../http/client.js';
import { logger } from '../shared/logger.js';
import { AttachmentBudget } from './attachment-budget.js';
import { AttemptTracker } from './attempt-tracker.js';
import { buildCase, type FinishedCase } from './case-builder.js';
import { buildCollectPayload } from './collect-builder.js';
import { GherkinIndex } from './gherkin-index.js';
import { buildHookIndex, type HookIndex } from './hook-index.js';
import { RunHookTracker } from './run-hook-tracker.js';
import { groupIntoSuites } from './suite-builder.js';
import { buildHttpOptions } from './video-uploader.js';

export default class QualflareCucumberFormatter extends Formatter {
  private readonly config: ResolvedFormatterConfig;
  private readonly gherkin = new GherkinIndex();
  private readonly hookIndex: HookIndex;
  private readonly pickleIndex = new Map<string, Pickle>();
  private readonly testCaseIndex = new Map<string, TestCase>();
  private readonly attachmentBudget: AttachmentBudget;
  private readonly attemptTracker: AttemptTracker;
  private readonly runHookTracker = new RunHookTracker();
  private readonly finishedCases: FinishedCase[] = [];
  /** One promise per `testCaseFinished` envelope, resolving once that
   * scenario's `AttemptTracker.finish()` (which itself awaits any pending
   * video uploads — see its doc comment) has settled and, if it produced a
   * result, been pushed into `finishedCases`. `finished()` awaits all of
   * these before building/uploading the Collect payload, so a scenario
   * whose only attachment is a still-uploading video is never silently
   * dropped from the report. */
  private readonly pendingCaseBuilds: Promise<void>[] = [];

  constructor(options: IFormatterOptions) {
    super(options);
    // cucumber-js's `formatOptions` is untyped (`FormatOptions` has only an
    // index signature) — the shape is a contract between the user's config
    // and this formatter, not something cucumber-js itself validates.
    this.config = resolveConfig(options.parsedArgvOptions as QualflareCucumberOptions);
    this.hookIndex = buildHookIndex(options.supportCodeLibrary);
    this.attachmentBudget = new AttachmentBudget(this.config.maxTotalAttachmentBytes);
    this.attemptTracker = new AttemptTracker(
      this.hookIndex,
      this.gherkin,
      { ...this.config, httpOptions: buildHttpOptions(this.config) },
      this.attachmentBudget,
    );

    if (!this.config.enabled) {
      return;
    }
    options.eventBroadcaster.on('envelope', (envelope: Envelope) => this.onEnvelope(envelope));
  }

  private onEnvelope(envelope: Envelope): void {
    try {
      this.dispatch(envelope);
    } catch (err) {
      logger.error('failed to process a cucumber-js event:', err);
    }
  }

  private dispatch(envelope: Envelope): void {
    if (envelope.gherkinDocument) {
      this.onGherkinDocument(envelope.gherkinDocument);
      return;
    }
    if (envelope.pickle) {
      this.pickleIndex.set(envelope.pickle.id, envelope.pickle);
      return;
    }
    if (envelope.testCase) {
      this.testCaseIndex.set(envelope.testCase.id, envelope.testCase);
      return;
    }
    if (envelope.testCaseStarted) {
      const testCase = this.testCaseIndex.get(envelope.testCaseStarted.testCaseId);
      const pickle = testCase ? this.pickleIndex.get(testCase.pickleId) : undefined;
      if (testCase && pickle) {
        this.attemptTracker.begin(envelope.testCaseStarted, testCase, pickle);
      } else {
        // Should never happen under cucumber-js's documented message
        // ordering (testCase/pickle always precede testCaseStarted) — this
        // scenario attempt would otherwise be silently dropped from the
        // report with no signal at all, so warn rather than swallow it.
        logger.warn(
          `could not resolve testCase/pickle for testCaseStarted "${envelope.testCaseStarted.id}" — this scenario attempt will not be uploaded.`,
        );
      }
      return;
    }
    if (envelope.testStepStarted) {
      this.attemptTracker.stepStarted(envelope.testStepStarted);
      return;
    }
    if (envelope.testStepFinished) {
      this.attemptTracker.stepFinished(envelope.testStepFinished);
      return;
    }
    if (envelope.attachment) {
      this.attemptTracker.attachment(envelope.attachment);
      return;
    }
    if (envelope.testCaseFinished) {
      // finish() is async (it awaits any pending video upload for this
      // scenario before its attachments can be read — see its doc comment),
      // but dispatch() itself stays synchronous: cucumber-js's envelope
      // stream doesn't wait for one 'envelope' listener's returned promise
      // before emitting the next, so blocking here would just desync this
      // handler from the events actually arriving. Instead, track the
      // promise and await every one of them in finished(), before the
      // Collect payload is ever built.
      const pending = this.attemptTracker
        .finish(envelope.testCaseFinished)
        .then((finished) => {
          if (!finished) {
            return;
          }
          const pickle = this.pickleIndex.get(finished.pickleId);
          if (pickle) {
            this.finishedCases.push(buildCase(finished.uri, pickle, finished.collapsed, this.gherkin));
          } else {
            logger.warn(`could not resolve pickle "${finished.pickleId}" for a finished scenario — it will not be uploaded.`);
          }
        })
        .catch((err) => {
          // Mirrors onEnvelope's own catch — dispatch() itself can no longer
          // catch an error raised inside this deferred chain.
          logger.error('failed to process a cucumber-js event:', err);
        });
      this.pendingCaseBuilds.push(pending);
      return;
    }
    if (envelope.testRunHookStarted) {
      this.runHookTracker.start(envelope.testRunHookStarted);
      return;
    }
    if (envelope.testRunHookFinished) {
      this.runHookTracker.finish(envelope.testRunHookFinished, this.hookIndex);
      return;
    }
  }

  private onGherkinDocument(doc: GherkinDocument): void {
    this.gherkin.add(doc);
  }

  async finished(): Promise<void> {
    try {
      // Every scenario's Case must be fully built (attachments included,
      // any pending video upload settled) before the Collect payload is
      // assembled — see the testCaseFinished dispatch branch above.
      await Promise.all(this.pendingCaseBuilds);
      if (this.config.enabled) {
        await this.uploadResults();
      }
    } finally {
      await super.finished();
    }
  }

  private async uploadResults(): Promise<void> {
    const suites = groupIntoSuites(this.finishedCases, this.cwd, this.runHookTracker.buildSuite());
    if (suites.length === 0) {
      if (this.config.debug) {
        logger.debug(`no scenarios reported — skipping ${this.config.outputFile ? 'file write' : 'upload'}.`);
      }
      return;
    }
    const payload = buildCollectPayload(suites, this.config);

    // Sharded CI: write this process's own Collect JSON to disk instead of
    // POSTing it. A separate aggregation step (after all shards' files are
    // collected, e.g. via CI artifact download) merges them into one launch
    // via `qualflare-cli upload --shard <files...>` — see docs/LIMITATIONS.md.
    // No HTTP client is ever constructed in this mode; resolveConfig already
    // skipped the token-required check for the same reason.
    if (this.config.outputFile) {
      fs.writeFileSync(this.config.outputFile, JSON.stringify(payload));
      logger.info(
        `wrote Collect payload to ${this.config.outputFile} — not uploaded (outputFile mode). ` +
          'Merge shard files and upload once via `qualflare-cli upload --shard <files...>`.',
      );
      return;
    }

    const client = new QualflareHttpClient(buildHttpOptions(this.config));
    try {
      const result = await client.send(payload);
      if (this.config.debug) {
        logger.debug(`uploaded launch #${result.seq}.`);
      }
    } catch (err) {
      if (this.config.failOnUploadError) {
        throw err;
      }
      logger.error('failed to upload results to Qualflare:', err);
    }
  }
}
