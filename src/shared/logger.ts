/**
 * A minimal logger writing to stderr. Deliberately avoids stdout, since
 * that's typically `cucumber-js`'s own test-output stream and shouldn't be
 * polluted with reporter diagnostics.
 */

const PREFIX = '[qualflare-cucumberjs]';

export const logger = {
  debug(...args: unknown[]): void {
    console.debug(PREFIX, ...args);
  },
  info(...args: unknown[]): void {
    console.log(PREFIX, ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]): void {
    console.error(PREFIX, ...args);
  },
};
