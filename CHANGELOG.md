# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.7.1

### Fixed

- **`maxTotalAttachmentBytes` is charged in encoded bytes, not raw.** An attachment contributes its
  base64 to the report, which is 4/3 larger than the source, so the cap admitted a third more than it
  said: a fully-spent 10,000,000-byte budget produced 13,333,336 bytes of content against
  `/collect`'s 10,485,760-byte body limit. The configured number now means what it says. Set it from
  the raw size you expect and it will no longer overshoot; a run that was quietly near the limit may
  now warn and skip an attachment it previously included.
  `maxAttachmentBytes` is unchanged and still measures the source file.

### Changed

- The npm `homepage` now points at the repository README rather than the Qualflare site root, so the
  package page links somewhere with install and configuration instructions.

## 0.7.0

### Changed

- **Screenshots are written into `outputDir` and referenced by `localImagePath`, instead of being
  base64-inlined into the report.** They now travel the same way videos and traces already did: the
  report file carries no image bytes, and the CLI uploads them out of band rather than sending them
  inside `/collect`'s request body.

  Both shapes are handled: a real file from `qualflare.attachmentFromFile()` is copied, and
  in-memory content from `World.attach()` / `qualflare.attachment()` is written out. The in-memory
  case is the common one here, since screenshots usually arrive from a browser driver.

  **Requires `@qualflare/cli` v0.1.24+.** An older CLI does not read the field, and because such an
  attachment carries neither content nor a storage key the server records it from its name alone —
  an undownloadable placeholder. Upgrade the CLI first.

- Screenshots upload by default on the CLI side; video and traces remain opt-in. Named kinds are
  *added* to that default, so `--upload-artifacts=video` no longer turns screenshots off. The new
  `--upload-artifacts=none` declines every kind, screenshots included.

## 0.6.1

### Fixed

- `docs/METADATA-API.md` still described `masked` as "a display hint for the UI only... do not pass a
  real secret expecting it to be protected". That was the behaviour the previous release replaced —
  the value is redacted before the report is written and never reaches the server. The API reference
  is what people read to learn the option, and it said the opposite of what the code does.
- `docs/CONFIGURATION.md` still advertised `maxAttachmentBytes` as `1500000` and
  `maxTotalAttachmentBytes` as `750000`. The previous release raised them to 5MB and 10MB, so the
  options table understated the real defaults by 6x and 13x.

### Changed

- Known limitations no longer lists the attachment caps or the masking behaviour. Both are things
  this reporter does on purpose — one configurable, one a feature — rather than gaps. What survives
  in `LIMITATIONS.md` is the part that constrains you: the caps require `@qualflare/cli` v0.1.22+.

### Fixed (cucumber-js specific)

- A Doc String's media type (the `json` opening a triple-quoted block) was discarded. `PickleDocString`
  carries it and the encoder read only `content`, so the hint a viewer would syntax-highlight by never
  reached the server. Now emitted as its own Parameter when present; a Doc String without one is
  unchanged.
- The Doc String / Data Table entry left Known limitations. Every value survives the trip — what the
  flat `parameters` slot costs is rendering, which is a platform change rather than anything this
  reporter could do differently.

## 0.6.0

### Changed

- **`{ masked: true }` now redacts the value instead of only hinting at it.** The real value used to
  be sent, stored server-side in plaintext and readable back through the API, while only the UI drew
  dots over it — anyone who trusted the name got no protection. The value is now dropped before the
  report is written, so the secret never leaves the machine. Inside a step the parameter travels as
  `{ name, masked: true }`; outside one it becomes `••••••` in the case's `properties`.

  **A masked value is now unrecoverable.** That is the point, but it is not a display toggle you can
  undo later.

- **Attachment caps raised** — `maxAttachmentBytes` 1.5MB → 5MB, `maxTotalAttachmentBytes`
  750KB → 10MB. They were tight because every attachment was base64-inlined into `/collect`'s 10MB
  body; `@qualflare/cli` v0.1.22+ uploads them out of band, so these now only bound the report file
  on disk.

  **Requires `@qualflare/cli` v0.1.22 or newer.** An older CLI still inlines, and these limits would
  push the request past the server's body limit and fail the whole launch.

- **`outputDir` no longer needs clearing between runs.** `qf collect` (v0.1.21+) uploads the run
  that just finished and leaves an older one on disk rather than refusing the upload.

- Known limitations now lists only what this reporter limits. Configurable defaults and things the
  underlying framework does not do moved out — the latter to "Not limitations of this reporter".

## 0.5.1

### Changed

- Documentation only; no code change. The README quickstart now states that videos are opt-in from
  `@qualflare/cli` v0.1.20 (`--upload-artifacts=video`). Earlier CLI versions uploaded every video
  automatically, so this is a change of default for anyone upgrading.

## 0.5.0

### Added

- **Attachments made inside a failing `BeforeAll`/`AfterAll` are captured.** A failed global hook
  already became a synthetic Case in a `(global hooks)` Suite, but anything attached from inside it
  was discarded — the attachment carries `testRunHookStartedId` rather than `testCaseStartedId`,
  which is exactly the id that Case is keyed on.

  They are buffered unresolved and only resolved once the hook is known to have failed, so a passing
  hook spends none of the run's attachment budget. A passing hook still reports nothing, which stays
  correct. Needs a cucumber-js new enough to populate `testRunHookStartedId`; where it is absent the
  attachment is dropped exactly as before.

## 0.4.0

### Added

- Per-attempt execution history on every retried scenario, sent as `Case.attempts`.

  `--retry` re-runs a pickle from scratch and `collapseAttempts` kept only the last run, so a
  scenario that failed twice and then passed reported `retryCount: 2` with no record of
  either failure.

  Each attempt's status, duration and error is now sent individually, including the final
  one. A scenario that was not retried sends nothing, and steps/labels/attachments still come
  from the final attempt only. Requires an API that stores attempt history; older servers
  ignore the field.

  Each attempt's error is bounded to 8192 characters, matching what the server stores. The
  Case's own `error` field is unaffected.

## 0.3.0

### Added

- `metadata.runId` on every report, plus a `runId` option (`QUALFLARE_RUN_ID`) to set it
  explicitly. Every shard of one CI run resolves the same value (`GITHUB_RUN_ID`,
  `CI_PIPELINE_ID`, and so on); outside CI it is a per-process UUID.

  This is what lets `qf collect` tell the shards of the current run apart from a file left behind
  by an earlier one. Until now a stale report sitting in `outputDir` was merged into the launch
  silently — the launch looked entirely plausible and contained results nobody ran, which corrupts
  the history flaky-detection is built on. Requires `@qualflare/cli` v0.1.19 or newer, which
  refuses the merge and names the offending files; older CLIs ignore `runId` and merge as before.

### Changed

- The stale-file caveat in `README.md` and `docs/LIMITATIONS.md` documents what now actually
  happens, instead of asking you to remember to clear the directory.



- `src/formatter/video-uploader.ts` renamed to `video-writer.ts`. Since 0.2.0 it writes files
  into `outputDir` and uploads nothing, so the old name described work the module no longer does.
  Internal only; the bundled entry points are unchanged.

### Fixed

- `docs/LIMITATIONS.md`'s CI example installed the CLI as `qualflare`. The correct package name
  is `@qualflare/cli`; the command as published would have failed. Introduced in 0.2.0.

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
