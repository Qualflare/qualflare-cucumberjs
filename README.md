# @qualflare/cucumberjs

[![npm version](https://img.shields.io/npm/v/%40qualflare%2Fcucumberjs.svg)](https://www.npmjs.com/package/@qualflare/cucumberjs)
[![CI](https://github.com/Qualflare/qualflare-cucumberjs/actions/workflows/ci.yml/badge.svg)](https://github.com/Qualflare/qualflare-cucumberjs/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

A native CucumberJS reporter for [Qualflare](https://qualflare.com) — uploads test results directly
from your `cucumber-js` run: Feature/Scenario status, real retry counts, screenshots, Given/When/Then
step traces, Scenario Outline rows, and author-facing metadata (labels, links, tags, custom
attachments). No post-hoc file parsing, no intermediate report format.

## Install

```sh
npm install --save-dev @qualflare/cucumberjs
```

Requires `@cucumber/cucumber` `>=10.8.0 <14` (installed separately as a peer dependency) and Node
`>=18`.

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

Set your token via the `QUALFLARE_TOKEN` environment variable (or the `token` format option):

```sh
QUALFLARE_TOKEN=<your-token> npx cucumber-js
```

That's it — Feature/Scenario results, retries, and any screenshots you already attach upload as one
Launch at the end of the run. See [`examples/basic/`](./examples/basic) for a complete runnable
project.

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

## Known limitations

- **No video upload** — Qualflare has no blob/video-attachment storage yet.
- **One `cucumber-js` process uploads as one Launch** — sharded (`--shard`) CI setups get multiple
  Launches; `--parallel` does not, since it runs in-process worker threads.
- **Doc Strings and Data Tables** have no dedicated wire field — encoded as a step `Parameter`
  (workaround, not a first-class rendering).
- **`BeforeStep`/`AfterStep` hooks are off by default** (`includeStepHooks`) — noisy for suites with
  global per-step instrumentation.

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
