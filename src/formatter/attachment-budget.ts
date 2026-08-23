import * as fs from 'node:fs';
import * as path from 'node:path';

import { logger } from '../shared/logger.js';
import type { Attachment } from '../shared/types.js';

/** Extensions/mime-prefixes this reporter must never attach — Qualflare has
 * no video/blob-attachment support yet (a separate, unbuilt backend
 * feature), the same constraint `@qualflare/cypress` documents. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv']);

export interface AttachmentBudgetConfig {
  attachScreenshots: boolean;
  maxAttachmentBytes: number;
  maxTotalAttachmentBytes: number;
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

function isVideoLike(mimeType: string | undefined, filePath: string | undefined): boolean {
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
 * Resolves one pending attachment into a wire `Attachment`, or `undefined`
 * if it should be skipped entirely (per the plan's resolved decision — an
 * oversized/over-budget/video attachment is dropped, not degraded to a
 * contentless stub, since the server's `path` field is explicitly
 * informational/never-fetched). Unlike `@qualflare/cypress`'s
 * `resolveAttachments()` (which batch-resolves a Case's whole array at
 * case-finish time), this resolves one attachment at a time as its
 * `attachment` envelope arrives — matching cucumber-js's per-envelope
 * event stream.
 */
export function resolvePendingAttachment(
  pending: PendingAttachment,
  config: AttachmentBudgetConfig,
  budget: AttachmentBudget,
): Attachment | undefined {
  if (!config.attachScreenshots) {
    return undefined;
  }
  if (isVideoLike(pending.mimeType, pending.path)) {
    logger.warn(
      `refusing to attach "${pending.name}": video attachments are not supported yet ` +
        `(${pending.path ?? pending.mimeType ?? 'unknown'}).`,
    );
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
