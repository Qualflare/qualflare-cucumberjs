# qualflare-cucumberjs basic example

A minimal, standalone CucumberJS project showing typical `@qualflare/cucumberjs` usage: formatter
registration, and a few `qualflare.*` metadata calls (`label`, `tag`, `parameter`, `step`), plus a
Scenario Outline.

This is a reference for browsing, not something this repo's own test suite runs — see
`../../test/integration/` for the harness actually exercised by CI, which uses a purpose-built mock
server instead of a real Qualflare account.

## Running it against a real Qualflare account

```sh
cd examples/basic
npm install
QUALFLARE_TOKEN=<your-token> npm test
```

Set `environment` in `cucumber.json` (or `QUALFLARE_ENVIRONMENT`) to an environment that exists in
your Qualflare project — see [`../../docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md).

Once the run finishes, check your Qualflare project — you should see one new Launch with two Suites
(`login.feature`, `checkout.feature`), the login scenario carrying its labels/steps/parameters, and
two Cases for the checkout Scenario Outline (one per Examples row).
