import { describe, expect, it } from 'vitest';

import { GherkinIndex } from '../../src/formatter/gherkin-index.js';

const LOCATION = { line: 1, column: 1 };

function step(id: string, keyword: string, text: string) {
  return { id, keyword, keywordType: 'Context', text, location: LOCATION };
}

describe('GherkinIndex', () => {
  it('resolves a literal keyword for a plain (non-Rule) scenario step', () => {
    const gherkin = new GherkinIndex();
    gherkin.add({
      uri: 'features/a.feature',
      comments: [],
      feature: {
        location: LOCATION,
        tags: [],
        language: 'en',
        keyword: 'Feature',
        name: 'My Feature',
        description: '',
        children: [
          {
            scenario: {
              location: LOCATION,
              tags: [],
              keyword: 'Scenario',
              name: 'a scenario',
              description: '',
              id: 'scenario-1',
              examples: [],
              steps: [step('step-1', 'Given ', 'a precondition')],
            },
          },
        ],
      },
    });

    expect(gherkin.resolveKeyword('features/a.feature', ['step-1'])).toEqual({ keyword: 'Given ', text: 'a precondition' });
    expect(gherkin.get('features/a.feature')?.featureName).toBe('My Feature');
    expect(gherkin.get('features/a.feature')?.scenarioById.get('scenario-1')).toEqual({
      scenario: expect.objectContaining({ id: 'scenario-1' }),
    });
  });

  it('indexes Background steps into the same stepMap as regular scenario steps — no special handling needed', () => {
    const gherkin = new GherkinIndex();
    gherkin.add({
      uri: 'features/a.feature',
      comments: [],
      feature: {
        location: LOCATION,
        tags: [],
        language: 'en',
        keyword: 'Feature',
        name: 'F',
        description: '',
        children: [
          {
            background: {
              location: LOCATION,
              keyword: 'Background',
              name: '',
              description: '',
              id: 'bg-1',
              steps: [step('bg-step-1', 'Given ', 'a shared setup step')],
            },
          },
          {
            scenario: {
              location: LOCATION,
              tags: [],
              keyword: 'Scenario',
              name: 's',
              description: '',
              id: 'scenario-1',
              examples: [],
              steps: [step('step-1', 'When ', 'an action')],
            },
          },
        ],
      },
    });

    expect(gherkin.resolveKeyword('features/a.feature', ['bg-step-1'])).toEqual({
      keyword: 'Given ',
      text: 'a shared setup step',
    });
  });

  it('records a Rule name for a scenario nested inside a Rule, distinct from a top-level scenario', () => {
    const gherkin = new GherkinIndex();
    gherkin.add({
      uri: 'features/a.feature',
      comments: [],
      feature: {
        location: LOCATION,
        tags: [],
        language: 'en',
        keyword: 'Feature',
        name: 'F',
        description: '',
        children: [
          {
            rule: {
              location: LOCATION,
              tags: [],
              keyword: 'Rule',
              name: 'My Rule',
              description: '',
              id: 'rule-1',
              children: [
                {
                  scenario: {
                    location: LOCATION,
                    tags: [],
                    keyword: 'Scenario',
                    name: 'ruled scenario',
                    description: '',
                    id: 'scenario-in-rule',
                    examples: [],
                    steps: [],
                  },
                },
              ],
            },
          },
          {
            scenario: {
              location: LOCATION,
              tags: [],
              keyword: 'Scenario',
              name: 'top-level scenario',
              description: '',
              id: 'scenario-top',
              examples: [],
              steps: [],
            },
          },
        ],
      },
    });

    const entry = gherkin.get('features/a.feature')!;
    expect(entry.scenarioById.get('scenario-in-rule')?.ruleName).toBe('My Rule');
    expect(entry.scenarioById.get('scenario-top')?.ruleName).toBeUndefined();
  });

  it('returns undefined for a uri that was never added', () => {
    const gherkin = new GherkinIndex();
    expect(gherkin.get('nope')).toBeUndefined();
    expect(gherkin.resolveKeyword('nope', ['x'])).toBeUndefined();
  });

  it('walks astNodeIds to find the first id present in stepMap, skipping ones that are not', () => {
    const gherkin = new GherkinIndex();
    gherkin.add({
      uri: 'features/a.feature',
      comments: [],
      feature: {
        location: LOCATION,
        tags: [],
        language: 'en',
        keyword: 'Feature',
        name: 'F',
        description: '',
        children: [
          {
            scenario: {
              location: LOCATION,
              tags: [],
              keyword: 'Scenario',
              name: 's',
              description: '',
              id: 'scenario-1',
              examples: [],
              steps: [step('step-1', 'Then ', 'an outcome')],
            },
          },
        ],
      },
    });

    expect(gherkin.resolveKeyword('features/a.feature', ['unrelated-id', 'step-1'])).toEqual({
      keyword: 'Then ',
      text: 'an outcome',
    });
  });
});
