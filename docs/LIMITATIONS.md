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

### A leftover report does not need clearing

Each report carries `metadata.runId` — the identifier every shard of one run shares and different
runs do not (`GITHUB_RUN_ID`, `CI_PIPELINE_ID`, and so on; a per-process UUID outside CI). When
`collect` finds files from more than one run it uploads the run that just finished and says what it
left out:

```
ignored 1 file(s) from 1 earlier run(s) (--allow-mixed-runs to include them)
Processing 2 test result file(s)...
OK Test results collected successfully
```

Nothing is deleted — the older files stay on disk, they are simply not uploaded.
`--allow-mixed-runs` merges every run into one launch instead, which is occasionally what you want
when several tools write into one directory.

There was a period where this was stricter than it needed to be: `collect` refused the whole upload
and left you to clear the directory by hand. Before that it merged the stale file silently, which
produced a launch that looked entirely plausible and contained results nobody ran.

**On `@qualflare/cli` older than v0.1.21 you get one of those two older behaviours** — a refusal on
v0.1.19–v0.1.20, and a silent merge before that.

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

## Retries: steps and metadata come from the final attempt only

Per-attempt **error detail** is no longer a gap — `Case.attempts` carries each attempt's status,
duration and error, so "attempt 1 failed with error X, attempt 2 passed" is exactly what a retried
scenario now reports. `@qualflare/cypress` and `@qualflare/playwright` send the same structure.

What still collapses to the final attempt is everything *else*: steps, labels, links, tags,
description, priority, properties and attachments. That one is deliberate rather than a limit of
the schema. An abandoned attempt's step trace, replayed alongside the final one's, would
misrepresent a single execution as if the same steps ran twice — so earlier attempts' steps are
discarded, never merged.

Two smaller consequences worth knowing:

- A scenario that was **not** retried sends no `attempts` at all. There is no history in a run that
  happened once, and the server discards a single-element array, so sending one would only spend
  payload against the collect body limit.
- Past 50 attempts the server keeps the first 49 plus the final one and drops the middle. A
  scenario retrying more than fifty times is pathological; the launch still succeeds and
  `retryCount` still reflects the true total.

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

## `BeforeAll`/`AfterAll` attachments land only on a FAILED hook

A failed `BeforeAll`/`AfterAll` becomes a synthetic Case in a `(global hooks)` Suite, and anything
attached from inside that hook (`this.attach()`) now lands on it.

A **passing** hook still produces no Case, so its attachments are dropped — a passing `BeforeAll`
has no useful signal to report and would be pure noise on every run. They are buffered unresolved
and discarded, so a passing hook spends none of the run's attachment budget.

Needs a cucumber-js new enough to populate `Attachment.testRunHookStartedId`. Where that field is
absent the attachment is dropped exactly as it was before.

## `parameter()` masking redacts the value

`{ masked: true }` drops the value before the report is written. The secret never leaves this
process, so it is not stored server-side and cannot be read back through the API.

Inside a step, the parameter travels as `{ name, masked: true }` with no value, and the Qualflare UI
renders `••••••` from the flag. Outside any step it lands in the case's `properties`, a flat
`Record<string, string>` with nowhere to put the flag — so the value itself becomes `••••••`.
Either way the report carries no secret.

**The value is unrecoverable.** That is the point, but it is worth stating: masking is not a display
toggle you can undo later. Mask a value you may need to read back and it is gone.

This used to be a display hint only — the real value was sent, stored in plaintext and readable
through the API, while the UI drew dots over it. Anyone who trusted the name got no protection at
all, which is why the docs had to say "never put a real secret in one". They no longer do.

## Per-case/per-attachment caps are independent, not pooled

`maxAttachmentBytes` (per attachment) and `maxTotalAttachmentBytes` (per run) govern every attachment
this reporter uploads, from whatever source (a real `this.attach()` call you already make,
`qualflare.attachment()`, or `qualflare.attachmentFromFile()`) — but the count cap
(`MAX_ATTACHMENTS_PER_CASE`) and the step cap (`MAX_STEPS_PER_TEST_ATTEMPT`) aren't pooled separately
per source; everything shares the same running total per scenario/attempt.

## Not limitations of this reporter

Things cucumber-js itself does not do. They are recorded here because people ask why a cucumber-js launch
looks different from the other reporters' — not because anything is being withheld. Each would need
a change in cucumber-js, not here.

**`--shard` is not visible to a formatter.** cucumber-js parses its own `--shard` flag into
`configuration.sources.shard`, while a formatter is only ever handed `configuration.options` — there
is no supported API to read it. This reporter scans `process.argv` instead, which works when the flag
is on the command line and finds nothing when sharding comes from a `cucumber.js` config file. Set
`QUALFLARE_SHARD_INDEX` explicitly if you need it guaranteed.

`shardIndex` is an attribution label only; merging never depends on it, so a missing one costs the
per-shard breakdown in the UI and nothing else.
