import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { logger } from '../shared/logger.js';


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

export interface VideoWriteResult {
  /** Filename relative to the `outputDir` this was written into. */
  localVideoPath: string;
  fileSize: number;
  mimeType: string;
}

/**
 * Writes one pending video attachment's bytes into `outputDir` under a
 * unique filename — copying (`fs.copyFileSync`) when it names a real local
 * file, or decoding+writing when it's in-memory base64 content (the
 * `World.attach()`/`qualflare.attachment()` path, which has no file to
 * copy). Unlike qualflare-cypress, where a video is always a file Cypress
 * recorded, this formatter has to handle both — cucumber-js has no
 * "one recorded file per run" concept.
 *
 * `qualflare-cli` uploads whatever lands here later, once it has a real
 * auth token; this process never makes a network call.
 *
 * Best-effort: any failure (unsupported format, oversized, unreadable
 * source, write failure) is logged as a warning and returns `undefined`
 * rather than throwing — a video is never worth failing a test run over.
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

  if (pending.path !== undefined) {
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

/** Extension <-> MIME for the image formats the upload endpoint accepts. */
const IMAGE_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};
const EXTENSION_BY_IMAGE_MIME_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
};

/**
 * The image counterpart of `resolveVideoMimeType`, with the same precedence:
 * a real `filePath`'s extension is authoritative, because it cannot disagree
 * with itself the way a caller-supplied `mimeType` claim could — and the upload
 * endpoint cross-checks extension against MIME, so a disagreement costs a 400
 * per screenshot.
 *
 * Returns undefined for anything outside png/jpeg/gif, which is the ordinary
 * case for a text log or a JSON blob. Those keep the inline path.
 */
export function resolveImageMimeType(
  mimeType: string | undefined,
  filePath: string | undefined,
): ResolvedVideoMimeType | undefined {
  if (filePath) {
    const extension = path.extname(filePath).toLowerCase();
    const resolvedMimeType = IMAGE_MIME_TYPES_BY_EXTENSION[extension];
    return resolvedMimeType ? { mimeType: resolvedMimeType, extension } : undefined;
  }
  const normalized = mimeType?.toLowerCase();
  const extension = normalized ? EXTENSION_BY_IMAGE_MIME_TYPE[normalized] : undefined;
  return normalized && extension ? { mimeType: normalized, extension } : undefined;
}

export interface ImageWriteResult {
  /** Filename relative to the `outputDir` this was written into. */
  localImagePath: string;
  fileSize: number;
  mimeType: string;
}

/**
 * Writes one pending screenshot into `outputDir`, so an image travels the same
 * way a video already does instead of being base64-inlined into the report and
 * from there into the `/collect` body.
 *
 * Handles both shapes for the same reason `writeVideoAttachment` does:
 * `qualflare.attachmentFromFile()` names a real file, while `World.attach()`
 * and `qualflare.attachment()` hand over in-memory content with nothing to
 * copy. In cucumber-js the in-memory case is the COMMON one — screenshots
 * usually arrive through `World.attach()` from a browser driver — so refusing
 * it the way some video paths do would leave most screenshots inline and
 * defeat the point.
 *
 * Unlike `writeVideoAttachment`, an unsupported format is not warned about:
 * every non-image attachment passes through here on its way to the inline
 * path, so warning would fire on ordinary logs.
 *
 * Requires `@qualflare/cli` v0.1.24+, which reads `localImagePath`.
 */
export function writeImageAttachment(
  pending: { name: string; mimeType?: string; path?: string; content?: string },
  outputDir: string,
  maxImageBytes: number,
): ImageWriteResult | undefined {
  const resolved = resolveImageMimeType(pending.mimeType, pending.path);
  if (!resolved) {
    return undefined;
  }
  // Defensive: `outputDir` is required by the config type, but a formatter must
  // never throw over an attachment. Without this, a caller that somehow lacks
  // one gets a TypeError out of path.join rather than an inlined screenshot.
  if (!outputDir) {
    return undefined;
  }

  const localImagePath = `${randomUUID()}${resolved.extension}`;
  const destination = path.join(outputDir, localImagePath);

  if (pending.path !== undefined) {
    let fileSize: number;
    try {
      // Stat BEFORE copying — an oversized file must never be copied just to
      // discover it should be skipped.
      fileSize = fs.statSync(pending.path).size;
    } catch (err) {
      logger.warn(`skipping image attachment "${pending.path}": could not stat file: ${(err as Error).message}`);
      return undefined;
    }
    if (fileSize > maxImageBytes) {
      logger.warn(
        `skipping image attachment "${pending.path}": ${fileSize} bytes exceeds the configured maxAttachmentBytes cap of ${maxImageBytes} bytes.`,
      );
      return undefined;
    }
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.copyFileSync(pending.path, destination);
    } catch (err) {
      logger.warn(`skipping image attachment "${pending.path}": could not copy file: ${(err as Error).message}`);
      return undefined;
    }
    return { localImagePath, fileSize, mimeType: resolved.mimeType };
  }

  if (pending.content !== undefined) {
    const fileSize = Buffer.byteLength(pending.content, 'base64');
    if (fileSize > maxImageBytes) {
      logger.warn(
        `skipping image attachment "${pending.name}": ${fileSize} bytes exceeds the configured maxAttachmentBytes cap of ${maxImageBytes} bytes.`,
      );
      return undefined;
    }
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(destination, Buffer.from(pending.content, 'base64'));
    } catch (err) {
      logger.warn(`skipping image attachment "${pending.name}": could not write file: ${(err as Error).message}`);
      return undefined;
    }
    return { localImagePath, fileSize, mimeType: resolved.mimeType };
  }

  return undefined;
}
