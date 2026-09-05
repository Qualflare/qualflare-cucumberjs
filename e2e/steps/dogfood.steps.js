import * as assert from 'node:assert/strict';

import { Given, Then, When } from '@cucumber/cucumber';

// The BUILT dist/, for the same reason the integration fixture does: it
// exercises the compiled output a real consumer gets, not the TS source.
import { qualflare } from '../../dist/index.js';
import { createCart } from '../app/cart.mjs';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let cart;

Given('the cart is empty', function () {
  cart = createCart();
});

When('I add {int} {string} at {int}', function (qty, name, unitPrice) {
  cart.add(name, qty, unitPrice);
});

When('I add {int} {string} at {int} inside nested steps', async function (qty, name, unitPrice) {
  await qualflare.step('outer', async () => {
    qualflare.parameter('scope', 'outer');
    await qualflare.step('inner', () => {
      cart.add(name, qty, unitPrice);
    });
  });
});

Then('the total is {int}', function (expected) {
  assert.equal(cart.total(), expected);
});

Given('a scenario that records every metadata field', function () {
  qualflare.label('team', 'platform');
  qualflare.link('https://github.com/Qualflare/qualflare-cucumberjs', {
    type: 'custom',
    name: 'repository',
  });
  qualflare.tag('dogfood');
  qualflare.description('Exercises every metadata call the README documents.');
  qualflare.priority('high');
  qualflare.parameter('plan', 'enterprise');
});

// Redacted AT SOURCE -- the value never reaches the report. verify-report.mjs
// asserts the secret is absent from the whole payload, which is the only
// assertion that can prove that.
Given('a scenario that records a masked parameter', function () {
  qualflare.parameter('apiKey', 'qf-dogfood-secret-value', { masked: true });
});

// A real PNG header, not arbitrary bytes: the CLI's upload endpoint
// cross-checks the extension against the MIME type, so the verifier asserts the
// written file really is a PNG rather than merely named one.
Given('a scenario that attaches a fake screenshot', function () {
  qualflare.attachment('screenshot', PNG_MAGIC.toString('base64'), {
    encoding: 'base64',
    mimeType: 'image/png',
  });
});

// Retries are scoped by the @flaky tag (retryTagFilter in cucumber.json), so a
// GENUINE regression in any other scenario is never re-run and quietly greened.
//
// cucumber-js exposes no attempt index to a step, so this is a module-level
// counter -- the same approach the integration fixture uses and proves across
// the whole version matrix. Its failure mode is "red every time", never flake.
// Deliberately NOT a marker file on disk: that survives an interrupted run and
// silently makes the next run's first attempt pass, turning this into a no-op.
let attempts = 0;
Given('a step that fails once then passes', function () {
  attempts += 1;
  if (attempts === 1) {
    throw new Error('dogfood-intentional-retry-marker');
  }
});

Then('the metadata calls did not throw', function () {
  assert.ok(true);
});

Then('the attachment call did not throw', function () {
  assert.ok(true);
});

