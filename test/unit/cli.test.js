#!/usr/bin/env node
'use strict';

// =============================================================================
// Unit tests — CLI utilities
// Tests the pure utility functions exported from src/cli.js:
//   parseArgs — argument vector parser
//   parseMs   — human-friendly duration parser (30s, 5m, plain ms)
// Port validation behaviour is tested via a spawned subprocess to avoid
// polluting the shared registry file used by the live CLI.
// Uses Node.js built-in test runner (node:test, available since Node 18)
// =============================================================================

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// cli.js exports parseArgs and parseMs when required as a module
const { parseArgs, parseMs } = require('../../src/cli');

const CLI_PATH = path.join(__dirname, '../../src/cli.js');
const ROOT = path.join(__dirname, '../..');

// ---------------------------------------------------------------------------
// Helper: run the CLI in a subprocess with an isolated tmp registry so tests
// never touch the project's real registry.json.
// ---------------------------------------------------------------------------
function runCli(args, env = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag2ag-cli-test-'));
  // Point the registry at a writable temp file
  const regFile = path.join(tmpDir, 'registry.json');
  fs.writeFileSync(regFile, JSON.stringify({ agents: [], version: '1.0' }));

  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AG2AG_REGISTRY_PATH: regFile,
      ...env,
    },
    encoding: 'utf8',
    timeout: 5000,
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// parseMs — duration string to milliseconds
// ---------------------------------------------------------------------------

describe('parseMs', () => {
  test('returns undefined for falsy input', () => {
    assert.equal(parseMs(''), undefined);
    assert.equal(parseMs(null), undefined);
    assert.equal(parseMs(undefined), undefined);
  });

  test('parses seconds suffix (30s → 30000)', () => {
    assert.equal(parseMs('30s'), 30_000);
  });

  test('parses minutes suffix (5m → 300000)', () => {
    assert.equal(parseMs('5m'), 300_000);
  });

  test('parses plain milliseconds string (1500 → 1500)', () => {
    assert.equal(parseMs('1500'), 1500);
  });

  test('parses 1s → 1000', () => {
    assert.equal(parseMs('1s'), 1000);
  });

  test('parses 1m → 60000', () => {
    assert.equal(parseMs('1m'), 60_000);
  });

  test('parses 0s → 0', () => {
    assert.equal(parseMs('0s'), 0);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — argv array parser
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('parses positional arguments into _', () => {
    const args = parseArgs(['agent-name']);
    assert.deepEqual(args._, ['agent-name']);
  });

  test('parses --key value flags', () => {
    const args = parseArgs(['--port', '5001']);
    assert.equal(args.port, '5001');
  });

  test('parses boolean flags (no value following)', () => {
    const args = parseArgs(['--health']);
    assert.equal(args.health, true);
  });

  test('camelCases kebab-case flags', () => {
    const args = parseArgs(['--poll-timeout', '10s']);
    assert.equal(args.pollTimeout, '10s');
  });

  test('collects positional _message from second positional onward', () => {
    // argv: ['call', 'my-agent', 'hello world']  → after shifting 'call':
    // parseArgs is called with ['my-agent', 'hello', 'world']
    const args = parseArgs(['my-agent', 'hello', 'world']);
    assert.equal(args._message, 'hello world');
  });

  test('handles mixed flags and positionals', () => {
    const args = parseArgs(['agent', '--port', '3000', '--health']);
    assert.equal(args._[0], 'agent');
    assert.equal(args.port, '3000');
    assert.equal(args.health, true);
  });

  test('empty argv returns empty object with _ and _message', () => {
    const args = parseArgs([]);
    assert.deepEqual(args._, []);
    assert.equal(args._message, '');
  });
});

// ---------------------------------------------------------------------------
// Port validation in `register` command (tested via subprocess)
// ---------------------------------------------------------------------------

describe('CLI port validation', () => {
  test('accepts a valid port (1024)', () => {
    // Note: CLI will try to write to registry — we redirect to a temp file.
    // A successful register prints "✓ <name>" to stdout.
    const { stdout, stderr, status } = runCli(['register', 'test-agent', '--port', '1024']);
    // The CLI may warn about missing unit but should NOT print "Invalid port"
    assert.ok(!stderr.includes('Invalid port'), `Unexpected error: ${stderr}`);
    assert.ok(!stdout.includes('Invalid port'), `Unexpected error: ${stdout}`);
  });

  test('rejects port 0 with error message', () => {
    const { stderr } = runCli(['register', 'test-agent', '--port', '0']);
    assert.ok(
      stderr.includes('Invalid port'),
      `Expected "Invalid port" in stderr, got: ${stderr}`,
    );
  });

  test('rejects port 65536 (out of range)', () => {
    const { stderr } = runCli(['register', 'test-agent', '--port', '65536']);
    assert.ok(
      stderr.includes('Invalid port'),
      `Expected "Invalid port" in stderr, got: ${stderr}`,
    );
  });

  test('rejects non-numeric port string', () => {
    const { stderr } = runCli(['register', 'test-agent', '--port', 'abc']);
    assert.ok(
      stderr.includes('Invalid port'),
      `Expected "Invalid port" in stderr, got: ${stderr}`,
    );
  });

  test('accepts port 1 (minimum valid)', () => {
    const { stderr } = runCli(['register', 'test-agent', '--port', '1']);
    assert.ok(!stderr.includes('Invalid port'), `Unexpected error: ${stderr}`);
  });

  test('accepts port 65535 (maximum valid)', () => {
    const { stderr } = runCli(['register', 'test-agent', '--port', '65535']);
    assert.ok(!stderr.includes('Invalid port'), `Unexpected error: ${stderr}`);
  });
});
