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
