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
  // The mock server is kept ONLY as a tripwire: this formatter must make
  // zero requests now, so a server that captures anything at all is a
  // regression. It is deliberately NOT the source of the payload any more.
  let server: MockCollectServer;
  let outputDir: string;

  beforeAll(async () => {
    server = await startMockCollectServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qualflare-cucumberjs-output-'));
  });

  afterEach(() => {
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it(
    'writes one Collect report into outputDir matching the wire contract, making zero requests',
    async () => {
      const requestCountBefore = server.requests.length;
      const uploadCountBefore = server.uploads.length;

      // Deliberately NO token of any kind — this formatter never
      // authenticates, so resolveConfig must not demand one. Explicitly
      // deleted (not set to `undefined`) so this doesn't depend on
      // execa/child_process's undefined-env-value handling.
      const env = {
        ...process.env,
        // Deliberately still pointed at the mock server even though
        // apiEndpoint is gone as an option: if any upload path somehow
        // survived, this is where it would land, and the tripwire below
        // would catch it.
        QUALFLARE_API_ENDPOINT: server.url,
        QUALFLARE_OUTPUT_DIR: outputDir,
      };
      delete env.QUALFLARE_TOKEN;
      delete env.QF_TOKEN;

      const result = await execa('npx', ['cucumber-js'], {
        cwd: fixtureDir,
        env,
        // Several fixture scenarios fail by design (failing.feature,
        // hook-failure.feature, the first attempt of retried-flaky.feature)
        // — assert on the written payload, not cucumber-js's exit code.
        reject: false,
      });

      const reports = fs.readdirSync(outputDir).filter((f) => f.endsWith('.json'));
      if (reports.length === 0) {
        throw new Error(
          `cucumber-js run produced no report in ${outputDir} — it likely failed to even start. ` +
            `exit code: ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        );
      }
      // Exactly one report per process, no matter how many scenarios ran.
      expect(reports).toHaveLength(1);

      // The tripwire: this formatter constructs no HTTP client at all, so
      // neither /collect nor the old presign+PUT flow may be touched.
      // Checking uploads specifically (not just requests, which only counts
      // /collect) is the point — an earlier version of this suite checked
      // only requests and passed while videos were still being uploaded.
      expect(server.requests.length).toBe(requestCountBefore);
      expect(server.uploads.length).toBe(uploadCountBefore);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON read back from disk, asserted field-by-field below
      const collect = JSON.parse(fs.readFileSync(path.join(outputDir, reports[0]!), 'utf8')) as any;

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
      // been written into outputDir and referenced by localVideoPath, not
      // inlined as base64 and not uploaded.
      const videoCase = allCases.find((c) => c.name === 'attaches a video via qualflare.attachment()');
      expect(videoCase).toBeDefined();
      expect(videoCase.attachments).toHaveLength(1);
      const videoAttachment = videoCase.attachments[0];
      expect(videoAttachment.mimeType).toBe('video/mp4');
      expect(videoAttachment.content).toBeUndefined();
      expect(videoAttachment.storageKey).toBeUndefined();
      expect(typeof videoAttachment.localVideoPath).toBe('string');

      // The referenced file really exists next to the report, with the
      // exact bytes the fixture attached — localVideoPath is a promise
      // qualflare-cli has to be able to keep at collect time.
      const videoPath = path.join(outputDir, videoAttachment.localVideoPath);
      expect(fs.existsSync(videoPath)).toBe(true);
      expect(fs.readFileSync(videoPath, 'utf8')).toBe('qualflare-cucumberjs-integration-test-fake-video-bytes');
      expect(videoAttachment.fileSize).toBe(fs.statSync(videoPath).size);

      // Every OTHER attachment in this run still takes the inline path —
      // the video-routing change didn't leak into non-video attachments.
      for (const c of allCases) {
        if (c === videoCase) {
          continue;
        }
        for (const att of c.attachments ?? []) {
          expect(att.mimeType).not.toMatch(/^video\//);
          expect(att.storageKey).toBeUndefined();
          expect(att.localVideoPath).toBeUndefined();
        }
      }
    },
    120_000,
  );

});
