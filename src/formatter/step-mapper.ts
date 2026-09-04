import { TestStepResultStatus, type PickleStep, type PickleStepArgument, type TestStepResult } from '@cucumber/messages';

import { messageDurationToNs } from '../shared/duration.js';
import type { CaseStatus, Parameter, Step } from '../shared/types.js';
import type { GherkinIndex } from './gherkin-index.js';
import type { HookInfo } from './hook-index.js';

/** Maps cucumber-js's step/scenario result status onto the wire contract's
 * `CaseStatus` vocabulary. `UNDEFINED` (no matching step definition) and
 * `AMBIGUOUS` (more than one matching definition) are both authoring/config
 * problems rather than a real pass/fail outcome — `'error'` is the closest
 * semantic fit in the wire vocabulary, distinct from a genuine `'failed'`
 * assertion. */
export function mapStatus(status: TestStepResultStatus): CaseStatus {
  switch (status) {
    case TestStepResultStatus.PASSED:
      return 'passed';
    case TestStepResultStatus.FAILED:
      return 'failed';
    case TestStepResultStatus.SKIPPED:
      return 'skipped';
    case TestStepResultStatus.PENDING:
      return 'pending';
    case TestStepResultStatus.UNDEFINED:
    case TestStepResultStatus.AMBIGUOUS:
    case TestStepResultStatus.UNKNOWN:
    default:
      return 'error';
  }
}

/** `TestStepResult.message` is the version-safe field to prefer: verified
 * empirically (real spawned runs, not just docs) that it reliably contains
 * the full "Error: &lt;message&gt;\n    at ..." text on both the peer floor
 * (cucumber-js 10.9.0) and the latest (13.2.1) — `exception.stackTrace`
 * does NOT: on 10.9.0 it's stack-frames only, with no message text at all,
 * while on 13.2.1 it happens to duplicate the full combined text. Preferring
 * `stackTrace` first (an earlier version of this function did) silently
 * produced a message-less error on 10.9.0 — caught by running the real CI
 * version matrix locally before trusting it, not by reasoning about the
 * schema alone. */
function formatError(result: TestStepResult): string | undefined {
  return result.message || result.exception?.stackTrace || result.exception?.message;
}

/** Doc Strings and Data Tables have no dedicated field on the wire `Step`
 * contract (confirmed against `launch.go` — the only structured-payload slot on
 * a step is the flat `parameters` list), so each is encoded as a Parameter.
 *
 * Every value survives the trip; what the flat slot costs is presentation, not
 * data — a table arrives as JSON rather than a rendered grid. A dedicated wire
 * field plus UI rendering is the real fix, and it is a platform change, not one
 * this reporter can make.
 *
 * A Data Table is JSON-stringified as ONE Parameter rather than exploded into
 * one per cell: a 20x5 table would be 100 parameters and blow
 * `MAX_PARAMETERS_PER_STEP`, taking the step's real parameters with it. */
export function pickleStepArgumentToParameters(argument: PickleStepArgument | undefined): Parameter[] | undefined {
  if (!argument) {
    return undefined;
  }
  const params: Parameter[] = [];
  if (argument.docString) {
    params.push({ name: 'docString', value: argument.docString.content });
    // Gherkin lets a Doc String declare its media type (the `json` in
    // `"""json`), and PickleDocString carries it. Reading only `content`
    // discarded it outright — a small loss, but a real one rather than a
    // rendering difference: it is the hint a viewer would syntax-highlight by,
    // and nothing downstream could recover it. Emitted as its own Parameter
    // only when present, so a Doc String without one is unchanged.
    if (argument.docString.mediaType) {
      params.push({ name: 'docStringMediaType', value: argument.docString.mediaType });
    }
  }
  if (argument.dataTable) {
    const rows = argument.dataTable.rows.map((row) => row.cells.map((cell) => cell.value));
    params.push({ name: 'dataTable', value: JSON.stringify(rows) });
  }
  return params.length > 0 ? params : undefined;
}

/** Builds a wire `Step` for a real Gherkin (Given/When/Then/And/But) step. */
export function mapPickleStep(
  uri: string,
  pickleStep: PickleStep,
  result: TestStepResult,
  gherkin: GherkinIndex,
): Step {
  const resolved = gherkin.resolveKeyword(uri, pickleStep.astNodeIds);
  const step: Step = {
    name: pickleStep.text,
    status: mapStatus(result.status),
    duration: messageDurationToNs(result.duration),
  };
  if (resolved?.keyword) {
    step.keyword = resolved.keyword.trim();
  }
  const error = formatError(result);
  if (error) {
    step.error = error;
  }
  const parameters = pickleStepArgumentToParameters(pickleStep.argument);
  if (parameters) {
    step.parameters = parameters;
  }
  return step;
}

/** Builds a synthetic wire `Step` for a `Before`/`After` (or, when enabled,
 * `BeforeStep`/`AfterStep`) hook execution — see design decision (a) in the
 * plan: hooks are folded directly into the flat/nested `Step[]` rather than
 * needing a separate "fixture" model concept the way Allure's richer model
 * requires, since our wire contract has no such concept anyway. */
const HOOK_LABELS: Record<HookInfo['kind'], string> = {
  before: 'Before',
  after: 'After',
  beforeStep: 'BeforeStep',
  afterStep: 'AfterStep',
  beforeAll: 'BeforeAll',
  afterAll: 'AfterAll',
};

export function mapHookStep(hook: HookInfo, result: TestStepResult): Step {
  // A distinct label per hook kind (not just "Before"/"After" for
  // everything) so a step-level hook is distinguishable from a case-level
  // one in the uploaded data when `includeStepHooks` is enabled.
  const label = HOOK_LABELS[hook.kind];
  const step: Step = {
    name: hook.name || `${label} hook`,
    keyword: label,
    status: mapStatus(result.status),
    duration: messageDurationToNs(result.duration),
  };
  const error = formatError(result);
  if (error) {
    step.error = error;
  }
  return step;
}
