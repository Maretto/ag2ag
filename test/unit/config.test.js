#!/usr/bin/env node
'use strict';

// =============================================================================
// Unit tests — Config
// Verifies default values and environment variable overrides.
// Uses Node.js built-in test runner (node:test, available since Node 18)
// =============================================================================

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');

// Helper: evaluate an expression in a fresh Node process with custom env vars
function evalWithEnv(expr, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  const output = execFileSync(process.execPath, ['-e', expr], { encoding: 'utf8', env });
  return output.trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('config', () => {
  describe('defaults (no env vars)', () => {
    let cfg;

    test('loads without errors', () => {
      // Clear module cache so env overrides can be tested via child process
      cfg = require('../../src/config');
      assert.ok(cfg, 'config module should export an object');
    });

    test('MAX_BODY_SIZE defaults to 1 MB', () => {
      cfg = cfg || require('../../src/config');
      assert.equal(cfg.MAX_BODY_SIZE, 1024 * 1024);
    });

    test('DEFAULT_PORT defaults to 5001', () => {
      cfg = cfg || require('../../src/config');
      assert.equal(cfg.DEFAULT_PORT, 5001);
    });

    test('BIND_HOST defaults to 127.0.0.1', () => {
      cfg = cfg || require('../../src/config');
      assert.equal(cfg.BIND_HOST, '127.0.0.1');
    });

    test('RATE_LIMIT_MAX defaults to 60', () => {
      cfg = cfg || require('../../src/config');
      assert.equal(cfg.RATE_LIMIT_MAX, 60);
    });

    test('RATE_LIMIT_WINDOW_MS defaults to 60000', () => {
      cfg = cfg || require('../../src/config');
      assert.equal(cfg.RATE_LIMIT_WINDOW_MS, 60_000);
    });

    test('CLEANUP_INTERVAL_MS defaults to 24 hours', () => {
      cfg = cfg || require('../../src/config');
      assert.equal(cfg.CLEANUP_INTERVAL_MS, 24 * 60 * 60 * 1000);
    });

    test('CLEANUP_MAX_DAYS defaults to 7', () => {
      cfg = cfg || require('../../src/config');
      assert.equal(cfg.CLEANUP_MAX_DAYS, 7);
    });

    test('SSE_KEEPALIVE_MS defaults to 15000', () => {
      cfg = cfg || require('../../src/config');
      assert.equal(cfg.SSE_KEEPALIVE_MS, 15_000);
    });

    test('VERSION matches package.json', () => {
      cfg = cfg || require('../../src/config');
      const pkg = require('../../package.json');
      assert.equal(cfg.VERSION, pkg.version);
    });
  });

  describe('environment variable overrides', () => {
    const script = `const c = require(${JSON.stringify(require('path').resolve(__dirname, '../../src/config'))}); process.stdout.write(String(c.%KEY%));`;

    function getConfigKey(key, envOverrides) {
      const expr = script.replace('%KEY%', key);
      return evalWithEnv(expr, envOverrides);
    }

    test('AG2AG_MAX_BODY_SIZE overrides MAX_BODY_SIZE', () => {
      const val = getConfigKey('MAX_BODY_SIZE', { AG2AG_MAX_BODY_SIZE: '2097152' });
      assert.equal(val, '2097152');
    });

    test('AG2AG_PORT overrides DEFAULT_PORT', () => {
      const val = getConfigKey('DEFAULT_PORT', { AG2AG_PORT: '9999' });
      assert.equal(val, '9999');
    });

    test('AG2AG_BIND_HOST overrides BIND_HOST', () => {
      const val = getConfigKey('BIND_HOST', { AG2AG_BIND_HOST: '0.0.0.0' });
      assert.equal(val, '0.0.0.0');
    });

    test('AG2AG_RATE_LIMIT_MAX overrides RATE_LIMIT_MAX', () => {
      const val = getConfigKey('RATE_LIMIT_MAX', { AG2AG_RATE_LIMIT_MAX: '100' });
      assert.equal(val, '100');
    });

    test('AG2AG_RATE_LIMIT_WINDOW_MS overrides RATE_LIMIT_WINDOW_MS', () => {
      const val = getConfigKey('RATE_LIMIT_WINDOW_MS', { AG2AG_RATE_LIMIT_WINDOW_MS: '30000' });
      assert.equal(val, '30000');
    });

    test('AG2AG_CLEANUP_MAX_DAYS overrides CLEANUP_MAX_DAYS', () => {
      const val = getConfigKey('CLEANUP_MAX_DAYS', { AG2AG_CLEANUP_MAX_DAYS: '14' });
      assert.equal(val, '14');
    });

    test('AG2AG_SSE_KEEPALIVE_MS overrides SSE_KEEPALIVE_MS', () => {
      const val = getConfigKey('SSE_KEEPALIVE_MS', { AG2AG_SSE_KEEPALIVE_MS: '5000' });
      assert.equal(val, '5000');
    });
  });
});
