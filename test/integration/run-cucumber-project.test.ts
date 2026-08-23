import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startMockCollectServer, type MockCollectServer } from './support/mock-collect-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(__dirname, 'fixtures', 'cucumber-project');

/** Real end-to-end coverage: spawns an actual `cucumber-js` run against the
 * fixture project in `fixtures/cucumber-project/`, pointed at a real local
 * HTTP server instead of the live Qualflare API, and asserts the single
 * captured POST body matches the wire contract byte-for-byte on the fields
 * that matter — not just "a request happened."
 *
 * Requires `npm run build` to have already produced `dist/` — the fixture
 * imports the built package (both the formatter and `qualflare`), not
 * TypeScript source.
 */
describe('qualflare-cucumberjs against a real cucumber-js run', () => {
  let server: MockCollectServer;

  beforeAll(async () => {
    server = await startMockCollectServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it(
    'uploads one Collect payload matching the wire contract, retrying through a forced 503 first',
    async () => {
      // Exercises the retry path and the final payload shape in the same
      // run: the queued 503 forces the formatter's http client to retry
      // once, so we expect exactly 2 requests here, both carrying the SAME
      // Idempotency-Key (proving the key is stable across retries, not
      // regenerated), with the second succeeding.
      server.queueStatus(503);

      const result = await execa('npx', ['cucumber-js'], {
        cwd: fixtureDir,
        env: {
          ...process.env,
          QUALFLARE_TOKEN: 'test-token',
          QUALFLARE_API_ENDPOINT: server.url,
        },
        // Several fixture scenarios fail by design (failing.feature,
        // hook-failure.feature, the first attempt of retried-flaky.feature)
        // — assert on the captured payload, not cucumber-js's exit code.
        reject: false,
      });

      if (server.requests.length === 0) {
        throw new Error(
          `cucumber-js run produced no captured requests at all — it likely failed to even start. ` +
            `exit code: ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        );
      }

      expect(server.requests).toHaveLength(2);
      const [first, second] = server.requests;

      const firstKey = first!.headers['idempotency-key'];
      const secondKey = second!.headers['idempotency-key'];
      expect(firstKey).toBeTypeOf('string');
      expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i);
      expect(secondKey).toBe(firstKey);

      for (const req of server.requests) {
        expect(req.headers['qf_token']).toBe('test-token');
        expect(req.headers['content-type']).toMatch(/^application\/json/);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the captured body is untyped JSON from the wire, asserted field-by-field below
      const collect = second!.body as any;

      expect(collect.framework).toBe('cucumber');
      expect(collect.platform).toBe('web');
      expect(collect.branch).toBeNull();
      expect(collect.commit).toBeNull();
      expect(typeof collect.os).toBe('string');
      expect(Array.isArray(collect.suites)).toBe(true);
      expect(collect.suites.length).toBeGreaterThan(0);
      for (const suite of collect.suites) {
        if (suite.name !== '(global hooks)') {
          expect(suite.category).toBe('cucumber');
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allCases = collect.suites.flatMap((s: any) => s.cases as any[]);
      expect(allCases.length).toBeGreaterThan(0);

      const passing = allCases.find((c) => c.name === 'passes normally');
      expect(passing).toBeDefined();
      expect(passing.status).toBe('passed');
      expect(passing.retryCount ?? 0).toBe(0);

      const failing = allCases.find((c) => c.name === 'fails with a recognizable error message');
      expect(failing).toBeDefined();
      expect(failing.status).toBe('failed');
      expect(typeof failing.error).toBe('string');
      expect(failing.error).toContain('qualflare-cucumberjs-integration-test-marker');

      const flaky = allCases.find((c) => c.name === 'is flaky and eventually passes');
      expect(flaky).toBeDefined();
      expect(flaky.status).toBe('passed');
      expect(flaky.retryCount).toBe(1);
      expect(flaky.isFlaky).toBe(true);
      // One collapsed Case, not two — the whole point of retry-collapsing.
      expect(allCases.filter((c) => c.name === 'is flaky and eventually passes')).toHaveLength(1);

      // Regression coverage for the Before-hook-failure attribution: the
      // scenario's Before hook throws before the step body ever runs — the
      // failure must still surface as this Case's own failed status/error,
      // not silently vanish.
      const hookFailureCase = allCases.find(
        (c) => c.name === 'never runs its body because the guarding Before hook fails first',
      );
      expect(hookFailureCase).toBeDefined();
      expect(hookFailureCase.status).toBe('failed');
      expect(typeof hookFailureCase.error).toBe('string');
      expect(hookFailureCase.error).toContain('qualflare-cucumberjs-integration-test-hook-failure-marker');
      // The failing Before hook itself shows up as a synthetic step.
      expect(hookFailureCase.steps.some((s) => s.keyword === 'Before' && s.status === 'failed')).toBe(true);

      // Scenario Outline: each Examples row becomes its own Case, with the
      // row's values folded into Case.properties automatically.
      const outlineCases = allCases.filter((c) => c.name.startsWith('adds '));
      expect(outlineCases).toHaveLength(2);
      const row1 = outlineCases.find((c) => c.properties?.a === '1');
      expect(row1).toBeDefined();
      expect(row1.status).toBe('passed');
      expect(row1.properties).toMatchObject({ a: '1', b: '2', sum: '3' });
      const row2 = outlineCases.find((c) => c.properties?.a === '4');
      expect(row2).toBeDefined();
      expect(row2.properties).toMatchObject({ a: '4', b: '5', sum: '9' });

      // Data Table / Doc String — no dedicated wire field, encoded as a
      // Parameter on the step (see docs/LIMITATIONS.md).
      const tableCase = allCases.find((c) => c.name === 'a step with a data table');
      expect(tableCase).toBeDefined();
      const tableStep = tableCase.steps.find((s) => s.parameters?.some((p) => p.name === 'dataTable'));
      expect(tableStep).toBeDefined();
      const dataTableParam = tableStep.parameters.find((p) => p.name === 'dataTable');
      expect(JSON.parse(dataTableParam.value)).toEqual([
        ['name', 'role'],
        ['Alice', 'admin'],
        ['Bob', 'user'],
      ]);

      const docStringCase = allCases.find((c) => c.name === 'a step with a doc string');
      expect(docStringCase).toBeDefined();
      const docStep = docStringCase.steps.find((s) => s.parameters?.some((p) => p.name === 'docString'));
      expect(docStep).toBeDefined();
      expect(docStep.parameters.find((p) => p.name === 'docString').value).toContain('hello from a doc string');

      const metadataCase = allCases.find((c) => c.name === 'exercises the author-facing metadata calls');
      expect(metadataCase).toBeDefined();
      expect(metadataCase.labels).toEqual(expect.arrayContaining([{ name: 'epic', value: 'Integration Testing' }]));
      expect(metadataCase.tags).toEqual(expect.arrayContaining(['smoke', 'qualflare-cucumberjs-self-test']));
      expect(metadataCase.description).toContain('Exercises the qualflare.* metadata API');
      expect(metadataCase.links?.[0]).toMatchObject({ type: 'issue', url: 'https://example.com/issue/1' });
      // A parameter() call outside any step lands in Case.properties.
      expect(metadataCase.properties?.['outside-step-param']).toBe('outside-value');
      // A parameter() call inside qualflare.step() lands on that step's parameters[].
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the wire, see the `collect` cast above
      const manualStep = (metadataCase.steps as any[] | undefined)?.find((s) => s.name === 'a manual step');
      expect(manualStep).toBeDefined();
      expect(manualStep.parameters).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'inside-step-param', value: 'inside-value' })]),
      );
      // A real qualflare.attachment() call.
      expect(metadataCase.attachments).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'note', mimeType: 'text/plain' })]),
      );

      // A real qualflare.attachment() call with video content — must have
      // gone through the presigned-upload-URL flow (storageKey, no inline
      // content), not the inline-base64 path every other attachment above
      // takes.
      const videoCase = allCases.find((c) => c.name === 'attaches a video via qualflare.attachment()');
      expect(videoCase).toBeDefined();
      expect(videoCase.attachments).toHaveLength(1);
      const videoAttachment = videoCase.attachments[0];
      expect(videoAttachment.mimeType).toBe('video/mp4');
      expect(videoAttachment.content).toBeUndefined();
      expect(typeof videoAttachment.storageKey).toBe('string');
      expect(videoAttachment.storageKey.length).toBeGreaterThan(0);

      // The server actually received a presign request AND the PUT — not
      // just a storageKey the client invented without uploading anything.
      expect(server.uploads).toHaveLength(1);
      const upload = server.uploads[0]!;
      expect(upload.storageKey).toBe(videoAttachment.storageKey);
      expect(upload.contentType).toBe('video/mp4');
      expect(upload.body.toString('utf8')).toBe('qualflare-cucumberjs-integration-test-fake-video-bytes');

      // Every OTHER attachment in this run still takes the inline path —
      // the video-routing change didn't leak into non-video attachments.
      for (const c of allCases) {
        if (c === videoCase) {
          continue;
        }
        for (const att of c.attachments ?? []) {
          expect(att.mimeType).not.toMatch(/^video\//);
          expect(att.storageKey).toBeUndefined();
        }
      }
    },
    120_000,
  );

  describe('outputFile mode (sharded-CI file-output path)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qualflare-cucumberjs-output-file-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it(
      'writes the Collect JSON to disk instead of uploading, and makes zero requests to the server',
      async () => {
        const outputFile = path.join(tmpDir, 'shard-0.json');
        const requestCountBefore = server.requests.length;
        const uploadCountBefore = server.uploads.length;

        // Deliberately NO QUALFLARE_TOKEN — outputFile mode never
        // authenticates, so resolveConfig must not throw its usual
        // no-token error here (see resolve-config-output-file.test.ts for
        // the unit-level version of this same assertion). Explicitly
        // deleted (not set to `undefined`) so this doesn't depend on
        // execa/child_process's undefined-env-value handling.
        const env = { ...process.env, QUALFLARE_API_ENDPOINT: server.url, QUALFLARE_OUTPUT_FILE: outputFile };
        delete env.QUALFLARE_TOKEN;
        delete env.QF_TOKEN;

        const result = await execa('npx', ['cucumber-js'], {
          cwd: fixtureDir,
          env,
          reject: false,
        });

        if (!fs.existsSync(outputFile)) {
          throw new Error(
            `cucumber-js run did not produce ${outputFile}. exit code: ${result.exitCode}\n` +
              `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
          );
        }

        // The mock server received nothing from this run — file mode never
        // constructs an HTTP client at all.
        expect(server.requests.length).toBe(requestCountBefore);

        // Regression check for a real bug found in self-review: this
        // fixture project's video-attachment.feature scenario (a real
        // qualflare.attachment() call with video content) previously still
        // triggered a presign+PUT attempt even in outputFile mode, since
        // uploadVideos defaulted true and nothing gated the video-upload
        // path on outputFile. Checking server.uploads specifically (not
        // just server.requests, which only counts /collect) is the point —
        // the original bug shipped a test that only checked requests and
        // passed anyway.
        expect(server.uploads.length).toBe(uploadCountBefore);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON read back from disk, asserted field-by-field below
        const collect = JSON.parse(fs.readFileSync(outputFile, 'utf8')) as any;
        expect(collect.framework).toBe('cucumber');
        expect(Array.isArray(collect.suites)).toBe(true);
        expect(collect.suites.length).toBeGreaterThan(0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allCases = collect.suites.flatMap((s: any) => s.cases as any[]);
        expect(allCases.some((c) => c.name === 'passes normally')).toBe(true);

        // The video-attachment scenario's attachment was skipped entirely
        // (not uploaded, not inlined) — mirrors uploadVideos: false's
        // existing behavior.
        const videoCase = allCases.find((c) => c.name === 'attaches a video via qualflare.attachment()');
        expect(videoCase).toBeDefined();
        expect(videoCase.attachments ?? []).toHaveLength(0);
      },
      120_000,
    );
  });
});
