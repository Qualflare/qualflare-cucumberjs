import * as fs from 'node:fs';
import * as path from 'node:path';

import { logger } from '../shared/logger.js';
import type { Attachment } from '../shared/types.js';
import { writeImageAttachment, writeVideoAttachment } from './video-writer.js';

/** Extensions/mime-prefixes routed through the video-upload flow
 * (`resolveVideoAttachment`) instead of the inline-base64 path below.
 * Broader than the server's own MIME allowlist (`.avi`/`.mkv` included) so
 * this still correctly IDENTIFIES a video attachment even in a format the
 * server can't accept — `resolveVideoAttachment`/`resolveVideoMimeType` is
 * what actually enforces the narrower allowlist and warns/skips a format
 * outside it. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv']);

export interface AttachmentBudgetConfig {
  attachScreenshots: boolean;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
  maxVideoBytes: number;
  outputDir: string;
}

/** One `World.attach()` call (real user attachment, or `qualflare.attachment
 * ()`/`attachmentFromFile()`), not yet resolved into a wire `Attachment`.
 * Exactly one of `content`/`path` is set — `content` for cucumber-js's
 * native in-memory delivery (a Buffer/base64 string, the common case for
 * real `World.attach()` calls) or `qualflare.attachment()`; `path` only for
 * `qualflare.attachmentFromFile()`, cucumber-js itself never delivers a bare
 * file path. */
export interface PendingAttachment {
  name: string;
  mimeType?: string;
  stepIndex?: number;
  /** Base64-encoded. */
  content?: string;
  path?: string;
}

/**
 * Running total of ENCODED inline attachment bytes for this process, so a single
 * pathological run can't push a launch past the server's body limit.
 *
 * Encoded, not raw, because base64 is what actually travels and what the limit is
 * measured against. Counting raw bytes made the cap mean 4/3 more than it said: a
 * fully-used 10,000,000-byte budget is 13,333,336 bytes of `content`, which is
 * 1.27x `/collect`'s BodyLimit(10<<20) = 10,485,760. See `base64Length`.
 */
/**
 * Length of `Buffer.toString("base64")` without producing it.
 *
 * base64 emits 4 characters per 3 input bytes, padded up. Computed arithmetically
 * so the budget can be checked BEFORE a large buffer is encoded, rather than
 * allocating the string only to discard it.
 */
export function base64Length(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

export class AttachmentBudget {
  private used = 0;

  constructor(private readonly maxTotalBytes: number) {}

  /** Atomically checks-and-reserves `bytes` against the remaining budget.
   * Returns false (reserving nothing) if it would exceed the total. */
  tryReserve(bytes: number): boolean {
    if (this.used + bytes > this.maxTotalBytes) {
      return false;
    }
    this.used += bytes;
    return true;
  }

  get usedBytes(): number {
    return this.used;
  }
}

type ReadResult = { skipped: false; content: string } | { skipped: true; reason: string };

export function isVideoLike(mimeType: string | undefined, filePath: string | undefined): boolean {
  if (mimeType?.toLowerCase().startsWith('video/')) {
    return true;
  }
  if (filePath && VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return true;
  }
  return false;
}

function readAttachmentFile(filePath: string, maxAttachmentBytes: number, budget: AttachmentBudget): ReadResult {
  let size: number;
  try {
    // Stat BEFORE reading — an oversized file must never be loaded into
    // memory just to discover it should be skipped.
    size = fs.statSync(filePath).size;
  } catch (err) {
    return { skipped: true, reason: `could not stat file: ${(err as Error).message}` };
  }
  if (size > maxAttachmentBytes) {
    return {
      skipped: true,
      reason: `${size} bytes exceeds the configured per-attachment cap of ${maxAttachmentBytes} bytes`,
    };
  }
  const encoded = base64Length(size);
  if (!budget.tryReserve(encoded)) {
    return {
      skipped: true,
      reason: `would exceed this run's total attachment budget (${budget.usedBytes} encoded bytes already used; this one needs ${encoded})`,
    };
  }
  try {
    const content = fs.readFileSync(filePath).toString('base64');
    return { skipped: false, content };
  } catch (err) {
    return { skipped: true, reason: `could not read file: ${(err as Error).message}` };
  }
}

/**
 * Resolves one NON-video pending attachment into a wire `Attachment`, or
 * `undefined` if it should be skipped entirely (per the plan's resolved
 * decision — an oversized/over-budget attachment is dropped, not degraded
 * to a contentless stub, since the server's `path` field is explicitly
 * informational/never-fetched). Unlike `@qualflare/cypress`'s
 * `resolveAttachments()` (which batch-resolves a Case's whole array at
 * case-finish time), this resolves one attachment at a time as its
 * `attachment` envelope arrives — matching cucumber-js's per-envelope
 * event stream.
 *
 * Callers MUST check `isVideoLike()` first and route a video-like pending
 * attachment to `resolveVideoAttachment()` instead — this function assumes
 * it is not one (see `attempt-tracker.ts`'s call sites).
 */
export function resolvePendingAttachment(
  pending: PendingAttachment,
  config: AttachmentBudgetConfig,
  budget: AttachmentBudget,
): Attachment | undefined {
  if (!config.attachScreenshots) {
    return undefined;
  }
  // Screenshots go out of band like video, rather than base64 into the report.
  // Tried first for both shapes, since in cucumber-js an image usually arrives
  // as in-memory content from World.attach() rather than as a file. A non-image
  // returns undefined and falls straight through to the inline paths below,
  // unchanged -- and so does an image the writer could not place, so a failure
  // costs the offload rather than the user's attachment.
  const image = writeImageAttachment(pending, config.outputDir, config.maxAttachmentBytes);
  if (image) {
    return {
      name: pending.name,
      mimeType: image.mimeType,
      localImagePath: image.localImagePath,
      fileSize: image.fileSize,
      stepIndex: pending.stepIndex,
    };
  }

  if (pending.content !== undefined) {
    const bytes = Buffer.byteLength(pending.content, 'base64');
    if (bytes > config.maxAttachmentBytes) {
      logger.warn(
        `skipping attachment "${pending.name}": ${bytes} bytes exceeds the configured per-attachment cap of ${config.maxAttachmentBytes} bytes`,
      );
      return undefined;
    }
    // pending.content IS the base64 payload, so its length is the exact encoded
    // cost -- no need to derive it from the decoded size.
    if (!budget.tryReserve(pending.content.length)) {
      logger.warn(
        `skipping attachment "${pending.name}": would exceed this run's total attachment budget (${budget.usedBytes} encoded bytes already used; this one needs ${pending.content.length})`,
      );
      return undefined;
    }
    return { name: pending.name, mimeType: pending.mimeType, content: pending.content, stepIndex: pending.stepIndex };
  }
  if (pending.path) {
    const result = readAttachmentFile(pending.path, config.maxAttachmentBytes, budget);
    if (result.skipped) {
      logger.warn(`skipping attachment "${pending.name}" (${pending.path}): ${result.reason}`);
      return undefined;
    }
    return {
      name: pending.name,
      mimeType: pending.mimeType,
      content: result.content,
      path: pending.path,
      stepIndex: pending.stepIndex,
    };
  }
  return undefined;
}

/**
 * Resolves one video-like pending attachment (`isVideoLike()` already true)
 * into a wire `Attachment` carrying `storageKey`/`fileSize` instead of
 * `content`, via the presigned-upload-URL flow — or `undefined` if it should
 * be skipped (uploads disabled, unsupported format, oversized, or a
 * network/API error; each case logs why). Async, unlike
 * `resolvePendingAttachment` — see `attempt-tracker.ts`'s
 * `pendingVideoWrites` for how callers reconcile that with cucumber-js's
 * synchronous, per-envelope event stream.
 */
export async function resolveVideoAttachment(
  pending: PendingAttachment,
  config: AttachmentBudgetConfig,
): Promise<Attachment | undefined> {
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
