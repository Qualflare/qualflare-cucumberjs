import * as path from 'node:path';

import { MAX_CASES_PER_SUITE, MAX_SUITES_PER_LAUNCH } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { Case, Suite } from '../shared/types.js';
import type { FinishedCase } from './case-builder.js';

/**
 * Groups every finished Case into one `Suite` per `.feature` file. Unlike
 * `@qualflare/cypress` (which can batch incrementally, one spec file at a
 * time, since Cypress runs specs sequentially in one process),
 * cucumber-js can interleave scenarios from different feature files even
 * without `--parallel`, and always runs the formatter in the coordinator
 * process either way (worker *threads* under `--parallel` ship envelopes
 * back to it) — so grouping happens once, at `finished()`, over the whole
 * run's flat list of finished cases.
 */
export function groupIntoSuites(cases: FinishedCase[], cwd: string, extraSuite?: Suite): Suite[] {
  const byUri = new Map<string, Case[]>();
  for (const { uri, case: kase } of cases) {
    const bucket = byUri.get(uri);
    if (bucket) {
      bucket.push(kase);
    } else {
      byUri.set(uri, [kase]);
    }
  }

  const suites: Suite[] = [];
  for (const [uri, kases] of byUri) {
    if (kases.length > MAX_CASES_PER_SUITE) {
      logger.warn(
        `feature file "${uri}" reported ${kases.length} scenarios — only the first ${MAX_CASES_PER_SUITE} will be uploaded (server cap).`,
      );
    }
    suites.push({
      name: relativizeUri(uri, cwd),
      category: 'bdd',
      duration: kases.reduce((sum, c) => sum + c.duration, 0),
      cases: kases.slice(0, MAX_CASES_PER_SUITE),
    });
  }

  if (extraSuite) {
    suites.push(extraSuite);
  }

  if (suites.length > MAX_SUITES_PER_LAUNCH) {
    logger.warn(
      `this run reported ${suites.length} feature-file suites — only the first ${MAX_SUITES_PER_LAUNCH} will be uploaded (server cap).`,
    );
  }
  return suites.slice(0, MAX_SUITES_PER_LAUNCH);
}

/** cucumber-js's own `pickle.uri` is already relative to the invocation cwd
 * in the common case (confirmed empirically: a real run reports e.g.
 * `"features/passing.feature"`, not an absolute path or a `file://` URL) —
 * this only normalizes the rarer absolute-path/URL forms down to the same
 * shape. */
function relativizeUri(uri: string, cwd: string): string {
  let normalized = uri;
  if (normalized.startsWith('file://')) {
    normalized = new URL(normalized).pathname;
  }
  if (path.isAbsolute(normalized)) {
    normalized = path.relative(cwd, normalized);
  }
  return normalized.split(path.sep).join('/');
}
