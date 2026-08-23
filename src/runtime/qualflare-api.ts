import { world } from '@cucumber/cucumber';

import { RESERVED_MESSAGE_MEDIA_TYPE } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import type { CasePriority, LinkType } from '../shared/types.js';
import type { RuntimeMessage } from './message-types.js';

/**
 * `@cucumber/cucumber` exports a `world` proxy (`AsyncLocalStorage`-backed,
 * added in cucumber-js 10.8.0 — this package's peer-dependency floor is
 * pinned exactly to that version because of this) that resolves to the
 * currently-executing scenario's World from anywhere — no `BeforeAll`
 * singleton registration needed. Calling it outside a step/hook body (e.g.
 * at module-load time, or from `BeforeAll`/`AfterAll`, which have no "current
 * test case") throws — caught here and logged once, mirroring
 * `@qualflare/cypress`'s "warn, never throw, never abort the run" philosophy
 * for a misplaced `qualflare.*()` call.
 */
function send(message: RuntimeMessage): void {
  try {
    world.attach(JSON.stringify(message), RESERVED_MESSAGE_MEDIA_TYPE);
  } catch (err) {
    logger.warn(
      `qualflare.* was called outside a running scenario (e.g. from a Before/After hook, ` +
        `BeforeAll/AfterAll, or at module-load time) — this call had no effect. (${(err as Error).message})`,
    );
  }
}

function utf8ToBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export const qualflare = {
  label(name: string, value: string): void {
    send({ type: 'label', name, value });
  },

  link(url: string, opts?: { type?: LinkType; name?: string }): void {
    send({ type: 'link', url, linkType: opts?.type, name: opts?.name });
  },

  tag(...tags: string[]): void {
    send({ type: 'tag', tags });
  },

  description(text: string): void {
    send({ type: 'description', text });
  },

  priority(value: CasePriority): void {
    send({ type: 'priority', value });
  },

  /** Placed on the currently-open `step()`, if any; otherwise on the Case
   * itself (`Case.properties`). `masked` is a DISPLAY HINT ONLY — the
   * server does not redact the value; see `docs/METADATA-API.md`. */
  parameter(name: string, value?: string, opts?: { masked?: boolean }): void {
    send({ type: 'parameter', name, value, masked: opts?.masked });
  },

  attachment(name: string, content: string, opts?: { encoding?: 'utf8' | 'base64'; mimeType?: string }): void {
    const contentBase64 = opts?.encoding === 'base64' ? content : utf8ToBase64(content);
    send({ type: 'attachment', name, contentBase64, mimeType: opts?.mimeType });
  },

  attachmentFromFile(name: string, path: string, opts?: { mimeType?: string }): void {
    send({ type: 'attachment_from_file', name, path, mimeType: opts?.mimeType });
  },

  /** Wraps `fn` as a manually-declared step, nested under any currently-open
   * `qualflare.step()` call. Unlike `@qualflare/cypress` (whose step
   * definitions are Mocha test bodies executed synchronously ahead of
   * Cypress's own deferred command queue, requiring a `Chainable`-detection
   * trick to time the end of a step correctly), a cucumber-js step
   * definition is already a plain `async function` — so this is a
   * straightforward `try/finally`-wrapped call, with EXACT timing (real
   * `Date.now()` deltas around the awaited body), not an approximation. */
  async step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    send({ type: 'step_start', name, timestamp: Date.now() });
    try {
      const result = await fn();
      send({ type: 'step_stop', status: 'passed', timestamp: Date.now() });
      return result;
    } catch (err) {
      send({ type: 'step_stop', status: 'failed', error: (err as Error).message, timestamp: Date.now() });
      throw err;
    }
  },
};
