import type { GherkinDocument, Scenario } from '@cucumber/messages';

interface ScenarioEntry {
  scenario: Scenario;
  ruleName?: string;
}

interface FeatureEntry {
  featureName?: string;
  /** AST step id -> literal Gherkin keyword ("Given "/"When "/"Then "/"And "/
   * "But ", with cucumber-js's own trailing space) + step text. Background
   * steps are indexed here too — cucumber-js already merges Background
   * steps into every scenario's compiled `Pickle.steps[]` itself, so no
   * separate handling is needed; a Background step's AST id just needs to
   * resolve here like any other. */
  stepMap: Map<string, { keyword: string; text: string }>;
  scenarioById: Map<string, ScenarioEntry>;
}

/**
 * Indexes each `gherkinDocument` envelope (one per feature file) so
 * `case-builder.ts`/`step-mapper.ts` can resolve, per pickle: the Feature
 * name, an optional `Rule:` name, the Scenario AST node (for its
 * `examples[]`, used for Scenario Outline row correlation), and literal
 * Given/When/Then/And/But keyword text for each step (the compiled
 * `PickleStep.type` only gives a coarse Context/Action/Outcome/Unknown
 * classification, not the literal keyword).
 */
export class GherkinIndex {
  private readonly byUri = new Map<string, FeatureEntry>();

  add(doc: GherkinDocument): void {
    if (!doc.uri || !doc.feature) {
      return;
    }
    const entry: FeatureEntry = {
      featureName: doc.feature.name || undefined,
      stepMap: new Map(),
      scenarioById: new Map(),
    };
    for (const child of doc.feature.children) {
      if (child.background) {
        this.indexSteps(entry, child.background.steps);
      }
      if (child.scenario) {
        entry.scenarioById.set(child.scenario.id, { scenario: child.scenario });
        this.indexSteps(entry, child.scenario.steps);
      }
      if (child.rule) {
        for (const ruleChild of child.rule.children) {
          if (ruleChild.background) {
            this.indexSteps(entry, ruleChild.background.steps);
          }
          if (ruleChild.scenario) {
            entry.scenarioById.set(ruleChild.scenario.id, {
              scenario: ruleChild.scenario,
              ruleName: child.rule.name || undefined,
            });
            this.indexSteps(entry, ruleChild.scenario.steps);
          }
        }
      }
    }
    this.byUri.set(doc.uri, entry);
  }

  private indexSteps(entry: FeatureEntry, steps: readonly { id: string; keyword: string; text: string }[]): void {
    for (const step of steps) {
      entry.stepMap.set(step.id, { keyword: step.keyword, text: step.text });
    }
  }

  get(uri: string): FeatureEntry | undefined {
    return this.byUri.get(uri);
  }

  /** Resolves the literal Given/When/Then/And/But keyword text for a
   * compiled `PickleStep`, by walking its `astNodeIds` back to the first
   * one present in this feature's `stepMap` (a Background step referenced
   * by a scenario has exactly one AST id; a step reusing a parameter type
   * from an outline row can have more than one — the first match is always
   * the step's own defining AST node). */
  resolveKeyword(uri: string, astNodeIds: readonly string[]): { keyword: string; text: string } | undefined {
    const entry = this.byUri.get(uri);
    if (!entry) {
      return undefined;
    }
    for (const id of astNodeIds) {
      const found = entry.stepMap.get(id);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
}
