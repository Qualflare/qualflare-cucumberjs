import * as fs from 'node:fs';
import * as path from 'node:path';

import { PACKAGE_VERSION } from '../config/version.js';
import type { ResolvedFormatterConfig } from '../config/resolve-config.js';
import { putObject, requestUploadUrl, type SendOptions } from '../http/client.js';
import { logger } from '../shared/logger.js';

/** Builds the `SendOptions` shared by every HTTP call this reporter makes
 * (the final `/collect` POST and the video presign request) from the
 * resolved formatter config. Centralized so the `userAgent` string is
 * constructed exactly once. */
export function buildHttpOptions(config: ResolvedFormatterConfig): SendOptions {
  return {
    endpoint: config.apiEndpoint,
    token: config.token,
    timeoutMs: config.timeoutMs,
    retry: config.retry,
    userAgent: `qualflare-cucumberjs/${PACKAGE_VERSION}`,
    debug: config.debug,
  };
}

/** Extension <-> MIME type for the video formats the server accepts (see
 * `launch.AllowedAttachmentUploadMimeTypes` server-side). */
const VIDEO_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};
const EXTENSION_BY_VIDEO_MIME_TYPE: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

export interface ResolvedVideoMimeType {
  mimeType: string;
  extension: string;
}

/**
 * Determines the server-accepted `{mimeType, extension}` pair for a pending
 * video attachment, or `undefined` if neither `filePath`'s extension nor
 * `mimeType` maps to one of the three formats the server allows.
 * `filePath` (a real local file, from `qualflare.attachmentFromFile()`)
 * takes priority when present — its extension is authoritative and cannot
 * disagree with itself the way a caller-supplied `mimeType` claim could.
 * Without a `filePath` (in-memory `World.attach()`/`qualflare.attachment()`
 * content), `mimeType` is the only signal available.
 */
export function resolveVideoMimeType(mimeType: string | undefined, filePath: string | undefined): ResolvedVideoMimeType | undefined {
  if (filePath) {
    const extension = path.extname(filePath).toLowerCase();
    const resolvedMimeType = VIDEO_MIME_TYPES_BY_EXTENSION[extension];
    return resolvedMimeType ? { mimeType: resolvedMimeType, extension } : undefined;
  }
  const normalized = mimeType?.toLowerCase();
  const extension = normalized ? EXTENSION_BY_VIDEO_MIME_TYPE[normalized] : undefined;
  return normalized && extension ? { mimeType: normalized, extension } : undefined;
}

export interface VideoUploadResult {
  storageKey: string;
  fileSize: number;
}

/**
 * Uploads one video's bytes to R2 via the presigned-upload-URL flow
 * (`POST /api/v1/attachments/upload-url` -> PUT bytes -> return the
 * `storageKey` a later `/collect` payload references — see
 * `Attachment.storageKey`'s doc comment in shared/types.ts).
 *
 * Best-effort, like the rest of this reporter's attachment handling
 * (`attachment-budget.ts`'s oversized/unreadable-file skip): any failure —
 * network/API error — is logged as a warning and resolves to `undefined`
 * rather than throwing, so a video upload problem never fails the whole run
 * (independent of `failOnUploadError`, which is scoped to the actual
 * `/collect` POST, not to best-effort attachment resolution). Size/format
 * validation happens in the caller (`attachment-budget.ts`), before this is
 * invoked — this function only performs the upload itself.
 */
export async function uploadVideoBytes(
  body: Buffer,
  filename: string,
  mimeType: string,
  httpOptions: SendOptions,
): Promise<VideoUploadResult | undefined> {
  let uploadUrl: string;
  let storageKey: string;
  try {
    const res = await requestUploadUrl(httpOptions, filename, mimeType, body.length);
    uploadUrl = res.uploadUrl;
    storageKey = res.storageKey;
  } catch (err) {
    logger.warn(`skipping video upload for "${filename}": failed to obtain an upload URL: ${(err as Error).message}`);
    return undefined;
  }

  try {
    await putObject(uploadUrl, body, mimeType, httpOptions.timeoutMs);
  } catch (err) {
    logger.warn(`skipping video upload for "${filename}": upload failed: ${(err as Error).message}`);
    return undefined;
  }

  return { storageKey, fileSize: body.length };
}

/** Reads a local video file into memory, honoring `maxVideoBytes` via
 * `fs.statSync` BEFORE reading — an oversized file must never be loaded
 * just to discover it should be skipped (same discipline as
 * `attachment-budget.ts`'s `readAttachmentFile`). Returns `undefined` (and
 * logs why) on any failure. */
export function readVideoFile(filePath: string, maxVideoBytes: number): Buffer | undefined {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch (err) {
    logger.warn(`skipping video attachment "${filePath}": could not stat file: ${(err as Error).message}`);
    return undefined;
  }
  if (size > maxVideoBytes) {
    logger.warn(
      `skipping video attachment "${filePath}": ${size} bytes exceeds the configured maxVideoBytes cap of ${maxVideoBytes} bytes.`,
    );
    return undefined;
  }
  try {
    return fs.readFileSync(filePath);
  } catch (err) {
    logger.warn(`skipping video attachment "${filePath}": could not read file: ${(err as Error).message}`);
    return undefined;
  }
}
