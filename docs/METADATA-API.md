# Author-facing metadata API

```ts
import { qualflare } from '@qualflare/cucumberjs';
```

Everything on `qualflare` is safe to call from anywhere inside a running step definition or a
`Before`/`After`/`BeforeStep`/`AfterStep` hook. Calling any of these outside a running scenario (e.g.
at module-load time, or from `BeforeAll`/`AfterAll`, which have no "current scenario") logs a warning
and no-ops — it never throws or aborts the run.

## `qualflare.label(name, value)`

Attaches an arbitrary label. `epic`/`feature`/`story`/`owner`/`severity` are just conventional
names — any string works. (The Feature name and, if applicable, the `Rule:` name are already added
automatically as `feature`/`rule` labels — no need to set those yourself.)

```ts
Given('a logged-in user', function () {
  qualflare.label('epic', 'Authentication');
  qualflare.label('owner', 'platform-team');
  // ...
});
```

Capped at 100 labels per scenario; further calls beyond the cap are dropped with a one-time warning.

## `qualflare.link(url, opts?)`

Attaches a typed external link.

```ts
qualflare.link('https://github.com/org/repo/issues/42', { type: 'issue', name: 'Known flaky login' });
qualflare.link('https://your-tms.example.com/cases/TC-123', { type: 'tms' });
qualflare.link('https://internal-wiki.example.com/runbook'); // type defaults to 'custom'
```

`opts.type` is one of `'issue' | 'tms' | 'custom'`, defaulting to `'custom'`. Capped at 20 links per scenario.

## `qualflare.tag(...tags)`

```ts
qualflare.tag('smoke', 'critical-path');
```

Variadic — pass one or several tags in one call. Merged with the scenario's own Gherkin `@tag`s
(already inherited from the Feature/Rule by cucumber-js itself). Capped at 64 tags per scenario
(further calls beyond the cap are dropped with a one-time warning); an individual tag longer than
255 characters is truncated, not dropped.

## `qualflare.description(text)`

Sets the scenario's description. Last call wins if invoked more than once in the same scenario. Falls
back to the Gherkin scenario's own description text (if any) when never called.

```ts
qualflare.description('Verifies the standard email/password login flow against a seeded test account.');
```

## `qualflare.priority(value)`

Sets the scenario's priority. Last call wins if invoked more than once in the same scenario.

```ts
qualflare.priority('critical');
```

`value` is one of `'low' | 'medium' | 'high' | 'critical'`. Not runtime-validated on the client —
an unrecognized value is normalized or dropped server-side rather than rejecting the upload.

## `qualflare.parameter(name, value?, opts?)`

```ts
qualflare.parameter('userId', '12345');
qualflare.parameter('apiKey', secretValue, { masked: true });
```

**Placement depends on context**: called while a `qualflare.step()` is currently open, the parameter
attaches to that step's `parameters[]` (masking respected there). Called outside any open step, it
becomes a `Case.properties` entry instead — the wire contract has no scenario-level `Parameter[]`,
only `Step.parameters` — and `masked` has no effect in that case (see
[`docs/LIMITATIONS.md`](./LIMITATIONS.md)). Note: for a Scenario Outline, each Examples row's own
column values are already folded into `Case.properties` automatically — `qualflare.parameter()`
outside a step adds to, rather than replaces, those.

```ts
Given('a payment is submitted', async function () {
  qualflare.parameter('environment', 'sandbox'); // -> Case.properties.environment

  await qualflare.step('submit payment form', async () => {
    qualflare.parameter('cardLast4', '4242'); // -> this step's parameters[]
    await this.page.fill('#card-number', '4242424242424242');
    await this.page.click('#submit');
  });
});
```

`masked` is a **display hint only** — the server does not redact the value. Do not rely on it for
real secret protection.

## `qualflare.attachment(name, content, opts?)`

Attaches text/JSON/binary content you already have in memory.

```ts
qualflare.attachment('response.json', JSON.stringify(responseBody), { mimeType: 'application/json' });
qualflare.attachment('logo.png', base64PngString, { encoding: 'base64', mimeType: 'image/png' });
```

`opts.encoding` defaults to `'utf8'` (the string is base64-encoded for you before upload); pass
`'base64'` if `content` is already base64 text. Capped at 50 attachments per case (shared with
`attachmentFromFile()` and any real `this.attach()` call you make yourself in the same scenario — see
[`docs/LIMITATIONS.md`](./LIMITATIONS.md) for how the caps interact), and subject to the same
per-attachment/per-run size budgets (`maxAttachmentBytes`/`maxTotalAttachmentBytes`, see
[`docs/CONFIGURATION.md`](./CONFIGURATION.md)).

## `qualflare.attachmentFromFile(name, path, opts?)`

Attaches a file already on disk (e.g. a file your test downloaded or generated) by path — the bytes
are read Node-side at upload time, size-guarded the same way in-memory attachments are.

```ts
qualflare.attachmentFromFile('exported-report.pdf', '/tmp/report.pdf', { mimeType: 'application/pdf' });
```

## Real `this.attach()` calls are captured automatically

Unlike Cypress (which has built-in on-failure screenshot capture), cucumber-js has no automatic
attachment mechanism of its own — any screenshot capture is something you write yourself, typically
in an `After` hook (e.g. with a browser driver like Playwright):

```ts
After(async function ({ result }) {
  if (result?.status === Status.FAILED) {
    const screenshot = await this.page.screenshot();
    await this.attach(screenshot, 'image/png'); // uploaded automatically, no qualflare.* call needed
  }
});
```

Every real `this.attach()` call you already make is captured and uploaded automatically (gated by
`attachScreenshots`, see [`docs/CONFIGURATION.md`](./CONFIGURATION.md)) — no code changes required to
get it reported.

## `qualflare.step(name, fn)`

Wraps an `async` block as a named, reportable step.

```ts
Given('the checkout flow completes', async function () {
  await qualflare.step('add item to cart', async () => {
    await this.page.click('[data-testid=add-to-cart]');
  });

  await qualflare.step('fill shipping details', async () => {
    await this.page.fill('#name', 'Jane Doe');
    await this.page.fill('#address', '123 Main St');
  });
});
```

**Nesting**: calling `qualflare.step()` while another `qualflare.step()` is already open nests it
under the outer one, to arbitrary depth.

```ts
await qualflare.step('checkout flow', async () => {
  await qualflare.step('enter payment details', async () => {
    await this.page.fill('#card', '4242424242424242');
  });
  await qualflare.step('confirm order', async () => {
    await this.page.click('#confirm');
  });
});
```

Unlike `@qualflare/cypress` (where a step's start time is a documented approximation, since Cypress's
own command queue defers execution), a cucumber-js step definition is already a plain `async
function` — `qualflare.step()`'s timing is the real, exact wall-clock span of the `await`ed body, not
an approximation.
