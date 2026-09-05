import { Given } from '@cucumber/cucumber';
import { qualflare } from '../../../../../dist/index.js';

// A REAL PNG header, not arbitrary bytes: the reporter derives the MIME type
// from the declared type here (there is no file on disk), but the CLI's upload
// endpoint cross-checks the extension it is given, so the integration assertion
// verifies the written file really is a PNG.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

Given('a step that attaches a fake screenshot', async function () {
  qualflare.attachment('shot', PNG_MAGIC.toString('base64'), { encoding: 'base64', mimeType: 'image/png' });
});
