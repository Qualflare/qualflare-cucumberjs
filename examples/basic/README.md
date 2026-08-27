# qualflare-cucumberjs basic example

A minimal, standalone CucumberJS project showing typical `@qualflare/cucumberjs` usage: formatter
registration, and a few `qualflare.*` metadata calls (`label`, `tag`, `parameter`, `step`), plus a
Scenario Outline.

This is a reference for browsing, not something this repo's own test suite runs — see
`../../test/integration/` for the harness actually exercised by CI.

## Running it against a real Qualflare account

The formatter never uploads anything itself: `cucumber-js` writes a report directory, and
`qualflare-cli` uploads it as a separate step. That split is what lets sharded CI jobs each write
into the same directory and be merged into one Launch by a single `collect`.

```sh
cd examples/basic
npm install

# 1. Run the tests. Writes ./qualflare-results, no network calls.
npm test

# 2. Upload. Requires qualflare-cli >= v0.1.16 — https://github.com/Qualflare/qualflare-cli
qf <your-project-identifier> collect ./qualflare-results
```

`qf login <your-project-identifier> <token>` stores the credential once; there is no
`QUALFLARE_TOKEN` env var in this model — the formatter has no token because it makes no requests.

Set `environment` in `cucumber.json` (or `QUALFLARE_ENVIRONMENT`) to an environment that exists in
your Qualflare project — see [`../../docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md).

Once `collect` finishes, check your Qualflare project — you should see one new Launch with two
Suites (`login.feature`, `checkout.feature`), the login scenario carrying its
labels/steps/parameters, and two Cases for the checkout Scenario Outline (one per Examples row).
