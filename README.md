# @qualflare/cucumberjs

[![npm version](https://img.shields.io/npm/v/%40qualflare%2Fcucumberjs.svg)](https://www.npmjs.com/package/@qualflare/cucumberjs)
[![CI](https://github.com/Qualflare/qualflare-cucumberjs/actions/workflows/ci.yml/badge.svg)](https://github.com/Qualflare/qualflare-cucumberjs/actions/workflows/ci.yml)
[![Qualflare](https://api.qualflare.com/p/qualflare-cucumberjs/badge.svg)](https://reports.qualflare.com/p/qualflare-cucumberjs/launches)
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

> **Requires `@qualflare/cli` v0.1.24 or newer.** Screenshots are written into `outputDir` and
> referenced by name (`localImagePath`) instead of being base64-inlined into the report, the same
> way videos already were — including the ones you hand to `World.attach()`, which have no file on
> disk and are written out for you. An older CLI does not read the field, and because such an
> attachment carries neither content nor a storage key the server records it from its name alone —
> an undownloadable placeholder. Upgrade the CLI before upgrading this formatter.
>
> **Videos are opt-in; screenshots are not.** `collect` uploads the report and the screenshots
> always, but a video only when asked: `--upload-artifacts=video` (or `QF_UPLOAD_ARTIFACTS=video`).
> Named kinds are *added* to that default, so asking for video does not turn screenshots off;
> `--upload-artifacts=none` declines everything, screenshots included. Nothing is dropped silently —
> `collect` prints how many it skipped and the exact flag to include them.

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

## Test reports

This formatter is tested with itself. `e2e/` is a cucumber-js suite covering this package's own
behaviour — the metadata API, nested steps, image attachments and per-attempt retry history — run by
this formatter and uploaded to Qualflare on every merge to `main`. The results below are that suite's,
reported through the code this README documents:

[![Qualflare](https://api.qualflare.com/p/qualflare-cucumberjs/banner.svg)](https://reports.qualflare.com/p/qualflare-cucumberjs/launches)

Every case there is meant to pass, so a red run is a real regression rather than a fixture that fails
on purpose. Deliberately-failing cases live in `test/integration/`, which is never uploaded.

## Known limitations

- **`BeforeAll`/`AfterAll` attachments need the hook to fail** — a failed global hook becomes a
  synthetic Case and its attachments land there; a passing one produces no Case, so they are
  dropped.
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
