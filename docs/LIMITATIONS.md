# Known limitations

These are real, current constraints of `@qualflare/cucumberjs` v1 — documented deliberately rather
than discovered by surprise. Several stem from Qualflare backend capabilities that don't exist yet
(shared with [`@qualflare/cypress`](https://github.com/Qualflare/qualflare-cypress)); others are
specific to how cucumber-js's Cucumber-Messages event stream exposes information to a reporter.

## Video attachments are written, not uploaded

Video attachments (`.mp4`, `.webm`, `.mov`) are written into `outputDir` alongside the report file
and referenced by `localVideoPath`; `qualflare-cli` uploads them at collect time and resolves each
into a real `storageKey`. Small attachments still take the inline-base64 path — a typical video is
far too large to inline in the `/collect` request body.

cucumber-js has no built-in video recording of its own, so the only source is a real
`World.attach()`/`qualflare.attachment()`/`attachmentFromFile()` call given video content or a video
file path. Both shapes are handled: a real file is copied, in-memory base64 content is decoded and
written.

Controlled by `maxVideoBytes` (default 50MB, matching the server's own cap — checked before
anything is written). A video that can't be written (oversized, unsupported format, unreadable
source) is skipped with a logged warning, the same fail-open behavior as any other attachment. It
never fails the run.

## Sharded CI: point every shard at the same `outputDir`

Qualflare's `/api/v1/collect` endpoint creates exactly one Launch per request, with no incremental
or merge capability server-side. This reporter accumulates every scenario's results in memory for
the lifetime of one `cucumber-js` process, then writes them as one uniquely-named JSON file at the
formatter's `finished()` hook. It never uploads.

- **`--parallel N`** runs worker *threads* inside the same OS process (cucumber-js's own documented
  behavior) — the formatter always runs in the coordinator, seeing every worker's results, so it
  produces one file regardless of N.
- **`--shard INDEX/TOTAL`** is a different thing: each shard is a fully independent `cucumber-js`
  invocation, typically on a separate CI job/machine, each with its own formatter instance and its
  own output file.

Merging is handled entirely by `qualflare-cli`: point every shard at the same `outputDir` and run
`qf <identifier> collect <outputDir>` once at the end. Because each file's name is a UUID, shards
sharing a directory never overwrite each other, and `collect` merges everything it finds into a
single Launch. No `--shard` flag is needed on the CLI side.

Requires [`qualflare-cli`](https://github.com/Qualflare/qualflare-cli) **v0.1.16 or newer** — the
first release able to parse this format.

### Stale files are refused, not merged

Each report carries `metadata.runId` — the identifier every shard of one run shares and different
runs do not (`GITHUB_RUN_ID`, `CI_PIPELINE_ID`, and so on; a per-process UUID outside CI). If
`collect` finds files from more than one run it refuses to upload and names them:

```
Error: 2 different runs found in the report files:
    run 17244102887: 1 file(s)  (stale.json)
    run 17244981923: 2 file(s)  (shard-0.json, shard-1.json)
  A stale file from an earlier run would be merged into this launch.
  Clear the output directory before each run, or pass --allow-mixed-runs to upload anyway
```

Clearing `outputDir` at the start of each run is still the tidier habit — in CI it is usually free,
since the workspace is fresh — but forgetting now costs a failed upload rather than a launch
quietly containing results nobody ran.

Needs `@qualflare/cli` v0.1.19 or newer. An older CLI ignores `runId` and merges as before.

### `shardIndex` is best-effort, and only a label

Every case is stamped with a 0-based `shardIndex`, resolved from the `shardIndex` option, then
`QUALFLARE_SHARD_INDEX`, then a scan of `process.argv` for `--shard INDEX/TOTAL`.

cucumber-js does parse `--shard` itself, but routes it to `configuration.sources.shard`, while a
formatter is only ever handed `configuration.options` — so there is no supported API for a formatter
to read it, and argv is the only place it is observable. That works when the flag is on the command
line, and finds nothing when sharding is configured via a `cucumber.js` config file; set
`QUALFLARE_SHARD_INDEX` explicitly if you need it guaranteed.

Note cucumber documents its own index as **1-based** ("The index starts at 1") and normalizes it
internally with `parseInt(idx) - 1`; this reporter matches that, so `--shard 1/3` is `shardIndex: 0`.

None of this affects correctness: merging is driven by directory contents, so an unresolved
`shardIndex` costs attribution, never results.

GitHub Actions example — every shard writes to the same directory, one job collects:

```yaml
jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - run: npx cucumber-js --shard ${{ matrix.shard }}/4
        env:
          QUALFLARE_OUTPUT_DIR: qualflare-results
          # No token here — this formatter never authenticates.
      - uses: actions/upload-artifact@v4
        with:
          name: qualflare-results-${{ matrix.shard }}
          path: qualflare-results/

  upload:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: qualflare-results-*
          path: qualflare-results
          merge-multiple: true
      - run: |
          npm install -g @qualflare/cli
          qf login ci "$QF_TOKEN" --force
          qf ci collect ./qualflare-results
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
