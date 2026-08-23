import { Given } from '@cucumber/cucumber';

Given('a step that fails with a marker', function () {
  throw new Error('qualflare-cucumberjs-integration-test-marker');
});
