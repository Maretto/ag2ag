#!/usr/bin/env node
'use strict';

// =============================================================================
// Unit tests — CLI utilities
// Tests the parseMs and parseArgs helpers exported by cli.js.
// Uses Node.js built-in test runner (node:test, available since Node 18)
// =============================================================================

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseMs, parseArgs } = require('../../src/cli');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseMs', () => {
  test('undefined / empty returns undefined', () => {
    assert.equal(parseMs(undefined), undefined);
    assert.equal(parseMs(''), undefined);
    assert.equal(parseMs(null), undefined);
  });

  test('plain number string returns the integer', () => {
    assert.equal(parseMs('500'), 500);
    assert.equal(parseMs('1500'), 1500);
    assert.equal(parseMs('0'), 0);
  });

  test('seconds suffix (s) multiplies by 1000', () => {
    assert.equal(parseMs('5s'), 5000);
    assert.equal(parseMs('30s'), 30000);
    assert.equal(parseMs('1s'), 1000);
  });

  test('minutes suffix (m) multiplies by 60000', () => {
    assert.equal(parseMs('1m'), 60000);
    assert.equal(parseMs('5m'), 300000);
    assert.equal(parseMs('10m'), 600000);
  });

  test('large second values work correctly', () => {
    assert.equal(parseMs('120s'), 120000);
  });
});

describe('parseArgs', () => {
  test('positional arguments go into _', () => {
    const args = parseArgs(['agent-name']);
    assert.deepEqual(args._, ['agent-name']);
  });

  test('-- flags are parsed into named keys', () => {
    const args = parseArgs(['--port', '5001', '--unit', 'my-agent.service']);
    assert.equal(args.port, '5001');
    assert.equal(args.unit, 'my-agent.service');
  });

  test('camelCase conversion for hyphenated flags', () => {
    const args = parseArgs(['--poll-timeout', '30s']);
    assert.equal(args.pollTimeout, '30s');
  });

  test('boolean flags with no value become true', () => {
    const args = parseArgs(['--raw', '--health']);
    assert.equal(args.raw, true);
    assert.equal(args.health, true);
  });

  test('mixed positional and flags', () => {
    const args = parseArgs(['my-agent', '--port', '3000', '--unit', 'svc.service']);
    assert.deepEqual(args._, ['my-agent']);
    assert.equal(args.port, '3000');
    assert.equal(args.unit, 'svc.service');
  });

  test('_message captures words after the first positional', () => {
    const args = parseArgs(['agent', 'hello', 'world']);
    assert.equal(args._message, 'hello world');
  });

  test('empty argv returns empty result', () => {
    const args = parseArgs([]);
    assert.deepEqual(args._, []);
    assert.equal(args._message, '');
  });
});

describe('port validation logic', () => {
  // Reproduces the inline validation from cmdRegister
  function isValidPort(value) {
    const p = parseInt(value, 10);
    return !isNaN(p) && p >= 1 && p <= 65535;
  }

  test('valid ports are accepted', () => {
    assert.ok(isValidPort('1'));
    assert.ok(isValidPort('80'));
    assert.ok(isValidPort('5001'));
    assert.ok(isValidPort('65535'));
  });

  test('port 0 is rejected', () => {
    assert.equal(isValidPort('0'), false);
  });

  test('ports above 65535 are rejected', () => {
    assert.equal(isValidPort('65536'), false);
    assert.equal(isValidPort('99999'), false);
  });

  test('non-numeric strings are rejected', () => {
    assert.equal(isValidPort('abc'), false);
    assert.equal(isValidPort(''), false);
  });

  test('negative ports are rejected', () => {
    assert.equal(isValidPort('-1'), false);
  });
});
