# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

Initial public release.

### Added

- Native CucumberJS reporter: Feature/Scenario results, real retry counts, and duration upload as
  one Launch per `cucumber-js` process.
- Given/When/Then step traces with literal keyword text, including Background steps.
- Scenario Outline support — each Examples row becomes its own Case, with the row's values folded
  into `Case.properties` automatically.
- Data Table and Doc String step arguments, encoded as step parameters.
- `Before`/`After` hook failures surfaced as synthetic steps; an opt-in `includeStepHooks` setting
  for `BeforeStep`/`AfterStep`.
- Failed `BeforeAll`/`AfterAll` hooks surfaced as a synthetic `(global hooks)` suite.
- Automatic capture of any real `this.attach()` call (screenshots, logs, etc.) — no code changes
  required.
- Author-facing `qualflare` metadata API: `label`, `link`, `tag`, `description`, `priority`,
  `parameter`, `step` (arbitrary nesting depth), `attachment` / `attachmentFromFile`.
- CI/git auto-detection with `QUALFLARE_*` environment variable overrides for every option.
- Dual ESM + CJS build with bundled type declarations.
