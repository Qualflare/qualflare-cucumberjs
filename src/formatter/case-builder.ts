import type { Pickle } from '@cucumber/messages';

import { MAX_TAGS_PER_CASE } from '../shared/constants.js';
import { msToNs } from '../shared/duration.js';
import type { ManualStepRecord } from '../runtime/message-types.js';
import type { Attachment, Case, CasePriority, CaseStatus, Label, Link, NanosecondDuration, Step } from '../shared/types.js';
import type { GherkinIndex } from './gherkin-index.js';

/** One attempt of a scenario — cucumber-js's `--retry` re-runs the same
 * pickle from scratch (fresh World, all hooks/steps rerun); each attempt
 * (`testCaseStarted`→...→`testCaseFinished`) produces one of these. Ported
 * from `@qualflare/cypress`'s `AttemptSnapshot`/`collapseAttempts` — same
 * "final attempt wins for content, but count+sum across all attempts"
 * rules — fed by envelope-derived data here instead of Mocha-derived data. */
export interface AttemptSnapshot {
  status: CaseStatus;
  /** NANOSECONDS — already summed across this attempt's real step results;
   * see `attempt-tracker.ts`. No ms round-trip, unlike the Cypress version:
   * Cucumber's own `TestStepResult.duration` is nanosecond-precision. */
  duration: NanosecondDuration;
  error?: string;
  /** Real Gherkin + hook steps, already wire-shaped by `step-mapper.ts`. */
  steps: Step[];
  manualSteps: ManualStepRecord[];
  labels: Label[];
  links: Link[];
  /** Dynamically added via `qualflare.tag()` during this attempt — merged
   * with the pickle's own static `@tag`s separately, in `case-builder.ts`'s
   * `buildCase()`, since those are the same across every attempt. */
  tags: string[];
  description?: string;
  priority?: CasePriority;
  properties: Record<string, string>;
  attachments: Attachment[];
}

export interface CollapsedResult {
  status: CaseStatus;
  /** NANOSECONDS — sum of every attempt (reflects true CI wall-clock cost,
   * not just the final attempt's duration). */
  duration: NanosecondDuration;
  retryCount: number;
  isFlaky: boolean;
  error?: string;
  /** Only the FINAL attempt's steps — an abandoned (retried) attempt's step
   * trace would misrepresent a single execution as if the same commands ran
   * twice, so earlier attempts' steps are discarded, never merged. */
  steps?: Step[];
  labels: Label[];
  links: Link[];
  tags: string[];
  description?: string;
  priority?: CasePriority;
  properties: Record<string, string>;
  attachments: Attachment[];
}

/** Appends `manualSteps` (from `qualflare.step()`, indices/`parentIndex`
 * valid only relative to each other) after `realSteps` (Gherkin + hook
 * steps, indices/`parentIndex` valid only relative to each other) into one
 * combined, correctly-indexed `Step[]`. Ported verbatim in spirit from
 * `@qualflare/cypress`'s `combineSteps()`. */
function combineSteps(realSteps: Step[], manualSteps: ManualStepRecord[]): Step[] | undefined {
  if (realSteps.length === 0 && manualSteps.length === 0) {
    return undefined;
  }
  const offsetManual: Step[] = manualSteps.map((record) => {
    const step: Step = {
      name: record.name,
      status: record.status,
      duration: msToNs(record.durationMs ?? 0),
    };
    if (record.error) step.error = record.error;
    if (record.parentIndex !== undefined) step.parentIndex = record.parentIndex + realSteps.length;
    if (record.parameters && record.parameters.length > 0) step.parameters = record.parameters;
    return step;
  });
  return [...realSteps, ...offsetManual];
}

/**
 * Collapses every attempt of one logical scenario (grouped by cucumber-js's
 * own stable `testCase.id`, NOT a content hash — see `attempt-tracker.ts`)
 * into the single `Case` this reporter uploads. `willBeRetried === false` on
 * the final `testCaseFinished` is the caller's signal that all attempts have
 * arrived; this function only does the collapse.
 */
export function collapseAttempts(attempts: AttemptSnapshot[]): CollapsedResult {
  if (attempts.length === 0) {
    throw new Error('collapseAttempts: at least one attempt is required');
  }
  const final = attempts[attempts.length - 1]!;
  const retryCount = attempts.length - 1;
  const isFlaky = retryCount > 0 && final.status === 'passed' && attempts.some((a) => a.status !== 'passed');
  const duration = attempts.reduce((sum, a) => sum + a.duration, 0);

  return {
    status: final.status,
    duration,
    retryCount,
    isFlaky,
    error: final.status === 'passed' ? undefined : final.error,
    steps: combineSteps(final.steps, final.manualSteps),
    labels: final.labels,
    links: final.links,
    tags: final.tags,
    description: final.description,
    priority: final.priority,
    properties: final.properties,
    attachments: final.attachments,
  };
}

export interface FinishedCase {
  uri: string;
  case: Case;
}

/** Assembles the final wire `Case` for one finished (all-attempts-collapsed)
 * scenario. */
export function buildCase(uri: string, pickle: Pickle, collapsed: CollapsedResult, gherkin: GherkinIndex): FinishedCase {
  const entry = gherkin.get(uri);
  // `pickle.astNodeIds` is `[scenarioId]` for a plain Scenario, or
  // `[scenarioId, exampleRowId]` for one row of a Scenario Outline — the
  // scenario's own AST id is always first.
  const scenarioId = pickle.astNodeIds[0];
  const scenarioEntry = scenarioId ? entry?.scenarioById.get(scenarioId) : undefined;
  const featureName = entry?.featureName;
  const ruleName = scenarioEntry?.ruleName;
  const className = ruleName ? `${featureName ?? ''} > ${ruleName}` : featureName;

  const labels: Label[] = [...collapsed.labels];
  if (featureName) {
    labels.push({ name: 'feature', value: featureName });
  }
  if (ruleName) {
    labels.push({ name: 'rule', value: ruleName });
  }

  const properties: Record<string, string> = { ...examplesRowProperties(scenarioEntry, pickle), ...collapsed.properties };

  // `pickle.tags` already has Feature/Rule `@tag`s inherited/flattened onto
  // every scenario by cucumber-js itself — no manual inheritance needed.
  const staticTags = pickle.tags.map((t) => t.name.replace(/^@/, ''));
  const tags = [...new Set([...staticTags, ...collapsed.tags])].slice(0, MAX_TAGS_PER_CASE);

  const kase: Case = {
    // Stable across runs (unchanged unless the file is edited), and
    // includes the source line specifically so two identically-named
    // Scenarios in one feature file can never collide — the exact bug
    // that's open upstream in allure-js (allure-framework/allure-js#1502).
    id: `${uri}:${pickle.location?.line ?? 0}#${pickle.name}`,
    name: pickle.name,
    status: collapsed.status,
    duration: collapsed.duration,
    retryCount: collapsed.retryCount || undefined,
    isFlaky: collapsed.isFlaky || undefined,
    error: collapsed.error,
    tags: tags.length > 0 ? tags : undefined,
    steps: collapsed.steps,
    labels: labels.length > 0 ? labels : undefined,
    links: collapsed.links.length > 0 ? collapsed.links : undefined,
    // `||`, not `??`: cucumber-js's `Scenario.description` is always a
    // defined string, `''` when the Gherkin source has none — `??` would
    // never fall through and every scenario without one would send an
    // empty-string description instead of omitting the field (found via a
    // real tarball-installed smoke test, not just reasoning about types).
    description: collapsed.description || scenarioEntry?.scenario.description || undefined,
    priority: collapsed.priority,
    properties: Object.keys(properties).length > 0 ? properties : undefined,
    attachments: collapsed.attachments.length > 0 ? collapsed.attachments : undefined,
  };
  if (className) {
    kase.className = className;
  }
  return { uri, case: kase };
}

/** For a Scenario Outline row, folds that row's concrete Examples values
 * into `Case.properties` (`{columnName: cellValue}`) — the same AST
 * `tableBody`-correlation technique verified in `allure-cucumberjs`'s real
 * source. Every row's values show up on that row's Case automatically, with
 * zero extra author effort. */
function examplesRowProperties(
  scenarioEntry: { scenario: { examples: readonly { tableHeader?: { cells: readonly { value: string }[] }; tableBody: readonly { id: string; cells: readonly { value: string }[] }[] }[] } } | undefined,
  pickle: Pickle,
): Record<string, string> {
  if (!scenarioEntry) {
    return {};
  }
  const rowAstIds = new Set(pickle.astNodeIds);
  for (const examples of scenarioEntry.scenario.examples) {
    const header = examples.tableHeader?.cells;
    if (!header) {
      continue;
    }
    const row = examples.tableBody.find((r) => rowAstIds.has(r.id));
    if (!row) {
      continue;
    }
    const properties: Record<string, string> = {};
    header.forEach((cell, i) => {
      const value = row.cells[i]?.value;
      if (cell.value && value !== undefined) {
        properties[cell.value] = value;
      }
    });
    return properties;
  }
  return {};
}
