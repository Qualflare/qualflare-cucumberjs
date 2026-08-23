# qualflare-cucumberjs: standardized report output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove direct-POST from `@qualflare/cucumberjs` entirely — the formatter always writes a
standardized report directory (JSON + written video files, zero network calls), which
`qualflare-cli` becomes solely responsible for uploading.

**Architecture:** Mirrors the `@qualflare/cypress` plan exactly in shape, adapted for this
formatter's dual video source: a video attachment can arrive as either a real local file
(`qualflare.attachmentFromFile()`) or in-memory base64 content (`World.attach()` /
`qualflare.attachment()`) — cucumber-js has no Cypress-style "one recorded file per run" concept.
Both paths end up writing bytes into `outputDir` (copy for a real file, write-from-buffer for
in-memory content) and referencing the result via `localVideoPath`. `src/http/client.ts` and
everything that calls it are deleted.

**Tech Stack:** TypeScript, Vitest, tsup (dual ESM+CJS build), `@cucumber/cucumber` formatter API.

**Spec:** `../qualflare-cypress/docs/superpowers/specs/2026-08-24-native-sharded-collect-design.md`
(the design spec lives in the sibling `qualflare-cypress` repo, since that's where it was
authored — it explicitly covers both reporters).

## Global Constraints

- No backend (`api-service`) changes.
- Bump to `0.2.0` with a breaking-change CHANGELOG entry — no deprecation shim.
- `maxVideoBytes` stays; `token`, `uploadVideos`, `failOnUploadError` are removed entirely.
- Every existing non-video-related behavior (CI/git auto-detection, Doc Strings/Data Tables
  handling, hook tracking, attachment budget) is unchanged.
- Shard-index auto-detection here has a real, native signal cucumber-js already parses:
  `--shard INDEX/TOTAL`. Use it — don't fall back to generic CI-env guessing the way the
  `qualflare-cypress` plan has to (Cypress has no equivalent native flag).

---

## Task 1: `outputDir` replaces `outputFile`; `token`/`uploadVideos`/`failOnUploadError` removed; shard index read from `--shard`

**Files:**
- Modify: `src/config/resolve-config.ts`
- Test: `test/unit/resolve-config-output-file.test.ts`

**Interfaces:**
- Produces: `ResolvedFormatterConfig` gains `outputDir: string`, `shardIndex?: number`. Loses
  `token`, `uploadVideos`, `failOnUploadError`, `outputFile`.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/resolve-config-output-file.test.ts`:

```ts
describe('resolveConfig — outputDir', () => {
  it('defaults outputDir to ./qualflare-results', () => {
    const resolved = resolveConfig({})
    expect(resolved.outputDir).toBe('./qualflare-results')
  })

  it('honors an explicit outputDir option', () => {
    const resolved = resolveConfig({ outputDir: './custom-dir' })
    expect(resolved.outputDir).toBe('./custom-dir')
  })

  it('never throws for a missing token — token no longer exists', () => {
    expect(() => resolveConfig({})).not.toThrow()
  })

  it("reads shardIndex from cucumber-js's own --shard INDEX/TOTAL argv option", () => {
    // cucumber-js parses --shard itself and hands the formatter parsedArgvOptions;
    // confirm the exact property name/shape cucumber-js uses before writing this
    // test for real — check @cucumber/cucumber's IParsedArgvFormatOptions /
    // shard-related fields (grep the installed package's .d.ts under
    // node_modules/@cucumber/cucumber for "shard" first). Structure this test
    // against whatever that real shape turns out to be, e.g.:
    const resolved = resolveConfig({ shard: { index: 2, total: 4 } } as never)
    expect(resolved.shardIndex).toBe(2)
  })

  it('honors an explicit shardIndex option over --shard detection', () => {
    const resolved = resolveConfig({ shardIndex: 9 } as never)
    expect(resolved.shardIndex).toBe(9)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- resolve-config-output-file`
Expected: FAIL — `outputDir`/`shardIndex` don't exist yet, `resolveConfig({})` currently throws.

- [ ] **Step 3: Investigate cucumber-js's real `--shard` argv shape**

Before writing the implementation: run
`grep -rn "shard" node_modules/@cucumber/cucumber/lib/*.d.ts node_modules/@cucumber/cucumber/lib/**/*.d.ts`
(or check the installed version's docs) to find the exact field cucumber-js puts the parsed
`--shard INDEX/TOTAL` value under in the options object the formatter constructor receives
(`options.parsedArgvOptions` in `formatter.ts`). Update Step 1's test to match the real shape once
confirmed — the test as drafted above is a placeholder for that shape and MUST be corrected before
this task is considered done, not left as speculative.

- [ ] **Step 4: Rewrite `resolve-config.ts`**

In `QualflareCucumberOptions`, delete `failOnUploadError?: boolean;` and `uploadVideos?: boolean;`
(with their doc comments). Replace `token?: string;` and `outputFile?: string;` (with its doc
comment) with:

```ts
  /** Directory `finished()` writes this process's report file (and any
   * video attachments) into. Default `./qualflare-results`. Always active —
   * this formatter never uploads anything itself; `qualflare-cli` reads
   * whatever ends up in this directory. Every JSON file this process writes
   * is uniquely named, so multiple shards can safely share one `outputDir`
   * without colliding — see docs/LIMITATIONS.md. */
  outputDir?: string;
  /** This process's 0-based position among parallel shards of the same CI
   * run, stamped onto every case it reports. Auto-detected from
   * cucumber-js's own `--shard INDEX/TOTAL` flag when omitted — a normal
   * single-process run needs no shard concept at all. */
  shardIndex?: number;
```

In `ResolvedFormatterConfig`, remove `token: string;`, `failOnUploadError: boolean;`,
`uploadVideos: boolean;`, `outputFile?: string;`; add `outputDir: string;`, `shardIndex?: number;`.

In `resolveConfig`'s body, delete the token-throw block and replace the `outputFile` resolution
with:

```ts
  const outputDir = options.outputDir || firstEnv('QUALFLARE_OUTPUT_DIR') || './qualflare-results';
  const shardIndex = options.shardIndex ?? <the real field found in Step 3, e.g. options.shard?.index> ?? envInt('QUALFLARE_SHARD_INDEX');
```

Delete the `failOnUploadError`/`uploadVideos` lines from the returned object; replace `outputFile,`
with `outputDir,\n    shardIndex,`; remove `token,`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- resolve-config-output-file`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/resolve-config.ts test/unit/resolve-config-output-file.test.ts
git commit -m "feat(config): outputDir replaces outputFile; shardIndex from --shard; remove token/uploadVideos/failOnUploadError"
```

---

## Task 2: `video-uploader.ts` writes bytes into `outputDir` instead of uploading

**Files:**
- Modify: `src/formatter/video-uploader.ts`
- Test: `test/unit/video-uploader.test.ts` (new)

**Interfaces:**
- Consumes: `ResolvedFormatterConfig.outputDir` (Task 1).
- Produces: `writeVideoAttachment(pending: { path?: string; content?: string; mimeType?: string; name: string }, outputDir: string, maxVideoBytes: number): { localVideoPath: string; fileSize: number; mimeType: string } | undefined` — replaces `uploadVideoBytes`/`readVideoFile`. Keeps `resolveVideoMimeType` unchanged (still needed to determine the mime/extension pair).

- [ ] **Step 1: Write the failing test**

Create `test/unit/video-uploader.test.ts`:

```ts
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeVideoAttachment } from '../../src/formatter/video-uploader.js'

describe('writeVideoAttachment', () => {
  let tmpDir: string
  let outputDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-video-src-'))
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-video-out-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(outputDir, { recursive: true, force: true })
  })

  it('copies a real file into outputDir and returns localVideoPath', () => {
    const src = path.join(tmpDir, 'a.mp4')
    fs.writeFileSync(src, 'file-video-bytes')

    const result = writeVideoAttachment({ name: 'v', path: src }, outputDir, 1_000_000)

    expect(result).toBeDefined()
    expect(result!.mimeType).toBe('video/mp4')
    expect(fs.readFileSync(path.join(outputDir, result!.localVideoPath), 'utf8')).toBe('file-video-bytes')
  })

  it('writes in-memory base64 content into outputDir and returns localVideoPath', () => {
    const content = Buffer.from('memory-video-bytes').toString('base64')

    const result = writeVideoAttachment({ name: 'v', content, mimeType: 'video/mp4' }, outputDir, 1_000_000)

    expect(result).toBeDefined()
    expect(fs.readFileSync(path.join(outputDir, result!.localVideoPath), 'utf8')).toBe('memory-video-bytes')
  })

  it('skips oversized in-memory content without writing anything', () => {
    const content = Buffer.from('this-is-way-too-big').toString('base64')

    const result = writeVideoAttachment({ name: 'v', content, mimeType: 'video/mp4' }, outputDir, 3)

    expect(result).toBeUndefined()
    expect(fs.readdirSync(outputDir)).toHaveLength(0)
  })

  it('skips an unresolvable mime/extension pair', () => {
    const result = writeVideoAttachment({ name: 'v', content: 'eA==' }, outputDir, 1_000_000)
    expect(result).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- video-uploader`
Expected: FAIL — `writeVideoAttachment` doesn't exist.

- [ ] **Step 3: Rewrite `video-uploader.ts`**

Keep `VIDEO_MIME_TYPES_BY_EXTENSION`, `EXTENSION_BY_VIDEO_MIME_TYPE`, `ResolvedVideoMimeType`, and
`resolveVideoMimeType` exactly as they are — those are unchanged. Remove
`buildHttpOptions`/`VideoUploadResult`/`uploadVideoBytes`/`readVideoFile` and the now-unused
`SendOptions`/`PACKAGE_VERSION`/`ResolvedFormatterConfig` imports. Add:

```ts
import { randomUUID } from 'node:crypto';

export interface VideoWriteResult {
  /** Filename relative to the `outputDir` this was written into. */
  localVideoPath: string;
  fileSize: number;
  mimeType: string;
}

/**
 * Writes one pending video attachment's bytes into `outputDir` under a
 * unique filename — copying (`fs.copyFileSync`, Allure's
 * `FileSystemWriter.writeAttachmentFromPath` pattern) when it names a real
 * local file, or decoding+writing when it's in-memory base64 content (the
 * `World.attach()`/`qualflare.attachment()` path, which has no file to
 * copy). `qualflare-cli` uploads this file later, once it has a real auth
 * token — see the design spec.
 *
 * Best-effort: any failure (unsupported format, oversized, unreadable
 * source, write failure) is logged as a warning and resolves to `undefined`
 * rather than throwing.
 */
export function writeVideoAttachment(
  pending: { name: string; mimeType?: string; path?: string; content?: string },
  outputDir: string,
  maxVideoBytes: number,
): VideoWriteResult | undefined {
  const resolved = resolveVideoMimeType(pending.mimeType, pending.path);
  if (!resolved) {
    logger.warn(`skipping video attachment "${pending.name}": unsupported video format.`);
    return undefined;
  }

  const localVideoPath = `${randomUUID()}${resolved.extension}`;
  const destination = path.join(outputDir, localVideoPath);

  if (pending.path) {
    let fileSize: number;
    try {
      fileSize = fs.statSync(pending.path).size;
    } catch (err) {
      logger.warn(`skipping video attachment "${pending.path}": could not stat file: ${(err as Error).message}`);
      return undefined;
    }
    if (fileSize > maxVideoBytes) {
      logger.warn(
        `skipping video attachment "${pending.path}": ${fileSize} bytes exceeds the configured maxVideoBytes cap of ${maxVideoBytes} bytes.`,
      );
      return undefined;
    }
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.copyFileSync(pending.path, destination);
    } catch (err) {
      logger.warn(`skipping video attachment "${pending.path}": could not copy file: ${(err as Error).message}`);
      return undefined;
    }
    return { localVideoPath, fileSize, mimeType: resolved.mimeType };
  }

  if (pending.content !== undefined) {
    const fileSize = Buffer.byteLength(pending.content, 'base64');
    if (fileSize > maxVideoBytes) {
      logger.warn(
        `skipping video attachment "${pending.name}": ${fileSize} bytes exceeds the configured maxVideoBytes cap of ${maxVideoBytes} bytes.`,
      );
      return undefined;
    }
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(destination, Buffer.from(pending.content, 'base64'));
    } catch (err) {
      logger.warn(`skipping video attachment "${pending.name}": could not write file: ${(err as Error).message}`);
      return undefined;
    }
    return { localVideoPath, fileSize, mimeType: resolved.mimeType };
  }

  return undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- video-uploader`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/formatter/video-uploader.ts test/unit/video-uploader.test.ts
git commit -m "feat(video): write attachments into outputDir instead of uploading"
```

---

## Task 3: `attachment-budget.ts`'s `resolveVideoAttachment` uses `writeVideoAttachment`; `types.ts` gains `localVideoPath`

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/formatter/attachment-budget.ts`
- Modify: `test/unit/attachment-budget.test.ts`

**Interfaces:**
- Consumes: `writeVideoAttachment` (Task 2).
- Produces: `AttachmentBudgetConfig` loses `uploadVideos: boolean` and `httpOptions: SendOptions`,
  gains `outputDir: string`. `resolveVideoAttachment` becomes synchronous (no upload to await) —
  **check every call site before removing `async`**, since `attempt-tracker.ts`'s
  `pendingVideoUploads` machinery exists specifically to reconcile this function's async nature
  with cucumber-js's synchronous event stream (see Task 4) — decide there, not here, whether to
  keep it `async` for interface stability or simplify both together.

- [ ] **Step 1: Write the failing tests**

In `test/unit/attachment-budget.test.ts`, replace the existing `resolveVideoAttachment` describe
block's cases (search for `uploadVideos`/`storageKey` in that file) with:

```ts
it('routes a file-based video attachment through writeVideoAttachment and sets localVideoPath', async () => {
  const src = path.join(tmpDir, 'clip.mp4')
  fs.writeFileSync(src, 'video-bytes')

  const resolved = await resolveVideoAttachment(
    { name: 'clip', path: src, mimeType: 'video/mp4' },
    { attachScreenshots: true, maxAttachmentBytes: 1_000_000, maxTotalAttachmentBytes: 1_000_000, maxVideoBytes: 1_000_000, outputDir },
  )

  expect(resolved?.localVideoPath).toBeDefined()
  expect(resolved?.storageKey).toBeUndefined()
})

it('routes an in-memory video attachment through writeVideoAttachment', async () => {
  const content = Buffer.from('memory-bytes').toString('base64')

  const resolved = await resolveVideoAttachment(
    { name: 'clip', content, mimeType: 'video/mp4' },
    { attachScreenshots: true, maxAttachmentBytes: 1_000_000, maxTotalAttachmentBytes: 1_000_000, maxVideoBytes: 1_000_000, outputDir },
  )

  expect(resolved?.localVideoPath).toBeDefined()
})
```

Delete the old `uploadVideos: false` skip test and any test asserting `storageKey` gets set on the
resolved `Attachment`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- attachment-budget`
Expected: FAIL — `AttachmentBudgetConfig` has no `outputDir` yet, `resolveVideoAttachment` still
calls the deleted `uploadVideoBytes`/`readVideoFile`.

- [ ] **Step 3: Update `attachment-budget.ts`**

Change the import: `import { resolveVideoMimeType, writeVideoAttachment } from './video-uploader.js';`.
Remove the now-unused `SendOptions` import.

Change `AttachmentBudgetConfig`:
```ts
export interface AttachmentBudgetConfig {
  attachScreenshots: boolean;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
  maxVideoBytes: number;
  outputDir: string;
}
```

Replace the body of `resolveVideoAttachment` (from the `resolveVideoMimeType` call onward) with:

```ts
export async function resolveVideoAttachment(pending: PendingAttachment, config: AttachmentBudgetConfig): Promise<Attachment | undefined> {
  if (!config.attachScreenshots) {
    return undefined;
  }
  const written = writeVideoAttachment(pending, config.outputDir, config.maxVideoBytes);
  if (!written) {
    // writeVideoAttachment already logged why.
    return undefined;
  }
  return {
    name: pending.name,
    mimeType: written.mimeType,
    localVideoPath: written.localVideoPath,
    fileSize: written.fileSize,
    stepIndex: pending.stepIndex,
  };
}
```

(Kept `async`/`Promise<>` on the signature even though nothing inside awaits anymore, deliberately —
Task 4 decides whether `attempt-tracker.ts`'s async-reconciliation machinery around this call still
earns its keep once nothing here is genuinely asynchronous; changing the signature here without
also revisiting that caller would leave dead complexity on one side or a type mismatch on the
other.)

Add `localVideoPath?: string;` to `src/shared/types.ts`'s `Attachment` interface, next to
`storageKey`, with the same doc comment used in the `qualflare-cypress` plan's Task 3 (identical
wire meaning in both reporters).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- attachment-budget`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/formatter/attachment-budget.ts test/unit/attachment-budget.test.ts
git commit -m "feat(video): resolveVideoAttachment writes via writeVideoAttachment, sets localVideoPath"
```

---

## Task 4: `attempt-tracker.ts`'s async-video-upload reconciliation, revisited

**Files:**
- Modify: `src/formatter/attempt-tracker.ts`
- Test: `test/unit/attempt-tracker.test.ts`

**Interfaces:**
- Consumes: `resolveVideoAttachment` (Task 3, still `async` per that task's note).

- [ ] **Step 1: Read the current `pendingVideoUploads` machinery in full**

Read `src/formatter/attempt-tracker.ts` completely before touching it — the `pendingVideoUploads:
Promise<void>[]` array, the `finish()` method's await-all-pending-uploads logic, and every call
site of `resolveVideoAttachment`. This machinery exists to keep a scenario's report from being
built before its video finishes uploading. Now that `resolveVideoAttachment` never actually awaits
a network call (Task 3 made `writeVideoAttachment` synchronous under the hood), decide: does this
reconciliation logic still do meaningful work (e.g. file-write I/O could still in principle
outlive the synchronous call in edge cases with a very slow disk), or is it now pure ceremony
around a function that always resolves before the next microtask tick? Keep it if there's a real
reason (it's cheap insurance and already tested); simplify it only if leaving it would actively
mislead a future reader into thinking a real upload is still in flight there.

- [ ] **Step 2: Update the existing tests, if the code changes**

If Task 1's decision leaves `attempt-tracker.ts` unchanged (reconciliation logic kept as-is,
correctly, for the same reason it existed before), skip straight to Step 4 — there's nothing to
test-first here. If it changes, update `test/unit/attempt-tracker.test.ts`'s
video-attachment-related cases to match, following this file's existing test patterns (read it
first).

- [ ] **Step 3: Run the tests**

Run: `npm run test -- attempt-tracker`
Expected: PASS either way.

- [ ] **Step 4: Commit**

```bash
git add src/formatter/attempt-tracker.ts test/unit/attempt-tracker.test.ts
git commit -m "chore(attempt-tracker): confirm async-video reconciliation still correct post-write-not-upload"
```
(Skip this commit if Step 1 concluded no code change was needed — nothing to commit.)

---

## Task 5: `formatter.ts` always writes `outputDir`, stamps `shardIndex`, drops the HTTP path entirely

**Files:**
- Modify: `src/formatter/formatter.ts`
- Modify: `test/integration/run-cucumber-project.test.ts`

**Interfaces:**
- Consumes: `ResolvedFormatterConfig.outputDir`/`shardIndex` (Task 1).

- [ ] **Step 1: Write/update the failing integration test**

Read `test/integration/run-cucumber-project.test.ts` in full — it already runs a real cucumber-js
process against the fixture project and, per tonight's earlier video-upload work, already asserts
against the video-attachment fixture scenario (`attaches a video via qualflare.attachment()`).
Update the `outputFile mode (sharded-CI file-output path)` describe block (and the main upload
test) so:

- The main "uploads one Collect payload..." test now configures `outputDir` (not a token) and
  asserts against the JSON file `fs.readdirSync(outputDir)` finds, instead of a mocked
  `mock-collect-server.ts` POST. Check `test/integration/support/mock-collect-server.ts` — if
  nothing in the suite still needs a mock POST server after this change, note it for removal in a
  later task rather than leaving it half-used.
- The video-attachment assertion changes from checking `videoAttachment.storageKey` to checking
  `videoAttachment.localVideoPath`, and additionally asserts the referenced file exists on disk at
  `path.join(outputDir, videoAttachment.localVideoPath)` with the expected fake-video-bytes
  content.
- The `outputFile mode` describe block is renamed/merged into the main test, since there is no
  longer a separate mode — every run writes to `outputDir` now.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:integration`
Expected: FAIL — `formatter.ts` still branches on `config.outputFile` and POSTs otherwise.

- [ ] **Step 3: Rewrite `formatter.ts`**

Remove `import { QualflareHttpClient } from '../http/client.js';` and change
`import { buildHttpOptions } from './video-uploader.js';` — delete this import entirely, along
with the `{ ...this.config, httpOptions: buildHttpOptions(this.config) }` construction passed to
`AttemptTracker`; pass `this.config` directly instead (it already carries `outputDir`, which is all
`AttachmentBudgetConfig` needs now per Task 3).

Add `import * as path from 'node:path';` and `import { randomUUID } from 'node:crypto';`.

Replace `uploadResults()`'s body:

```ts
  private uploadResults(): void {
    const suites = groupIntoSuites(this.finishedCases, this.cwd, this.runHookTracker.buildSuite());
    if (suites.length === 0) {
      if (this.config.debug) {
        logger.debug('no scenarios reported — skipping file write.');
      }
      return;
    }
    const payload = buildCollectPayload(suites, this.config);
    if (this.config.shardIndex !== undefined) {
      for (const suite of payload.suites) {
        for (const c of suite.cases) {
          c.shardIndex = this.config.shardIndex;
        }
      }
    }

    fs.mkdirSync(this.config.outputDir, { recursive: true });
    const outputPath = path.join(this.config.outputDir, `${randomUUID()}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(payload));
    logger.info(`wrote Collect payload to ${outputPath} — run \`qualflare-cli collect ${this.config.outputDir}\` to upload it.`);
  }
```

(No longer `async` — nothing inside awaits once the HTTP POST is gone. Update its one call site,
`finished()`'s `await this.uploadResults();`, to drop the `await` — check whether that leaves
`finished()` itself needing to stay `async` for `super.finished()`'s own await; it does, leave the
method signature as-is.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:integration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/formatter/formatter.ts test/integration/run-cucumber-project.test.ts
git commit -m "feat(formatter): always write outputDir, stamp shardIndex, never POST"
```

---

## Task 6: Delete the HTTP client and every remaining reference to it

**Files:**
- Delete: `src/http/client.ts`
- Delete: `test/unit/http-client.test.ts`
- Modify: `test/integration/support/mock-collect-server.ts` (delete if Task 5 found nothing still
  needs it; otherwise leave it and note why in a commit message)
- Modify: `src/shared/constants.ts` (if it duplicates the same dead `HEADER_*` constants the
  `qualflare-cypress` plan's Task 5 removes there — check first, this repo's `constants.ts` may
  already differ)

- [ ] **Step 1: Confirm nothing else imports from `../http/client.js`**

Run: `grep -rn "http/client" src test`
Expected: only the files listed above, now that Tasks 2–5 have removed every other reference.

- [ ] **Step 2: Delete and verify**

```bash
rm src/http/client.ts test/unit/http-client.test.ts
rmdir src/http 2>/dev/null || true
```

Check `src/shared/constants.ts` for now-dead `HEADER_*` exports the same way the
`qualflare-cypress` plan's Task 5 does; remove any confirmed unused via
`grep -rn "HEADER_TOKEN\|HEADER_IDEMPOTENCY_KEY\|HEADER_CONTENT_TYPE\|HEADER_ACCEPT\|HEADER_USER_AGENT" src test`
first.

- [ ] **Step 3: Full verification pass**

Run: `npm run typecheck && npm run lint && npm run test && npm run test:integration`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete http/client.ts and every remaining reference to it"
```

---

## Task 7: Version bump and docs rewrite

**Files:**
- Modify: `package.json` (version `0.1.0` → `0.2.0`)
- Modify: `CHANGELOG.md`
- Modify: `README.md`, `docs/CONFIGURATION.md`, `docs/LIMITATIONS.md`

- [ ] **Step 1: Version bump and CHANGELOG**

Same shape as the `qualflare-cypress` plan's Task 6 Step 3 — bump `package.json` to `0.2.0`, add a
`## 0.2.0 — BREAKING` `CHANGELOG.md` entry covering: direct POST removed, `token`/`uploadVideos`/
`failOnUploadError` removed, `outputFile` → `outputDir`, `shardIndex` added (this repo:
auto-detected from `--shard INDEX/TOTAL`, not generic CI env — call this out explicitly since it
differs from the Cypress package).

- [ ] **Step 2: Rewrite the docs**

`README.md`'s "Known limitations" section: remove the "One `cucumber-js` process uploads as one
Launch by default..." bullet (same reasoning as the `qualflare-cypress` plan's Task 6 Step 4).
Rewrite the quick-start/CI example to show `outputDir` + a `qualflare-cli collect
./qualflare-results` step instead of a `token`-configured direct-POST setup.

`docs/CONFIGURATION.md`: remove `token`/`uploadVideos`/`failOnUploadError` rows, add
`outputDir`/`shardIndex` rows.

`docs/LIMITATIONS.md`: rewrite "Video upload" (no longer a presigned-URL upload the formatter
itself performs) and "One `cucumber-js` process = one Launch" (no more manual `outputFile` path
templating — `qualflare-cli collect <dir>` merges automatically now). Add the same "Stale-file
caveat" the `qualflare-cypress` plan's equivalent step documents: merging is based purely on which
files are in `outputDir` when `qualflare-cli collect` runs, no run-identity check, so a leftover
directory from a previous run gets silently merged into the current one — recommend clearing or
freshly creating `outputDir` at the start of each run (matching Allure's own `allure-results`
convention).

- [ ] **Step 3: Full verification pass**

Run: `npm run typecheck && npm run lint && npm run test && npm run test:integration`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: rewrite for standardized outputDir + qualflare-cli-only upload; bump to 0.2.0"
```
