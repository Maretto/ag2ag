#!/usr/bin/env node
'use strict';

// =============================================================================
// Unit tests — config
// Verifies default values, env var overrides, and type conversions.
// Uses Node.js built-in test runner (node:test, available since Node 18)
// =============================================================================

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

// Path to repository root so we can re-load config with different env vars
const ROOT = path.join(__dirname, '../..');

// ---------------------------------------------------------------------------
// Helper: load config in a fresh child process with the given env variables.
// Module caching means we cannot re-require() config with different env vars
// in the same process — a subprocess is the correct isolation boundary.
// ---------------------------------------------------------------------------
function loadConfigWithEnv(env) {
  const result = spawnSync('node', ['-e', `
    const c = require('./src/config');
    console.log(JSON.stringify({
      MAX_BODY_SIZE: c.MAX_BODY_SIZE,
      DEFAULT_PORT: c.DEFAULT_PORT,
      BIND_HOST: c.BIND_HOST,
      RATE_LIMIT_MAX: c.RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW_MS: c.RATE_LIMIT_WINDOW_MS,
      CLEANUP_INTERVAL_MS: c.CLEANUP_INTERVAL_MS,
      CLEANUP_MAX_DAYS: c.CLEANUP_MAX_DAYS,
      SSE_KEEPALIVE_MS: c.SSE_KEEPALIVE_MS,
      VERSION: c.VERSION,
    }));
  `], {
    cwd: ROOT,
    // Strip all AG2AG_* vars from the parent env, then apply the requested ones
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, `Config subprocess failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

// ---------------------------------------------------------------------------
// Default values (no env vars set)
// ---------------------------------------------------------------------------

describe('config', () => {
  describe('default values', () => {
    // Load once for all default-value assertions — module cache is fine here
    // since the parent process has no AG2AG_* vars set during tests.
    const config = require('../../src/config');

    test('MAX_BODY_SIZE is 1 MB (1048576 bytes)', () => {
      assert.equal(config.MAX_BODY_SIZE, 1024 * 1024);
    });

    test('DEFAULT_PORT is 5001', () => {
      assert.equal(config.DEFAULT_PORT, 5001);
    });

    test('BIND_HOST is 127.0.0.1', () => {
      assert.equal(config.BIND_HOST, '127.0.0.1');
    });

    test('RATE_LIMIT_MAX is 60', () => {
      assert.equal(config.RATE_LIMIT_MAX, 60);
    });

    test('RATE_LIMIT_WINDOW_MS is 60 seconds', () => {
      assert.equal(config.RATE_LIMIT_WINDOW_MS, 60_000);
    });

    test('CLEANUP_INTERVAL_MS is 24 hours', () => {
      assert.equal(config.CLEANUP_INTERVAL_MS, 24 * 60 * 60 * 1000);
    });

    test('CLEANUP_MAX_DAYS is 7', () => {
      assert.equal(config.CLEANUP_MAX_DAYS, 7);
    });

    test('SSE_KEEPALIVE_MS is 15 seconds', () => {
      assert.equal(config.SSE_KEEPALIVE_MS, 15_000);
    });

    test('VERSION is a non-empty string', () => {
      assert.equal(typeof config.VERSION, 'string');
      assert.ok(config.VERSION.length > 0, 'VERSION should not be empty');
    });

    test('all numeric values are finite numbers (no NaN)', () => {
      const numericKeys = [
        'MAX_BODY_SIZE', 'DEFAULT_PORT', 'RATE_LIMIT_MAX',
        'RATE_LIMIT_WINDOW_MS', 'CLEANUP_INTERVAL_MS', 'CLEANUP_MAX_DAYS',
        'SSE_KEEPALIVE_MS',
      ];
      for (const key of numericKeys) {
        assert.equal(typeof config[key], 'number', `${key} must be a number`);
        assert.ok(Number.isFinite(config[key]), `${key} must not be NaN/Infinity`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Env var overrides (each test spawns an isolated child process)
  // ---------------------------------------------------------------------------

  describe('env var overrides', () => {
    test('AG2AG_MAX_BODY_SIZE overrides MAX_BODY_SIZE', () => {
      const cfg = loadConfigWithEnv({ AG2AG_MAX_BODY_SIZE: '2097152' });
      assert.equal(cfg.MAX_BODY_SIZE, 2097152);
    });

    test('AG2AG_PORT overrides DEFAULT_PORT', () => {
      const cfg = loadConfigWithEnv({ AG2AG_PORT: '8080' });
      assert.equal(cfg.DEFAULT_PORT, 8080);
    });

    test('AG2AG_BIND_HOST overrides BIND_HOST', () => {
      const cfg = loadConfigWithEnv({ AG2AG_BIND_HOST: '0.0.0.0' });
      assert.equal(cfg.BIND_HOST, '0.0.0.0');
    });

    test('AG2AG_RATE_LIMIT_MAX overrides RATE_LIMIT_MAX', () => {
      const cfg = loadConfigWithEnv({ AG2AG_RATE_LIMIT_MAX: '120' });
      assert.equal(cfg.RATE_LIMIT_MAX, 120);
    });

    test('AG2AG_RATE_LIMIT_WINDOW_MS overrides RATE_LIMIT_WINDOW_MS', () => {
      const cfg = loadConfigWithEnv({ AG2AG_RATE_LIMIT_WINDOW_MS: '30000' });
      assert.equal(cfg.RATE_LIMIT_WINDOW_MS, 30000);
    });

    test('AG2AG_CLEANUP_INTERVAL_MS overrides CLEANUP_INTERVAL_MS', () => {
      const cfg = loadConfigWithEnv({ AG2AG_CLEANUP_INTERVAL_MS: '3600000' });
      assert.equal(cfg.CLEANUP_INTERVAL_MS, 3600000);
    });

    test('AG2AG_CLEANUP_MAX_DAYS overrides CLEANUP_MAX_DAYS', () => {
      const cfg = loadConfigWithEnv({ AG2AG_CLEANUP_MAX_DAYS: '14' });
      assert.equal(cfg.CLEANUP_MAX_DAYS, 14);
    });

    test('AG2AG_SSE_KEEPALIVE_MS overrides SSE_KEEPALIVE_MS', () => {
      const cfg = loadConfigWithEnv({ AG2AG_SSE_KEEPALIVE_MS: '30000' });
      assert.equal(cfg.SSE_KEEPALIVE_MS, 30000);
    });
  });

  // ---------------------------------------------------------------------------
  // Type conversion: parseInt coerces string env vars to numbers
  // ---------------------------------------------------------------------------

  describe('type conversion', () => {
    test('numeric env vars are converted to numbers, not strings', () => {
      const cfg = loadConfigWithEnv({ AG2AG_PORT: '9999', AG2AG_RATE_LIMIT_MAX: '5' });
      assert.equal(typeof cfg.DEFAULT_PORT, 'number');
      assert.equal(typeof cfg.RATE_LIMIT_MAX, 'number');
      assert.equal(cfg.DEFAULT_PORT, 9999);
      assert.equal(cfg.RATE_LIMIT_MAX, 5);
    });

    test('non-numeric env var falls back to default', () => {
      // parseInt('abc', 10) === NaN, falsy → default is used
      const cfg = loadConfigWithEnv({ AG2AG_PORT: 'abc' });
      assert.equal(cfg.DEFAULT_PORT, 5001);
    });
  });
});
