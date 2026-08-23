import assert from 'node:assert';
import { Given, Then } from '@cucumber/cucumber';

Given('the numbers {int} and {int}', function (a, b) {
  this.a = a;
  this.b = b;
});

Then('the sum is {int}', function (sum) {
  assert.strictEqual(this.a + this.b, sum);
});
