#!/usr/bin/env node
'use strict';

// =============================================================================
// Unit tests — Lifecycle
// Tests the Lifecycle class, focusing on the parts that don't require systemd.
// Uses Node.js built-in test runner (node:test, available since Node 18)
// =============================================================================

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Lifecycle } = require('../../src/lifecycle');
const { Registry } = require('../../src/registry');

// Helper: create a temporary registry with agents pre-loaded
function tmpRegistry(agents = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag2ag-lc-test-'));
  const regPath = path.join(dir, 'registry.json');
  fs.writeFileSync(regPath, JSON.stringify({ version: '1.0', agents }, null, 2));
  return new Registry(regPath);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Lifecycle', () => {
  describe('_resolveUnit (error paths)', () => {
    test('returns error when agent is not in registry', () => {
      const lc = new Lifecycle(tmpRegistry());
      const result = lc._resolveUnit('nonexistent');
      assert.ok(result.error, 'should return an error');
      assert.ok(result.error.includes('nonexistent'), 'error should mention agent name');
    });

    test('returns error when agent has no systemdUnit', () => {
      const reg = tmpRegistry([{ name: 'no-unit', port: 5001 }]);
      const lc = new Lifecycle(reg);
      const result = lc._resolveUnit('no-unit');
      assert.ok(result.error, 'should return an error for missing unit');
    });

    test('returns error for invalid unit name characters', () => {
      const reg = tmpRegistry([{
        name: 'bad-unit',
        port: 5001,
        systemdUnit: 'invalid unit name with spaces',
      }]);
      const lc = new Lifecycle(reg);
      const result = lc._resolveUnit('bad-unit');
      assert.ok(result.error, 'should return an error for invalid unit name');
    });

    test('resolves successfully for valid unit name', () => {
      const reg = tmpRegistry([{
        name: 'good-agent',
        port: 5001,
        systemdUnit: 'ag2ag-good-agent.service',
      }]);
      const lc = new Lifecycle(reg);
      const result = lc._resolveUnit('good-agent');
      assert.equal(result.unit, 'ag2ag-good-agent.service');
      assert.ok(!result.error, 'should not have an error');
    });
  });

  describe('start / stop / restart (registry errors)', () => {
    test('start returns ok:false when agent not found', () => {
      const lc = new Lifecycle(tmpRegistry());
      const result = lc.start('ghost-agent');
      assert.equal(result.ok, false);
      assert.ok(result.error);
    });

    test('stop returns ok:false when agent not found', () => {
      const lc = new Lifecycle(tmpRegistry());
      const result = lc.stop('ghost-agent');
      assert.equal(result.ok, false);
      assert.ok(result.error);
    });

    test('restart returns ok:false when agent not found', () => {
      const lc = new Lifecycle(tmpRegistry());
      const result = lc.restart('ghost-agent');
      assert.equal(result.ok, false);
      assert.ok(result.error);
    });

    test('isActive returns false when agent not found', () => {
      const lc = new Lifecycle(tmpRegistry());
      assert.equal(lc.isActive('ghost-agent'), false);
    });

    test('getStatus returns error field when agent not found', () => {
      const lc = new Lifecycle(tmpRegistry());
      const status = lc.getStatus('ghost-agent');
      assert.ok(status.error, 'should have error field');
      assert.equal(status.active, 'unknown');
      assert.equal(status.enabled, 'unknown');
    });
  });

  describe('getLogs (priority validation)', () => {
    test('rejects invalid priority and returns error string', () => {
      const reg = tmpRegistry([{
        name: 'log-agent',
        port: 5001,
        systemdUnit: 'log-agent.service',
      }]);
      const lc = new Lifecycle(reg);
      const result = lc.getLogs('log-agent', 10, 'invalid-priority');
      assert.ok(typeof result === 'string', 'should return a string');
      assert.ok(result.includes('Invalid log priority'), `got: ${result}`);
    });

    test('accepts numeric priority string', () => {
      // We can't actually call journalctl in tests, but we can verify that
      // a valid priority string passes the validation check without returning
      // an "Invalid log priority" error.
      const reg = tmpRegistry([{
        name: 'log-agent2',
        port: 5001,
        systemdUnit: 'log-agent2.service',
      }]);
      const lc = new Lifecycle(reg);
      // The call will fail because systemctl/journalctl is not available in
      // the test environment, but it should NOT fail due to priority validation.
      const result = lc.getLogs('log-agent2', 10, '3');
      // 'err' priority is valid — result is either logs or a "Could not read" message
      assert.ok(!result.includes('Invalid log priority'), `priority should be valid, got: ${result}`);
    });

    test('accepts named priority string', () => {
      const reg = tmpRegistry([{
        name: 'log-agent3',
        port: 5001,
        systemdUnit: 'log-agent3.service',
      }]);
      const lc = new Lifecycle(reg);
      const result = lc.getLogs('log-agent3', 10, 'warning');
      assert.ok(!result.includes('Invalid log priority'), `priority should be valid, got: ${result}`);
    });

    test('returns error string when agent not found', () => {
      const lc = new Lifecycle(tmpRegistry());
      const result = lc.getLogs('unknown-agent', 10);
      assert.ok(typeof result === 'string');
      assert.ok(result.includes('unknown-agent'), `got: ${result}`);
    });
  });

  describe('generateUnit', () => {
    test('generates a valid systemd unit file', () => {
      const lc = new Lifecycle(tmpRegistry());
      const { unitName, content } = lc.generateUnit({
        agentName: 'my-agent',
        scriptPath: '/opt/agents/my-agent/index.js',
        port: 5001,
        workingDir: '/opt/agents/my-agent',
        user: 'nodeuser',
      });

      assert.equal(unitName, 'ag2ag-my-agent');
      assert.ok(content.includes('[Unit]'));
      assert.ok(content.includes('[Service]'));
      assert.ok(content.includes('[Install]'));
      assert.ok(content.includes('ExecStart=/usr/bin/node /opt/agents/my-agent/index.js'));
      assert.ok(content.includes('User=nodeuser'));
      assert.ok(content.includes('Environment="PORT=5001"'));
    });

    test('sanitizes agent name to lowercase alphanumeric with dashes', () => {
      const lc = new Lifecycle(tmpRegistry());
      const { unitName } = lc.generateUnit({
        agentName: 'My Agent (v2)',
        scriptPath: '/opt/agent.js',
        workingDir: '/opt',
      });
      assert.equal(unitName, 'ag2ag-my-agent--v2-');
    });

    test('uses root as default user', () => {
      const lc = new Lifecycle(tmpRegistry());
      const { content } = lc.generateUnit({
        agentName: 'default-user-agent',
        scriptPath: '/opt/agent.js',
        workingDir: '/opt',
      });
      assert.ok(content.includes('User=root'));
    });

    test('uses default description when not provided', () => {
      const lc = new Lifecycle(tmpRegistry());
      const { content } = lc.generateUnit({
        agentName: 'my-agent',
        scriptPath: '/opt/agent.js',
        workingDir: '/opt',
      });
      assert.ok(content.includes('Description=A2A Agent: my-agent'));
    });

    test('includes custom env vars in the unit file', () => {
      const lc = new Lifecycle(tmpRegistry());
      const { content } = lc.generateUnit({
        agentName: 'env-agent',
        scriptPath: '/opt/agent.js',
        workingDir: '/opt',
        envVars: { API_KEY: 'secret123', LOG_LEVEL: 'debug' },
      });
      assert.ok(content.includes('Environment="API_KEY=secret123"'));
      assert.ok(content.includes('Environment="LOG_LEVEL=debug"'));
    });

    test('skips env vars with undefined value', () => {
      const lc = new Lifecycle(tmpRegistry());
      const { content } = lc.generateUnit({
        agentName: 'env-agent2',
        scriptPath: '/opt/agent.js',
        workingDir: '/opt',
        envVars: { SET_KEY: 'value', UNSET_KEY: undefined },
      });
      assert.ok(content.includes('Environment="SET_KEY=value"'));
      assert.ok(!content.includes('UNSET_KEY'));
    });
  });
});
