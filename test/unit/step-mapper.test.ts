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

  // Gherkin lets a Doc String declare a media type (the `json` opening a
  // triple-quoted block), and PickleDocString carries it. Reading only
  // `content` discarded it -- a real loss rather than a rendering difference,
  // since nothing downstream could recover the hint a viewer would
  // syntax-highlight by.
  it('preserves a Doc String media type when one is declared', () => {
    const params = pickleStepArgumentToParameters({
      docString: { content: '{"id":42}', mediaType: 'json', argumentIndex: 0 },
    } as never);
    expect(params).toEqual([
      { name: 'docString', value: '{"id":42}' },
      { name: 'docStringMediaType', value: 'json' },
    ]);
  });

  it('emits no media-type Parameter when the Doc String declares none', () => {
    const params = pickleStepArgumentToParameters({ docString: { content: 'plain', argumentIndex: 0 } } as never);
    expect(params).toEqual([{ name: 'docString', value: 'plain' }]);
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
