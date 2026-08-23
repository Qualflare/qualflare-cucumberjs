import { describe, expect, it } from 'vitest';

import { buildHookIndex } from '../../src/formatter/hook-index.js';

function fakeSupportCodeLibrary(overrides: Record<string, { id: string; name?: string }[]> = {}) {
  return {
    beforeTestCaseHookDefinitions: overrides.before ?? [],
    afterTestCaseHookDefinitions: overrides.after ?? [],
    beforeTestStepHookDefinitions: overrides.beforeStep ?? [],
    afterTestStepHookDefinitions: overrides.afterStep ?? [],
    beforeTestRunHookDefinitions: overrides.beforeAll ?? [],
    afterTestRunHookDefinitions: overrides.afterAll ?? [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- only the six hook arrays above matter for this index; the real type has many more fields
  } as any;
}

describe('buildHookIndex', () => {
  it('resolves each of the six hook kinds from its own supportCodeLibrary array — NOT the envelope Hook.type field', () => {
    const lib = fakeSupportCodeLibrary({
      before: [{ id: 'b1', name: 'my before' }],
      after: [{ id: 'a1' }],
      beforeStep: [{ id: 'bs1' }],
      afterStep: [{ id: 'as1' }],
      beforeAll: [{ id: 'ba1' }],
      afterAll: [{ id: 'aa1' }],
    });
    const index = buildHookIndex(lib);

    expect(index.get('b1')).toEqual({ kind: 'before', name: 'my before' });
    expect(index.get('a1')).toEqual({ kind: 'after', name: undefined });
    expect(index.get('bs1')).toEqual({ kind: 'beforeStep' });
    expect(index.get('as1')).toEqual({ kind: 'afterStep' });
    expect(index.get('ba1')).toEqual({ kind: 'beforeAll' });
    expect(index.get('aa1')).toEqual({ kind: 'afterAll' });
  });

  it('returns undefined for an unknown hook id', () => {
    const index = buildHookIndex(fakeSupportCodeLibrary());
    expect(index.get('nope')).toBeUndefined();
  });

  it('normalizes an empty-string hook name to undefined, not ""', () => {
    const lib = fakeSupportCodeLibrary({ before: [{ id: 'b1', name: '' }] });
    expect(buildHookIndex(lib).get('b1')?.name).toBeUndefined();
  });
});
