# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- `docs/LIMITATIONS.md`'s CI example installed the CLI as `qualflare`. The correct package name
  is `@qualflare/cli`; the command as published would have failed. Introduced in 0.2.0.

### Changed

- `src/formatter/video-uploader.ts` renamed to `video-writer.ts`. Since 0.2.0 it writes files
  into `outputDir` and uploads nothing, so the old name described work the module no longer does.
  Internal only; the bundled entry points are unchanged.

## 0.2.0 — BREAKING

- **Direct POST to `/collect` removed.** The formatter now only ever writes a report file (and any
  video attachments) into `outputDir`. `qualflare-cli collect <outputDir>` is required to upload
  results, for every run, sharded or not. **Requires `qualflare-cli >= v0.1.16`**, the first release
  able to parse this format — older CLI versions will not recognize the output.
- **Removed options:** `token`, `uploadVideos`, `failOnUploadError` (all meaningless once the
  formatter never makes a network call), plus `apiEndpoint`, `timeoutMs` and `retry.*`, which only
  ever configured the now-deleted HTTP client.
- **`outputFile` → `outputDir`:** a directory, not a single file path, and always active rather than
  opt-in. Each process writes a uniquely-named file, so parallel shards can share one directory and
  be merged into a single Launch by one `collect` — no per-shard path templating, and no `--shard`
  flag on the CLI side.
- **Added `shardIndex`**, stamped onto every case. Auto-detected from `QUALFLARE_SHARD_INDEX`, then
  by scanning `process.argv` for cucumber-js's `--shard INDEX/TOTAL`.

  Note this differs from what the design intended: cucumber-js *does* parse `--shard`, but routes it
  to `configuration.sources.shard`, while a formatter only ever receives `configuration.options` —
  there is no supported way for a formatter to read it. Also note cucumber's index is 1-based ("The
  index starts at 1") while `shardIndex` is 0-based; the conversion is handled. `shardIndex` is an
  attribution label only — merging is driven by directory contents, never by it.
- **`peerDependencies` widened** from `>=10.8.0 <14` to `>=10.8.0`. The upper bound would have made
  cucumber-js 14 a hard `npm install` failure on its release day — peer conflicts are errors, not
  warnings, in npm 7+ — for a package that would very likely have worked fine. CI exercises 10.8,
  11, 12 and 13 against a real `cucumber-js` run.
- `undici` moved from `dependencies` to `devDependencies`; nothing in `src/` imports it now.

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
