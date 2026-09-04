# @qualflare/cucumberjs

[![npm version](https://img.shields.io/npm/v/%40qualflare%2Fcucumberjs.svg)](https://www.npmjs.com/package/@qualflare/cucumberjs)
[![CI](https://github.com/Qualflare/qualflare-cucumberjs/actions/workflows/ci.yml/badge.svg)](https://github.com/Qualflare/qualflare-cucumberjs/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

A native CucumberJS reporter for [Qualflare](https://qualflare.com) — captures test results directly
from your `cucumber-js` run: Feature/Scenario status, per-attempt retry history, screenshots, videos,
Given/When/Then step traces, Scenario Outline rows, and author-facing metadata (labels, links, tags,
custom attachments).

The formatter itself makes **no network calls**. It writes a report directory, and
[`qualflare-cli`](https://github.com/Qualflare/qualflare-cli) uploads it — which is what lets any
number of sharded CI jobs merge into a single Launch.

## Install

```sh
npm install --save-dev @qualflare/cucumberjs
```

Requires `@cucumber/cucumber` `>=10.8.0` (installed separately as a peer dependency) and Node
`>=18`. You also need [`qualflare-cli`](https://github.com/Qualflare/qualflare-cli) **v0.1.16 or
newer** to upload what this formatter writes.

The peer range is deliberately open-ended rather than capped at a known-good major, so a new
cucumber-js release never hard-blocks `npm install` for you. Every major from 10.8 through 13 is
exercised in CI against a real `cucumber-js` run; newer majors are untested but not refused —
please [open an issue](https://github.com/Qualflare/qualflare-cucumberjs/issues) if one
misbehaves.

## Quickstart

```json
// cucumber.json
{
  "default": {
    "format": ["@qualflare/cucumberjs/formatter"],
    "formatOptions": {
      "environment": "staging"
    }
  }
}
```

Then run your tests and upload the results — two steps, no token needed for the first:

```sh
# 1. Run. Writes ./qualflare-results (JSON + any videos). Zero network calls.
npx cucumber-js

# 2. Upload. `qf login <identifier> <token>` stores the credential once.
qf <your-project-identifier> collect ./qualflare-results
```

> **Videos are opt-in from `@qualflare/cli` v0.1.20.** `collect` uploads the report itself
> always, but a video only when asked: `--upload-artifacts=video` (or `QF_UPLOAD_ARTIFACTS=video`).
> Earlier CLI versions uploaded every video automatically. Nothing is dropped silently — `collect`
> prints how many it skipped and the exact flag to include them.

That's it — Feature/Scenario results, retries, and any screenshots you already attach arrive as one
Launch. See [`examples/basic/`](./examples/basic) for a complete runnable project.

### Sharded CI

Point every shard at the **same** `outputDir` and collect once at the end. Each process writes its
own uniquely-named file, so shards never overwrite each other, and `qf collect` merges every file
in the directory into a single Launch:

```sh
# in each parallel job — note they all write to the same directory
npx cucumber-js --shard "$SHARD_INDEX/$SHARD_TOTAL"

# once, after all shards finish (e.g. with the directory restored from CI artifacts)
qf <your-project-identifier> collect ./qualflare-results
```

No `--shard` flag is needed on the CLI side: merging is driven purely by which files are in the
directory.

## Enriching your tests

```ts
import { Given, When } from '@cucumber/cucumber';
import { qualflare } from '@qualflare/cucumberjs';

Given('a user with valid credentials', function () {
  qualflare.label('epic', 'Authentication');
  qualflare.tag('smoke');
});

When('they log in', async function () {
  await qualflare.step('fill in credentials', async () => {
    await this.page.fill('#email', 'user@example.com');
    await this.page.fill('#password', 'correct-horse-battery-staple');
  });

  await qualflare.step('submit and verify redirect', async () => {
    await this.page.click('#submit');
    await this.page.waitForURL('**/dashboard');
  });
});
```

See [`docs/METADATA-API.md`](./docs/METADATA-API.md) for the full reference (labels, links, tags,
description, priority, parameters, custom attachments, nested steps).

## Configuration

Every option can be set either as a `formatOptions` entry or via a `QUALFLARE_*` environment
variable. Full table, precedence rules, and auto-detection behavior (git branch/commit, CI
provider/build/PR) in [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md).

One option is worth calling out because it fails late: `environment` is matched against the
environment's **uid (slug)**, not its display name, so **Staging** in the UI is `staging` here. A
wrong value cannot fail at run time — this package makes no network calls — so the run succeeds and
`collect` 404s afterwards. See
[the note in the configuration docs](./docs/CONFIGURATION.md#environment-is-matched-by-uid-not-display-name).

## Known limitations

- **`shardIndex` is best-effort** — cucumber-js routes its own `--shard` flag somewhere a formatter
  cannot read, so it is recovered from `QUALFLARE_SHARD_INDEX` or by scanning `process.argv`. It is
  only an attribution label; merging never depends on it. See
  [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md).
- **Doc Strings and Data Tables** have no dedicated wire field — encoded as a step `Parameter`
  (workaround, not a first-class rendering).
- **`BeforeStep`/`AfterStep` hooks are off by default** (`includeStepHooks`) — noisy for suites with
  global per-step instrumentation.
- **`BeforeAll`/`AfterAll` attachments need the hook to fail** — a failed global hook becomes a
  synthetic Case and its attachments land there; a passing one produces no Case, so they are
  dropped.
- **`parameter()` outside a step is not masked** — `masked` is a display hint for the UI; the
  server never redacts the value, so never put a real secret in one. See
  [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md#qualflareparameter-outside-a-step-has-no-masking).
- **Attachment caps are two budgets, not one pool** — `maxAttachmentBytes` bounds a single
  attachment and `maxTotalAttachmentBytes` the whole run; anything over either is dropped
  outright rather than truncated. Raising them is the easiest way to push a request past
  `/collect`'s body limit. See
  [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md#per-caseper-attachment-caps-are-independent-not-pooled).
- **Retries carry per-attempt errors, but everything else is the final attempt** — `Case.attempts`
  records each attempt's status, duration and error; steps, labels, links, tags, priority,
  properties and attachments come from the last attempt only, so an abandoned attempt's step trace
  is discarded rather than replayed alongside the final one.

Full details in [`docs/LIMITATIONS.md`](./docs/LIMITATIONS.md).

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm run build       # tsup — dual ESM+CJS, .d.ts
npm test            # unit tests (vitest)
npm run test:integration   # spawns a real cucumber-js run against a fixture project + mock server
```

Release process: see [`RELEASING.md`](./RELEASING.md).

## License

Apache-2.0
