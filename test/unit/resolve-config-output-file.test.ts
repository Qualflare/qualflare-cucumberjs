import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../../src/config/resolve-config.js';

// No git/CI detection matters for these assertions — stub both to avoid a
// real `git` subprocess / process.env dependency, mirroring
// resolve-config-detection.test.ts's own fakes.
const NOOP_DEPS = { detectGit: () => ({}), detectCi: () => ({}) };

const ORIGINAL_ARGV = process.argv;

afterEach(() => {
  vi.unstubAllEnvs();
  process.argv = ORIGINAL_ARGV;
});

describe('resolveConfig — outputDir', () => {
  it('defaults outputDir to ./qualflare-results', () => {
    expect(resolveConfig({}, NOOP_DEPS).outputDir).toBe('./qualflare-results');
  });

  it('honors an explicit outputDir option', () => {
    expect(resolveConfig({ outputDir: './custom-dir' }, NOOP_DEPS).outputDir).toBe('./custom-dir');
  });

  it('resolves outputDir from QUALFLARE_OUTPUT_DIR', () => {
    vi.stubEnv('QUALFLARE_OUTPUT_DIR', './from-env');
    expect(resolveConfig({}, NOOP_DEPS).outputDir).toBe('./from-env');
  });

  it('an explicit outputDir option wins over the environment variable', () => {
    vi.stubEnv('QUALFLARE_OUTPUT_DIR', './from-env');
    expect(resolveConfig({ outputDir: './from-option' }, NOOP_DEPS).outputDir).toBe('./from-option');
  });

  it('an explicit outputDir: "" falls through to the default', () => {
    expect(resolveConfig({ outputDir: '' }, NOOP_DEPS).outputDir).toBe('./qualflare-results');
  });

  it('never throws for a missing token — token no longer exists', () => {
    expect(() => resolveConfig({}, NOOP_DEPS)).not.toThrow();
  });
});

describe('resolveConfig — shardIndex', () => {
  it('is undefined when nothing indicates a shard', () => {
    process.argv = ['node', 'cucumber-js'];
    expect(resolveConfig({}, NOOP_DEPS).shardIndex).toBeUndefined();
  });

  it('honors an explicit shardIndex option', () => {
    expect(resolveConfig({ shardIndex: 9 }, NOOP_DEPS).shardIndex).toBe(9);
  });

  it('reads QUALFLARE_SHARD_INDEX when no explicit option is given', () => {
    vi.stubEnv('QUALFLARE_SHARD_INDEX', '3');
    expect(resolveConfig({}, NOOP_DEPS).shardIndex).toBe(3);
  });

  it('an explicit option wins over the environment variable', () => {
    vi.stubEnv('QUALFLARE_SHARD_INDEX', '3');
    expect(resolveConfig({ shardIndex: 9 }, NOOP_DEPS).shardIndex).toBe(9);
  });

  // cucumber-js parses `--shard INDEX/TOTAL` itself, but routes it to
  // `configuration.sources.shard` — a formatter only ever receives
  // `configuration.options`, so there is no supported way to read it.
  // Sniffing argv is a best-effort convenience for the common CI case where
  // the flag really is on the command line; it is deliberately the LAST
  // fallback, below the env var that always works.
  it('falls back to parsing --shard from argv, converting 1-based to 0-based', () => {
    process.argv = ['node', 'cucumber-js', '--shard', '2/4'];
    expect(resolveConfig({}, NOOP_DEPS).shardIndex).toBe(1);
  });

  it('handles the --shard=N/M form too', () => {
    process.argv = ['node', 'cucumber-js', '--shard=1/3'];
    expect(resolveConfig({}, NOOP_DEPS).shardIndex).toBe(0);
  });

  it('ignores a malformed --shard value rather than reporting a wrong shard', () => {
    process.argv = ['node', 'cucumber-js', '--shard', 'not-a-shard'];
    expect(resolveConfig({}, NOOP_DEPS).shardIndex).toBeUndefined();
  });

  it('QUALFLARE_SHARD_INDEX wins over argv --shard', () => {
    vi.stubEnv('QUALFLARE_SHARD_INDEX', '7');
    process.argv = ['node', 'cucumber-js', '--shard', '2/4'];
    expect(resolveConfig({}, NOOP_DEPS).shardIndex).toBe(7);
  });
});
