import assert from 'node:assert';
import { Given, When, Then } from '@cucumber/cucumber';
import { qualflare } from '@qualflare/cucumberjs';

Given('a cart total of {int}', function (total) {
  qualflare.label('epic', 'Checkout');
  this.total = total;
});

When('the discount code {string} is applied', function (code) {
  qualflare.tag('discounts');
  if (code === 'SAVE10') {
    this.total = this.total * 0.9;
  }
});

Then('the final total is {int}', function (expected) {
  assert.strictEqual(this.total, expected);
});
