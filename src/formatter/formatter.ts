import { Formatter, type IFormatterOptions } from '@cucumber/cucumber';
import type { Envelope, GherkinDocument, Pickle, TestCase } from '@cucumber/messages';

import { resolveConfig, type QualflareCucumberOptions, type ResolvedFormatterConfig } from '../config/resolve-config.js';
import { QualflareHttpClient } from '../http/client.js';
import { logger } from '../shared/logger.js';
import { PACKAGE_VERSION } from '../config/version.js';
import { AttachmentBudget } from './attachment-budget.js';
import { AttemptTracker } from './attempt-tracker.js';
import { buildCase, type FinishedCase } from './case-builder.js';
import { buildCollectPayload } from './collect-builder.js';
import { GherkinIndex } from './gherkin-index.js';
import { buildHookIndex, type HookIndex } from './hook-index.js';
import { RunHookTracker } from './run-hook-tracker.js';
import { groupIntoSuites } from './suite-builder.js';

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

  constructor(options: IFormatterOptions) {
    super(options);
    // cucumber-js's `formatOptions` is untyped (`FormatOptions` has only an
    // index signature) — the shape is a contract between the user's config
    // and this formatter, not something cucumber-js itself validates.
    this.config = resolveConfig(options.parsedArgvOptions as QualflareCucumberOptions);
    this.hookIndex = buildHookIndex(options.supportCodeLibrary);
    this.attachmentBudget = new AttachmentBudget(this.config.maxTotalAttachmentBytes);
    this.attemptTracker = new AttemptTracker(this.hookIndex, this.gherkin, this.config, this.attachmentBudget);

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
      const finished = this.attemptTracker.finish(envelope.testCaseFinished);
      if (finished) {
        const pickle = this.pickleIndex.get(finished.pickleId);
        if (pickle) {
          this.finishedCases.push(buildCase(finished.uri, pickle, finished.collapsed, this.gherkin));
        } else {
          logger.warn(`could not resolve pickle "${finished.pickleId}" for a finished scenario — it will not be uploaded.`);
        }
      }
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
        logger.debug('no scenarios reported — skipping upload.');
      }
      return;
    }
    const payload = buildCollectPayload(suites, this.config);
    const client = new QualflareHttpClient({
      endpoint: this.config.apiEndpoint,
      token: this.config.token,
      timeoutMs: this.config.timeoutMs,
      retry: this.config.retry,
      userAgent: `qualflare-cucumberjs/${PACKAGE_VERSION}`,
      debug: this.config.debug,
    });
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
