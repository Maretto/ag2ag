#!/usr/bin/env node
'use strict';

// =============================================================================
// Unit tests — Registry
// Uses Node.js built-in test runner (node:test, available since Node 18)
// =============================================================================

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Registry } = require('../../src/registry');

function tmpRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag2ag-reg-test-'));
  return new Registry(path.join(dir, 'registry.json'));
}

describe('Registry', () => {
  describe('add / get / list / remove', () => {
    test('add and get an agent', () => {
      const reg = tmpRegistry();
      reg.add({ name: 'my-agent', port: 5001 });
      const agent = reg.get('my-agent');
      assert.equal(agent.name, 'my-agent');
      assert.equal(agent.port, 5001);
    });

    test('add overwrites existing agent', () => {
      const reg = tmpRegistry();
      reg.add({ name: 'a', port: 5001 });
      reg.add({ name: 'a', port: 5002 });
      assert.equal(reg.get('a').port, 5002);
      assert.equal(reg.list().length, 1);
    });

    test('list returns all agents', () => {
      const reg = tmpRegistry();
      reg.add({ name: 'a', port: 5001 });
      reg.add({ name: 'b', port: 5002 });
      assert.equal(reg.list().length, 2);
    });

    test('remove returns true for existing agent', () => {
      const reg = tmpRegistry();
      reg.add({ name: 'a', port: 5001 });
      assert.equal(reg.remove('a'), true);
      assert.equal(reg.get('a'), null);
    });

    test('remove returns false for unknown agent', () => {
      const reg = tmpRegistry();
      assert.equal(reg.remove('ghost'), false);
    });

    test('get returns null for unknown agent', () => {
      const reg = tmpRegistry();
      assert.equal(reg.get('ghost'), null);
    });
  });

  describe('findAvailablePort', () => {
    test('returns startPort when no agents registered', () => {
      const reg = tmpRegistry();
      assert.equal(reg.findAvailablePort(5001), 5001);
    });

    test('skips used ports', () => {
      const reg = tmpRegistry();
      reg.add({ name: 'a', port: 5001 });
      reg.add({ name: 'b', port: 5002 });
      assert.equal(reg.findAvailablePort(5001), 5003);
    });
  });

  describe('count and update', () => {
    test('count returns agent count', () => {
      const reg = tmpRegistry();
      assert.equal(reg.count(), 0);
      reg.add({ name: 'a', port: 5001 });
      assert.equal(reg.count(), 1);
    });

    test('update merges fields', () => {
      const reg = tmpRegistry();
      reg.add({ name: 'a', port: 5001 });
      const updated = reg.update('a', { port: 5099 });
      assert.equal(updated.port, 5099);
      assert.equal(reg.get('a').port, 5099);
    });

    test('update returns null for unknown agent', () => {
      const reg = tmpRegistry();
      assert.equal(reg.update('ghost', { port: 5099 }), null);
    });
  });

  describe('schema migration', () => {
    test('loads a registry file missing the version field', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag2ag-reg-mig-'));
      const regPath = path.join(dir, 'registry.json');
      // Write a v0 registry (no version)
      fs.writeFileSync(regPath, JSON.stringify({ agents: [{ name: 'legacy', port: 5001 }] }));

      const reg = new Registry(regPath);
      assert.equal(reg.count(), 1);
      assert.equal(reg.get('legacy').name, 'legacy');
    });

    test('loads a corrupt registry and returns empty', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag2ag-reg-corrupt-'));
      const regPath = path.join(dir, 'registry.json');
      fs.writeFileSync(regPath, 'NOT JSON');

      const reg = new Registry(regPath);
      assert.equal(reg.count(), 0);
    });

    test('handles null/missing agents array', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag2ag-reg-null-'));
      const regPath = path.join(dir, 'registry.json');
      fs.writeFileSync(regPath, JSON.stringify({ version: '1.0' }));

      const reg = new Registry(regPath);
      assert.equal(reg.count(), 0);
      // should not throw on add
      reg.add({ name: 'new', port: 5001 });
      assert.equal(reg.count(), 1);
    });
  });

  describe('persistence', () => {
    test('data survives a Registry reload', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag2ag-reg-persist-'));
      const regPath = path.join(dir, 'registry.json');

      const reg1 = new Registry(regPath);
      reg1.add({ name: 'persistent', port: 5001 });

      const reg2 = new Registry(regPath);
      assert.equal(reg2.get('persistent').port, 5001);
    });
  });
});
