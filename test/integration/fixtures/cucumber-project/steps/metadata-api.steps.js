import { Given } from '@cucumber/cucumber';
import { qualflare } from '../../../../../dist/index.js';

Given('a step that exercises the qualflare metadata API', async function () {
  qualflare.label('epic', 'Integration Testing');
  qualflare.tag('smoke', 'qualflare-cucumberjs-self-test');
  qualflare.description('Exercises the qualflare.* metadata API end-to-end.');
  qualflare.link('https://example.com/issue/1', { type: 'issue' });
  qualflare.parameter('outside-step-param', 'outside-value');

  await qualflare.step('a manual step', async () => {
    qualflare.parameter('inside-step-param', 'inside-value');
  });

  qualflare.attachment('note', 'hello from qualflare.attachment()', { mimeType: 'text/plain' });
});
