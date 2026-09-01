import { randomUUID } from 'node:crypto';

import { MAX_VIDEO_UPLOAD_BYTES } from '../shared/constants.js';
import type { Platform } from '../shared/types.js';
import { detectCi, type CiMetadata } from './ci-detect.js';
import { detectGit, type GitInfo } from './git-detect.js';

/** Options passed via the `--format-options`/`formatOptions` value the user
 * configures for `@qualflare/cucumberjs/formatter` (e.g. in `cucumber.js` /
 * `cucumber.json`). Every field here also has an environment-variable
 * override — see the precedence table in the README / plan. */
export interface QualflareCucumberOptions {
  environment?: string;
  language?: string;
  milestone?: number | null;
  branch?: string | null;
  commit?: string | null;
  platform?: Platform;
  framework?: string;
  os?: string;
  browser?: string;
  properties?: Record<string, string>;
  /** Max 64 chars. Free text, no enum — an unrecognized CI provider must
   * never be rejected. Auto-detected via `ci-detect.ts` when omitted. */
  ciProvider?: string;
  ciBuildNumber?: string;
  ciRunUrl?: string;
  ciPrNumber?: number;
  /** Identifier shared by every shard of one run, written into the report as
   * `metadata.runId`. `qualflare-cli collect` groups files by it and refuses
   * to merge a stale report from an earlier run into this launch.
   *
   * Auto-detected from CI. Outside CI it falls back to a per-process UUID,
   * which is correct there: every local run is a distinct run, so a leftover
   * file is still caught. */
  runId?: string;
  attachScreenshots?: boolean;
  /** Include `BeforeStep`/`AfterStep` hook executions as synthetic steps.
   * Off by default — these run once per Gherkin step and can multiply the
   * step count several-fold for suites with global per-step instrumentation
   * hooks (e.g. a screenshot-after-every-step hook), which is noisy as a
   * default but valuable as an explicit opt-in. */
  includeStepHooks?: boolean;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
  /** Per-video byte cap, checked before the file is written. Default 50MB,
   * matching the server's own hard cap. */
  maxVideoBytes?: number;
  debug?: boolean;
  /** `false` fully disables accumulation/upload (a complete no-op) but the
   * formatter still no-ops cleanly rather than throwing. */
  enabled?: boolean;
  /** Directory `finished()` writes this process's report file (and any
   * video attachments) into. Default `./qualflare-results`. Always active —
   * this formatter never uploads anything itself; `qualflare-cli` reads
   * whatever ends up in this directory. Every JSON file this process writes
   * is uniquely named, so multiple shards can safely share one `outputDir`
   * without colliding — see docs/LIMITATIONS.md. */
  outputDir?: string;
  /** This process's 0-based position among parallel shards of the same CI
   * run, stamped onto every case it reports. Purely a label: `qualflare-cli`
   * merges by "every file in the directory", not by this value, so an
   * unset shardIndex costs attribution, never correctness.
   *
   * Auto-detected, in order: `QUALFLARE_SHARD_INDEX`, then a best-effort
   * scan of `process.argv` for cucumber-js's own `--shard INDEX/TOTAL`
   * (whose index is 1-based, so it is converted). cucumber-js routes that
   * flag to `configuration.sources.shard`, and a formatter is only ever
   * handed `configuration.options` — so argv is the only place a formatter
   * can observe it, and only when it was passed on the command line rather
   * than via a config file. */
  shardIndex?: number;
}

export interface ResolvedFormatterConfig {
  environment: string;
  language: string;
  milestone: number | null;
  branch: string | null;
  commit: string | null;
  platform: Platform;
  framework: string;
  os?: string;
  browser?: string;
  properties?: Record<string, string>;
  ciProvider?: string;
  ciBuildNumber?: string;
  ciRunUrl?: string;
  ciPrNumber?: number;
  runId: string;
  attachScreenshots: boolean;
  includeStepHooks: boolean;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
  maxVideoBytes: number;
  debug: boolean;
  enabled: boolean;
  outputDir: string;
  shardIndex?: number;
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

function envBool(...names: string[]): boolean | undefined {
  const raw = firstEnv(...names);
  if (raw === undefined) {
    return undefined;
  }
  return raw === 'true' || raw === '1';
}

function envInt(...names: string[]): number | undefined {
  const raw = firstEnv(...names);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Best-effort read of cucumber-js's own `--shard INDEX/TOTAL` flag from
 * `process.argv`, returned 0-based.
 *
 * cucumber-js does parse this flag, but routes it to
 * `configuration.sources.shard`, while a formatter is only ever handed
 * `configuration.options` (see `api/formatters.js`) — so there is no
 * supported API for a formatter to read it. argv is the one place it is
 * observable, and only when the user passed it on the command line rather
 * than via a `cucumber.js` config file; that is why this sits BELOW
 * `QUALFLARE_SHARD_INDEX` in precedence rather than replacing it.
 *
 * cucumber documents the flag's index as 1-based ("The index starts at 1")
 * and normalizes it internally with `parseInt(idx) - 1`; we match that, so
 * `--shard 1/3` is shard 0. A malformed value yields `undefined` rather
 * than a wrong shard label — cucumber validates the same `<n>/<n>` shape
 * and would already have rejected it. */
function argvShardIndex(argv: readonly string[] = process.argv): number | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    const raw = arg === '--shard' ? argv[i + 1] : arg.startsWith('--shard=') ? arg.slice('--shard='.length) : undefined;
    if (raw === undefined) {
      continue;
    }
    if (!/^\d+\/\d+$/.test(raw)) {
      return undefined;
    }
    const oneBased = Number.parseInt(raw.split('/')[0] ?? '', 10);
    return Number.isFinite(oneBased) && oneBased >= 1 ? oneBased - 1 : undefined;
  }
  return undefined;
}

/** Resolves the full formatter configuration from, in order: the explicit
 * `options` (the formatter's own `formatOptions`), then `QUALFLARE_*`
 * environment variables, then `QF_*` (compat alias with the existing Go
 * CLI, where an equivalent exists), then a hardcoded default.
 *
 * Branch/commit precedence: `options.branch`/`.commit` (including an
 * explicit `null`, which is respected as "no auto-detection wanted" rather
 * than triggering the fallback tiers below it) > `QUALFLARE_BRANCH`/
 * `QF_BRANCH` env (and the commit equivalent) > CI-provider env vars > a
 * local `git` subprocess (`git-detect.ts`) > `null`. The subprocess tier is
 * skipped entirely — no `git` process is forked — once both branch and
 * commit are already resolved from options/env, mirroring
 * `qualflare-cli/internal/config/config.go`'s `DetectGit`'s early return.
 *
 * CI-metadata precedence (`ciProvider`/`ciBuildNumber`/`ciRunUrl`/
 * `ciPrNumber`): the corresponding `options.ci*` field, else `ci-detect.ts`'s
 * auto-detection (per-provider extraction table, falling back to the
 * `ci-info` package's ~70-provider free-text name).
 *
 * `deps` lets tests inject fake `detectGit`/`detectCi` implementations
 * instead of the real ones (which shell out to `git` and read the real
 * `process.env`/`ci-info` module state) — defaults to the real detectors,
 * so every production call site (the formatter's constructor calls
 * `resolveConfig(options)` with no second argument) is unaffected.
 */
export function resolveConfig(
  options: QualflareCucumberOptions,
  deps: { detectGit?: () => GitInfo; detectCi?: () => CiMetadata } = {},
): ResolvedFormatterConfig {
  const doDetectGit = deps.detectGit ?? detectGit;
  const doDetectCi = deps.detectCi ?? detectCi;

  const enabled = options.enabled ?? envBool('QUALFLARE_ENABLED') ?? true;
  // `||`, not `??` — matching `environment`/`language` below: an explicit
  const outputDir = options.outputDir || firstEnv('QUALFLARE_OUTPUT_DIR') || './qualflare-results';
  const shardIndex = options.shardIndex ?? envInt('QUALFLARE_SHARD_INDEX') ?? argvShardIndex();

  const milestoneRaw = options.milestone !== undefined ? options.milestone : envInt('QUALFLARE_MILESTONE', 'QF_MILESTONE');
  const milestone = milestoneRaw !== undefined && milestoneRaw !== null && milestoneRaw >= 1 ? milestoneRaw : null;

  const envBranch = firstEnv('QUALFLARE_BRANCH', 'QF_BRANCH');
  const envCommit = firstEnv('QUALFLARE_COMMIT', 'QF_COMMIT');
  const needsGitDetection =
    (options.branch === undefined && envBranch === undefined) ||
    (options.commit === undefined && envCommit === undefined);
  const detectedGit = needsGitDetection ? doDetectGit() : {};

  const branch = options.branch !== undefined ? options.branch : (envBranch ?? detectedGit.branch ?? null);
  const commit = options.commit !== undefined ? options.commit : (envCommit ?? detectedGit.commit ?? null);

  const detectedCi = doDetectCi();
  const ciProvider = options.ciProvider ?? detectedCi.ciProvider;
  const ciBuildNumber = options.ciBuildNumber ?? detectedCi.ciBuildNumber;
  const ciRunUrl = options.ciRunUrl ?? detectedCi.ciRunUrl;
  const ciPrNumber = options.ciPrNumber ?? detectedCi.ciPrNumber;

  // Never empty on purpose: `qf collect` treats a report with no runId as
  // "unknown run" and never lets it block a merge, so defaulting to '' would
  // quietly opt local runs out of the very check this exists for.
  const runId = options.runId ?? firstEnv('QUALFLARE_RUN_ID') ?? detectedCi.ciRunId ?? randomUUID();

  return {
    // `||` (truthy check), not `??`, for these three REQUIRED-non-empty wire
    // fields — an explicit `''` option must not silently win over the
    // default (the server rejects an empty `environment`). Ported verbatim from
    // qualflare-cypress, where this was found via deep adversarial review.
    environment: (options.environment || undefined) ?? firstEnv('QUALFLARE_ENVIRONMENT', 'QF_ENVIRONMENT') ?? 'development',
    language: (options.language || undefined) ?? firstEnv('QUALFLARE_LANGUAGE', 'QF_LANGUAGE') ?? 'en-US',
    milestone,
    branch,
    commit,
    platform: options.platform ?? 'web',
    framework: options.framework || 'cucumber',
    os: options.os,
    browser: options.browser,
    properties: options.properties,
    ciProvider,
    ciBuildNumber,
    ciRunUrl,
    ciPrNumber,
    runId,
    attachScreenshots: options.attachScreenshots ?? envBool('QUALFLARE_ATTACH_SCREENSHOTS') ?? true,
    includeStepHooks: options.includeStepHooks ?? envBool('QUALFLARE_INCLUDE_STEP_HOOKS') ?? false,
    maxAttachmentBytes: options.maxAttachmentBytes ?? envInt('QUALFLARE_MAX_ATTACHMENT_BYTES') ?? 1_500_000,
    maxTotalAttachmentBytes:
      options.maxTotalAttachmentBytes ?? envInt('QUALFLARE_MAX_TOTAL_ATTACHMENT_BYTES') ?? 750_000,
    maxVideoBytes: options.maxVideoBytes ?? envInt('QUALFLARE_MAX_VIDEO_BYTES') ?? MAX_VIDEO_UPLOAD_BYTES,
    debug: options.debug ?? envBool('QUALFLARE_DEBUG', 'QF_DEBUG') ?? false,
    enabled,
    outputDir,
    shardIndex,
  };
}
