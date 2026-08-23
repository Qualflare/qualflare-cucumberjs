import assert from 'node:assert';
import { Given, When, Then } from '@cucumber/cucumber';
import { qualflare } from '@qualflare/cucumberjs';

// A real project would drive a browser (e.g. Playwright) here — this example
// keeps things dependency-free by simulating the login flow with plain
// assertions, so it only needs @cucumber/cucumber and @qualflare/cucumberjs
// installed.

Given('a user with valid credentials', function () {
  qualflare.label('epic', 'Authentication');
  this.credentials = { email: 'user@example.com', password: 'correct-horse-battery-staple' };
});

When('they submit the login form', async function () {
  await qualflare.step('fill in credentials', async () => {
    qualflare.parameter('email', this.credentials.email);
    // ...cy.get('#email').type(...) / this.page.fill('#email', ...) in a real project
  });

  await qualflare.step('submit and wait for redirect', async () => {
    this.loggedIn = true;
  });
});

Then('they land on the dashboard', function () {
  assert.strictEqual(this.loggedIn, true);
});
