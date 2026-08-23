import { Given } from '@cucumber/cucumber';
import { qualflare } from '../../../../../dist/index.js';

Given('a step that attaches a fake video clip', async function () {
  const fakeVideoBytes = Buffer.from('qualflare-cucumberjs-integration-test-fake-video-bytes');
  qualflare.attachment('clip', fakeVideoBytes.toString('base64'), { encoding: 'base64', mimeType: 'video/mp4' });
});
