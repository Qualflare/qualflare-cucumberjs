import * as fs from 'node:fs';
import * as path from 'node:path';

import { logger } from '../shared/logger.js';
import type { Attachment } from '../shared/types.js';
import { resolveVideoMimeType, writeVideoAttachment } from './video-uploader.js';

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
 * Tracks cumulative attached bytes across the whole `cucumber-js` process
 * (one instance per formatter, reused across every attachment resolved),
 * so the final POST doesn't silently exceed the request body limit. Ported
 * verbatim in spirit from `@qualflare/cypress`'s `AttachmentBudget`.
 */
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
  if (!budget.tryReserve(size)) {
    return {
      skipped: true,
      reason: `would exceed this run's total attachment budget (${budget.usedBytes} bytes already used)`,
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
  if (pending.content !== undefined) {
    const bytes = Buffer.byteLength(pending.content, 'base64');
    if (bytes > config.maxAttachmentBytes) {
      logger.warn(
        `skipping attachment "${pending.name}": ${bytes} bytes exceeds the configured per-attachment cap of ${config.maxAttachmentBytes} bytes`,
      );
      return undefined;
    }
    if (!budget.tryReserve(bytes)) {
      logger.warn(
        `skipping attachment "${pending.name}": would exceed this run's total attachment budget (${budget.usedBytes} bytes already used)`,
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
 * `pendingVideoUploads` for how callers reconcile that with cucumber-js's
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
