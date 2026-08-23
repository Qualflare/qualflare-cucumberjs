import { TestStepResultStatus } from '@cucumber/messages';
import { describe, expect, it } from 'vitest';

import { mapStatus, pickleStepArgumentToParameters } from '../../src/formatter/step-mapper.js';

describe('mapStatus', () => {
  it('maps the four self-explanatory statuses directly', () => {
    expect(mapStatus(TestStepResultStatus.PASSED)).toBe('passed');
    expect(mapStatus(TestStepResultStatus.FAILED)).toBe('failed');
    expect(mapStatus(TestStepResultStatus.SKIPPED)).toBe('skipped');
    expect(mapStatus(TestStepResultStatus.PENDING)).toBe('pending');
  });

  it('maps UNDEFINED and AMBIGUOUS (config/authoring problems, not real pass/fail) to "error"', () => {
    expect(mapStatus(TestStepResultStatus.UNDEFINED)).toBe('error');
    expect(mapStatus(TestStepResultStatus.AMBIGUOUS)).toBe('error');
  });

  it('maps UNKNOWN to "error" as a defensive fallback', () => {
    expect(mapStatus(TestStepResultStatus.UNKNOWN)).toBe('error');
  });
});

describe('pickleStepArgumentToParameters', () => {
  it('returns undefined when there is no argument at all', () => {
    expect(pickleStepArgumentToParameters(undefined)).toBeUndefined();
  });

  it('encodes a Doc String as a single "docString" Parameter — no dedicated wire field exists', () => {
    const params = pickleStepArgumentToParameters({ docString: { content: 'hello world', mediaType: undefined, argumentIndex: 0 } });
    expect(params).toEqual([{ name: 'docString', value: 'hello world' }]);
  });

  it('encodes a Data Table as a single JSON-stringified "dataTable" Parameter, not one Parameter per cell', () => {
    const params = pickleStepArgumentToParameters({
      dataTable: {
        rows: [
          { cells: [{ value: 'name' }, { value: 'role' }] },
          { cells: [{ value: 'Alice' }, { value: 'admin' }] },
        ],
      },
    });
    expect(params).toHaveLength(1);
    expect(params![0]!.name).toBe('dataTable');
    expect(JSON.parse(params![0]!.value!)).toEqual([
      ['name', 'role'],
      ['Alice', 'admin'],
    ]);
  });

  it('encodes both a Doc String and a Data Table when a (contrived) step somehow has both', () => {
    const params = pickleStepArgumentToParameters({
      docString: { content: 'text', argumentIndex: 0 },
      dataTable: { rows: [{ cells: [{ value: 'a' }] }] },
    });
    expect(params).toHaveLength(2);
    expect(params!.map((p) => p.name)).toEqual(['docString', 'dataTable']);
  });
});
