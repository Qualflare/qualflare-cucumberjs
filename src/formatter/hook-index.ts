import type { IFormatterOptions } from '@cucumber/cucumber';

// `SupportCodeLibrary` itself isn't re-exported from the package's public
// entry point (only reachable via a deep `lib/**` import, which the
// package's exports map only allows for `require`, not `import` — this
// package is ESM-first). Deriving the type via indexed access on the
// already-public `IFormatterOptions` avoids that deep import entirely.
type SupportCodeLibrary = IFormatterOptions['supportCodeLibrary'];

export type HookKind = 'before' | 'after' | 'beforeStep' | 'afterStep' | 'beforeAll' | 'afterAll';

export interface HookInfo {
  kind: HookKind;
  name?: string;
}

export type HookIndex = ReadonlyMap<string, HookInfo>;

/**
 * Resolves a hook's kind from `supportCodeLibrary`'s six definition-array
 * fields, NOT the envelope's `Hook.type` — that field was only added in
 * cucumber-js 11.2.0 (confirmed via the project's own CHANGELOG), which is
 * after this package's peer floor (`>=10.8.0`). This is also exactly the
 * mechanism `allure-cucumberjs`'s real source uses for `Before`/`After`
 * (though it never indexes the `TestStep`/`TestRunHook` collections at all,
 * which is why it silently drops `BeforeStep`/`AfterStep` and never handles
 * `BeforeAll`/`AfterAll` — this package intentionally indexes all six).
 */
export function buildHookIndex(supportCodeLibrary: SupportCodeLibrary): HookIndex {
  const index = new Map<string, HookInfo>();
  for (const def of supportCodeLibrary.beforeTestCaseHookDefinitions) {
    index.set(def.id, { kind: 'before', name: def.name || undefined });
  }
  for (const def of supportCodeLibrary.afterTestCaseHookDefinitions) {
    index.set(def.id, { kind: 'after', name: def.name || undefined });
  }
  for (const def of supportCodeLibrary.beforeTestStepHookDefinitions) {
    index.set(def.id, { kind: 'beforeStep' });
  }
  for (const def of supportCodeLibrary.afterTestStepHookDefinitions) {
    index.set(def.id, { kind: 'afterStep' });
  }
  for (const def of supportCodeLibrary.beforeTestRunHookDefinitions) {
    index.set(def.id, { kind: 'beforeAll' });
  }
  for (const def of supportCodeLibrary.afterTestRunHookDefinitions) {
    index.set(def.id, { kind: 'afterAll' });
  }
  return index;
}
