import type { HookIndex, HookInfo } from '../../../src/formatter/hook-index.js';

/** Builds a `HookIndex` directly from `{id, kind, name?}` entries, bypassing
 * `buildHookIndex()`'s real `SupportCodeLibrary` input (tedious to construct
 * by hand) — used by tests that only care about hook *resolution*, not
 * `SupportCodeLibrary`'s own shape. `buildHookIndex()` itself is covered by
 * `hook-index.test.ts` against a minimal real-shaped `SupportCodeLibrary`. */
export function buildHookIndexFromRaw(entries: (HookInfo & { id: string })[]): HookIndex {
  const index = new Map<string, HookInfo>();
  for (const { id, ...info } of entries) {
    index.set(id, info);
  }
  return index;
}
