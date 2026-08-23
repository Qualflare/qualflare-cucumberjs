import { Given } from '@cucumber/cucumber';

let attempts = 0;

Given('a step that fails once then passes', function () {
  attempts += 1;
  if (attempts === 1) {
    throw new Error('qualflare-cucumberjs-integration-test-flaky-marker');
  }
});
