# Known limitations

These are real, current constraints of `@qualflare/cucumberjs` v1 — documented deliberately rather
than discovered by surprise. Several stem from Qualflare backend capabilities that don't exist yet
(shared with [`@qualflare/cypress`](https://github.com/Qualflare/qualflare-cypress)); others are
specific to how cucumber-js's Cucumber-Messages event stream exposes information to a reporter.

## Video upload

Video attachments (`.mp4`, `.webm`, `.mov`) upload to R2 via a presigned-URL flow, separate from the
inline-base64 path small attachments take — a typical video is far too large to inline in the
`/collect` request body. cucumber-js has no built-in video recording of its own, so the only source is
a real `World.attach()`/`qualflare.attachment()`/`attachmentFromFile()` call given video content or a
video file path — uploaded and attached to whichever scenario attempt made the call, like any other
attachment.

Controlled by two options: `uploadVideos` (default `true`) and `maxVideoBytes` (default 50MB, matching
the server's own cap — checked before any upload attempt). A video that fails to upload (oversized,
unsupported format, or a network/API error) is skipped with a logged warning, the same fail-open
behavior as any other attachment — it never fails the run, independent of `failOnUploadError` (which
is scoped to the final `/collect` POST, not to attachment resolution).

## One `cucumber-js` process = one Launch (unless you merge sharded runs)

Qualflare's `/api/v1/collect` endpoint creates exactly one new Launch per request, with no
incremental or merge capability server-side. This reporter accumulates every scenario's results in
memory for the lifetime of one `cucumber-js` process and uploads them in a single POST at the
formatter's `finished()` lifecycle hook.

- **`--parallel N`** runs worker *threads* inside the same OS process (cucumber-js's own
  documented behavior) — the formatter always runs in the coordinator, seeing every worker's
  results, so this does NOT multiply your Launch count.
- **`--shard INDEX/TOTAL`** is a different thing entirely: each shard is a fully independent
  `cucumber-js` invocation (typically a separate CI job/machine), each with its own formatter
  instance. cucumber-js's own sharding is a coordinator-only pre-run filter — a running formatter
  has no API access to its own shard index/total at all, from cucumber-js or this reporter. If your
  CI shards this way, you will see N Launches for one CI run by default, not one combined
  Launch — the same constraint `@qualflare/cypress` documents for multiple `cypress run` processes.

### Merging shards into one Launch

Set `outputFile` (or `QUALFLARE_OUTPUT_FILE`) instead of relying on the default POST-per-process
behavior: the formatter writes its `Collect` JSON to that path and uploads nothing itself (no token
is even required in this mode). Give each shard a unique path, upload it as a CI artifact, then
merge and upload once via [`qualflare-cli`](https://github.com/Qualflare/qualflare-cli)'s `--shard`
flag, which already implements exactly this file-merge pattern for every framework it supports.

Video attachments are never uploaded in this mode — `uploadVideos` is forced off automatically,
regardless of what's configured. Video upload needs a real token (this mode deliberately has none),
and even a successful upload's `storageKey` has no equivalent in `qualflare-cli`'s merge parser and
would be dropped at merge time anyway. A video-shaped `World.attach()`/`qualflare.attachment()`/
`attachmentFromFile()` call is simply skipped, with a logged warning, the same as `uploadVideos: false`.

GitHub Actions example (a matrix job per shard, then a final job that merges and uploads):

```yaml
jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - run: npx cucumber-js --shard ${{ matrix.shard }}/4
        env:
          QUALFLARE_OUTPUT_FILE: qualflare-report-${{ matrix.shard }}.json
          # No QUALFLARE_TOKEN here — outputFile mode never authenticates.
      - uses: actions/upload-artifact@v4
        with:
          name: qualflare-report-${{ matrix.shard }}
          path: qualflare-report-${{ matrix.shard }}.json

  upload:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: qualflare-report-*
          merge-multiple: true
      - run: |
          npm install -g @qualflare/cli
          qf login ci "$QF_TOKEN" --force
          qf ci collect --shard qualflare-report-*.json
        env:
          QF_TOKEN: ${{ secrets.QF_TOKEN }}
```

`qf` auto-detects this reporter's JSON output from its content — no `--format` flag needed.

## Doc Strings and Data Tables have no dedicated wire field

The wire contract's only structured-payload slot on a step is the flat `Step.parameters[]` list —
there is no dedicated Doc String or Data Table field. This reporter encodes:
- A Doc String as one `Parameter{name: "docString", value: <the text>}`.
- A Data Table as one `Parameter{name: "dataTable", value: <JSON-stringified rows>}` (one Parameter
  for the whole table, not one per cell, to avoid risking the 50-parameters-per-step server cap on a
  large table).

This is a workaround, not a first-class rendering — the Qualflare UI shows it as a regular parameter
value, not a formatted table or a multi-line text block. (Notably, `allure-cucumberjs` doesn't
support Doc Strings at all — this is actually more complete than the most mature comparable reporter,
just not ideal.)

## Retries: final result + count only, no per-attempt detail

`Case.retryCount`/`Case.isFlaky` are the only retry-shaped fields the wire contract has — one `Case`
maps to exactly one final result, with a count of how many attempts it took. There is no "attempt 1
failed with error X, attempt 2 passed" structure anywhere in the schema. If you need distinct
per-attempt error detail (not just the final attempt's), that has no home in the current backend —
this matches exactly how `@qualflare/cypress`'s own retry mechanism already collapses to
final-result-only, so it's a consistent, deliberate constraint across both reporters, not a gap
specific to this one.

## `BeforeStep`/`AfterStep` are off by default

Every Gherkin step is already reported. `BeforeStep`/`AfterStep` hooks (if you've registered any) are
NOT included by default — set `includeStepHooks: true` (see
[`docs/CONFIGURATION.md`](./CONFIGURATION.md)) to include them. They're opt-in because they run once
per Gherkin step and can multiply your step count several-fold for suites with a global per-step
instrumentation hook (e.g. a screenshot-after-every-step hook), which is noisy as a default. When
enabled, they appear as flat, un-nested steps immediately adjacent to the step they wrap in
chronological order — not literally nested under it (there's no reliable way to know a `BeforeStep`
hook's future sibling index before that step has even started).

`Before`/`After` (scenario-level) hooks, by contrast, are always included as synthetic steps — there's
no opt-out for those, since they're far less noisy (at most one Before and one After per scenario) and
a failing one is exactly the kind of thing that should never silently vanish from the report.

## `BeforeAll`/`AfterAll` attachments are not captured

A **failed** `BeforeAll`/`AfterAll` hook does become a synthetic Case (in a `(global hooks)` Suite —
see the README), but any attachment made from inside one (via `this.attach()`) is not captured: these
hooks run outside any scenario, so there's no Case for the attachment to belong to. A passing
`BeforeAll`/`AfterAll` produces no Case at all — it has no useful signal to report, and would be pure
noise on every run.

## `qualflare.parameter()` outside a step has no masking

The wire contract has no scenario-level `Parameter[]` on a `Case` — only `Step.parameters` exists. A
`qualflare.parameter()` call made while a `qualflare.step()` is open attaches to that step's
parameters (masking respected); called outside any step, it becomes a `Case.properties` entry instead
(the only scenario-level key/value bag the wire contract offers) — and `masked` has no analog on a
plain string map, so it's silently ignored in that case. This is a real, documented limitation, not a
bug — and matches `@qualflare/cypress`'s identical constraint.

## Per-case/per-attachment caps are independent, not pooled

`maxAttachmentBytes` (per attachment) and `maxTotalAttachmentBytes` (per run) govern every attachment
this reporter uploads, from whatever source (a real `this.attach()` call you already make,
`qualflare.attachment()`, or `qualflare.attachmentFromFile()`) — but the count cap
(`MAX_ATTACHMENTS_PER_CASE`) and the step cap (`MAX_STEPS_PER_TEST_ATTEMPT`) aren't pooled separately
per source; everything shares the same running total per scenario/attempt.
