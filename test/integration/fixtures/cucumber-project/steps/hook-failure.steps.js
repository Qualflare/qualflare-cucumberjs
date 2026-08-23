import { Given, Before } from '@cucumber/cucumber';

Before({ tags: '@hook-failure' }, function () {
  throw new Error('qualflare-cucumberjs-integration-test-hook-failure-marker');
});

Given('a step that never runs', function () {
  throw new Error('this step body should never execute');
});
