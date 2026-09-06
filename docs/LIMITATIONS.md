# Known limitations

These are real, current constraints of `@qualflare/cucumberjs` — documented deliberately rather than
discovered by surprise. Most are specific to how cucumber-js's Cucumber-Messages event stream exposes
information to a reporter.

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

## Doc Strings and Data Tables render as JSON, not as a table

Gherkin's structured step arguments survive the trip intact — every cell of a Data Table, every line
of a Doc String, plus its media type where one is declared. What they do not get is a rendering: the
wire `Step` contract's only structured slot is the flat `parameters` list, so a table arrives as

```
dataTable   [["name","email"],["Alice","alice@corp.com"]]
```

rather than as a grid. Readable, not scannable.

Nothing is lost and nothing this reporter does differently would change it — a dedicated wire field
plus UI rendering is a platform change. It is recorded here because people notice the JSON and ask,
not because data goes missing.

A Data Table is stringified as ONE parameter rather than one per cell on purpose: a 20x5 table would
be 100 parameters and blow the 50-per-step server cap, taking the step's real parameters with it.

For context, `allure-cucumberjs` drops Doc Strings entirely.

## Retries: steps and metadata come from the final attempt only

Per-attempt **error detail** is no longer a gap — `Case.attempts` carries each attempt's status,
duration and error, so "attempt 1 failed with error X, attempt 2 passed" is exactly what a retried
scenario now reports.

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

## Attachment caps need `@qualflare/cli` v0.1.22+

`maxAttachmentBytes` (5MB) and `maxTotalAttachmentBytes` (10MB) are configurable — see
[`CONFIGURATION.md`](./CONFIGURATION.md). Anything over either is skipped with a warning rather than
truncated; a half-written screenshot is worse than none.

The **version requirement is the real constraint**, and it is not something this reporter can detect
for you. From v0.1.22 the CLI uploads attachments through the presigned-URL flow and references a
`storageKey`, so they no longer occupy `/collect`'s 10MB request body. On an older CLI they are still
base64-inlined, and these limits are large enough to push a request past that body limit — which
fails the entire launch, not just the attachment.

That failure is what the pairing exists to remove. It used to happen without anyone changing a
setting: the caps are per process, `collect` merges every shard into one request, and eleven shards
each honouring the old 750KB budget still assembled a body over the limit.

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
