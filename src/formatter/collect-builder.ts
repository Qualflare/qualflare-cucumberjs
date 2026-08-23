import * as os from 'node:os';

import { PACKAGE_VERSION } from '../config/version.js';
import type { ResolvedFormatterConfig } from '../config/resolve-config.js';
import type { Collect, Suite } from '../shared/types.js';

function resolveOs(config: ResolvedFormatterConfig): string {
  if (config.os) {
    return config.os;
  }
  return `${os.type()} ${os.release()}`;
}

/**
 * Assembles the final `Collect` payload from every finished `Suite`, at
 * `finished()`. CI metadata and branch/commit auto-detection are already
 * fully resolved by `resolve-config.ts` — this function just reads the
 * resolved config through, it does not call `ci-detect.ts`/`git-detect.ts`
 * itself. Unlike `@qualflare/cypress`'s version, there is no `BrowserInfo`
 * parameter — cucumber-js has no browser context of its own (unless a user
 * pairs it with a browser driver, which is outside this reporter's own
 * knowledge), so `browser` is config-only and `os` falls back to
 * `os.type()/os.release()`.
 */
export function buildCollectPayload(suites: Suite[], config: ResolvedFormatterConfig): Collect {
  return {
    framework: config.framework,
    platform: config.platform,
    os: resolveOs(config),
    browser: config.browser ?? '',
    branch: config.branch,
    commit: config.commit,
    environment: config.environment,
    language: config.language,
    milestone: config.milestone,
    metadata: {
      version: PACKAGE_VERSION,
      timestamp: new Date().toISOString(),
      cliName: 'qualflare-cucumberjs',
    },
    properties: config.properties,
    suites,
    ciProvider: config.ciProvider,
    ciBuildNumber: config.ciBuildNumber,
    ciRunUrl: config.ciRunUrl,
    ciPrNumber: config.ciPrNumber,
  };
}
