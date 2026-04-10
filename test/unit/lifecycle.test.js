#!/usr/bin/env node
'use strict';

// =============================================================================
// Unit tests — Lifecycle
// Tests Lifecycle methods that do NOT require a running systemd daemon:
//   - Error paths (agent not found, no unit, invalid unit name)
//   - getLogs() priority validation (returns error before calling systemctl)
//   - generateUnit() — pure function, no systemd needed
// When systemctl is unavailable the run() helper gracefully returns ok:false,
// so all calls that do reach systemctl produce a deterministic error string.
// Uses Node.js built-in test runner (node:test, available since Node 18)
// =============================================================================

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Registry } = require('../../src/registry');
const { Lifecycle } = require('../../src/lifecycle');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an isolated Registry backed by a tmp file. */
function tmpRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag2ag-lc-test-'));
  return new Registry(path.join(dir, 'registry.json'));
}

/**
 * Build a Lifecycle pre-populated with one agent.
 * The agent has a well-formed systemdUnit so unit-resolution succeeds.
 */
function registryWithAgent(agentName = 'test-agent', systemdUnit = 'ag2ag-test.service') {
  const reg = tmpRegistry();
  reg.add({ name: agentName, port: 5001, systemdUnit });
  return { reg, lc: new Lifecycle(reg) };
}

// ---------------------------------------------------------------------------
// Resolution errors (no systemd interaction)
// ---------------------------------------------------------------------------

describe('Lifecycle', () => {
  describe('agent not in registry', () => {
    test('start returns error when agent not found', () => {
      const lc = new Lifecycle(tmpRegistry());
      const result = lc.start('ghost');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('"ghost" not found'), result.error);
    });

    test('stop returns error when agent not found', () => {
      const lc = new Lifecycle(tmpRegistry());
      const result = lc.stop('ghost');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('"ghost" not found'), result.error);
    });

    test('restart returns error when agent not found', () => {
      const lc = new Lifecycle(tmpRegistry());
      const result = lc.restart('ghost');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('"ghost" not found'), result.error);
    });

    test('isActive returns false when agent not found', () => {
      const lc = new Lifecycle(tmpRegistry());
      assert.equal(lc.isActive('ghost'), false);
    });

    test('getStatus returns error when agent not found', () => {
      const lc = new Lifecycle(tmpRegistry());
      const s = lc.getStatus('ghost');
      assert.ok(s.error.includes('"ghost" not found'), s.error);
    });

    test('getLogs returns error string when agent not found', () => {
      const lc = new Lifecycle(tmpRegistry());
      const result = lc.getLogs('ghost');
      assert.ok(typeof result === 'string');
      assert.ok(result.includes('"ghost" not found'), result);
    });
  });

  describe('agent has no systemdUnit', () => {
    test('start returns error about missing unit', () => {
      const reg = tmpRegistry();
      reg.add({ name: 'no-unit', port: 5001 }); // no systemdUnit field
      const lc = new Lifecycle(reg);
      const result = lc.start('no-unit');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('no systemd unit'), result.error);
    });

    test('getLogs returns error about missing unit', () => {
      const reg = tmpRegistry();
      reg.add({ name: 'no-unit', port: 5001 });
      const lc = new Lifecycle(reg);
      const result = lc.getLogs('no-unit');
      assert.ok(typeof result === 'string');
      assert.ok(result.includes('no systemd unit'), result);
    });
  });

  describe('invalid systemd unit name', () => {
    test('start rejects unit name with illegal characters', () => {
      const reg = tmpRegistry();
      reg.add({ name: 'bad-unit', port: 5001, systemdUnit: 'invalid unit name with spaces' });
      const lc = new Lifecycle(reg);
      const result = lc.start('bad-unit');
      assert.equal(result.ok, false);
      assert.ok(result.error.includes('Invalid unit name'), result.error);
    });

    test('getLogs rejects unit name with illegal characters', () => {
      const reg = tmpRegistry();
      reg.add({ name: 'bad-unit', port: 5001, systemdUnit: 'invalid unit name with spaces' });
      const lc = new Lifecycle(reg);
      const result = lc.getLogs('bad-unit');
      assert.ok(typeof result === 'string');
      assert.ok(result.includes('Invalid unit name'), result);
    });
  });

  // ---------------------------------------------------------------------------
  // getLogs — priority validation
  // ---------------------------------------------------------------------------

  describe('getLogs — priority validation', () => {
    const VALID_PRIORITIES = [
      'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug',
      '0', '1', '2', '3', '4', '5', '6', '7',
    ];

    test('null priority (default) does not return an invalid-priority error', () => {
      const { lc } = registryWithAgent();
      const result = lc.getLogs('test-agent', 10, null);
      // systemctl may fail on this machine — that is fine.
      // The priority error must NOT appear.
      assert.ok(!result.includes('Invalid log priority'), result);
    });

    for (const p of VALID_PRIORITIES) {
      test(`accepts valid priority "${p}"`, () => {
        const { lc } = registryWithAgent();
        const result = lc.getLogs('test-agent', 10, p);
        assert.ok(
          !result.includes('Invalid log priority'),
          `Priority "${p}" should be accepted, got: ${result}`,
        );
      });
    }

    test('rejects unknown priority string', () => {
      const { lc } = registryWithAgent();
      const result = lc.getLogs('test-agent', 10, 'verbose');
      assert.ok(typeof result === 'string');
      assert.ok(result.includes('Invalid log priority'), result);
    });

    test('rejects numeric-looking but out-of-range priority', () => {
      const { lc } = registryWithAgent();
      const result = lc.getLogs('test-agent', 10, '8');
      assert.ok(result.includes('Invalid log priority'), result);
    });

    test('rejects empty string priority', () => {
      const { lc } = registryWithAgent();
      const result = lc.getLogs('test-agent', 10, '');
      // Empty string is not in VALID_PRIORITIES
      assert.ok(result.includes('Invalid log priority'), result);
    });
  });

  // ---------------------------------------------------------------------------
  // getLogs — lines capping
  // ---------------------------------------------------------------------------

  describe('getLogs — lines clamping', () => {
    test('lines above 500 are capped at 500 (no priority error)', () => {
      const { lc } = registryWithAgent();
      // We cannot observe the actual capped value without running systemctl,
      // but we CAN confirm that getLogs does not return a priority-related
      // error when called with an oversized lines argument.
      const result = lc.getLogs('test-agent', 9999, null);
      assert.ok(!result.includes('Invalid log priority'), result);
    });

    test('lines below 1 default to 1 (no priority error)', () => {
      const { lc } = registryWithAgent();
      const result = lc.getLogs('test-agent', 0, null);
      assert.ok(!result.includes('Invalid log priority'), result);
    });
  });

  // ---------------------------------------------------------------------------
  // generateUnit — pure function, fully testable
  // ---------------------------------------------------------------------------

  describe('generateUnit', () => {
    const lc = new Lifecycle(tmpRegistry());

    test('returns a unitName and content string', () => {
      const { unitName, content } = lc.generateUnit({
        agentName: 'my-agent',
        scriptPath: '/app/agent.js',
        port: 5001,
        workingDir: '/app',
      });
      assert.equal(typeof unitName, 'string');
      assert.equal(typeof content, 'string');
      assert.ok(unitName.length > 0);
      assert.ok(content.length > 0);
    });

    test('unitName is prefixed with ag2ag-', () => {
      const { unitName } = lc.generateUnit({
        agentName: 'my-agent',
        scriptPath: '/app/agent.js',
        port: 5001,
        workingDir: '/app',
      });
      assert.ok(unitName.startsWith('ag2ag-'), `unitName: ${unitName}`);
    });

    test('content contains [Unit], [Service], [Install] sections', () => {
      const { content } = lc.generateUnit({
        agentName: 'my-agent',
        scriptPath: '/app/agent.js',
        port: 5001,
        workingDir: '/app',
      });
      assert.ok(content.includes('[Unit]'), 'Missing [Unit]');
      assert.ok(content.includes('[Service]'), 'Missing [Service]');
      assert.ok(content.includes('[Install]'), 'Missing [Install]');
    });

    test('content contains ExecStart with node and scriptPath', () => {
      const { content } = lc.generateUnit({
        agentName: 'my-agent',
        scriptPath: '/app/agent.js',
        port: 5001,
        workingDir: '/app',
      });
      assert.ok(content.includes('/app/agent.js'), 'Missing scriptPath in ExecStart');
      assert.ok(content.includes('node'), 'Missing node in ExecStart');
    });

    test('content includes PORT env var when port is provided', () => {
      const { content } = lc.generateUnit({
        agentName: 'my-agent',
        scriptPath: '/app/agent.js',
        port: 5001,
        workingDir: '/app',
      });
      assert.ok(content.includes('PORT=5001'), 'Missing PORT env var');
    });

    test('content includes custom description when provided', () => {
      const { content } = lc.generateUnit({
        agentName: 'my-agent',
        scriptPath: '/app/agent.js',
        port: 5001,
        workingDir: '/app',
        description: 'My Custom Description',
      });
      assert.ok(content.includes('My Custom Description'), 'Missing custom description');
    });

    test('content includes custom env vars', () => {
      const { content } = lc.generateUnit({
        agentName: 'my-agent',
        scriptPath: '/app/agent.js',
        port: 5001,
        workingDir: '/app',
        envVars: { MY_KEY: 'my_value', ANOTHER: '42' },
      });
      assert.ok(content.includes('MY_KEY=my_value'), 'Missing custom env var MY_KEY');
      assert.ok(content.includes('ANOTHER=42'), 'Missing custom env var ANOTHER');
    });

    test('sanitizes agent name with special characters into a safe unit name', () => {
      const { unitName } = lc.generateUnit({
        agentName: 'My Agent Name!',
        scriptPath: '/app/agent.js',
        port: 5001,
        workingDir: '/app',
      });
      // Unit name must not contain spaces or !
      assert.ok(!/[ !]/.test(unitName), `unitName has unsafe chars: ${unitName}`);
    });

    test('WorkingDirectory appears in content', () => {
      const { content } = lc.generateUnit({
        agentName: 'my-agent',
        scriptPath: '/app/agent.js',
        port: 5001,
        workingDir: '/opt/myapp',
      });
      assert.ok(content.includes('/opt/myapp'), 'Missing WorkingDirectory');
    });

    test('Restart policy defaults to on-failure', () => {
      const { content } = lc.generateUnit({
        agentName: 'my-agent',
        scriptPath: '/app/agent.js',
        port: 5001,
        workingDir: '/app',
      });
      assert.ok(content.includes('Restart=on-failure'), 'Missing default Restart policy');
    });

    test('custom restart policy is included', () => {
      const { content } = lc.generateUnit({
        agentName: 'my-agent',
        scriptPath: '/app/agent.js',
        port: 5001,
        workingDir: '/app',
        restart: 'always',
      });
      assert.ok(content.includes('Restart=always'), 'Missing custom Restart policy');
    });

    test('WantedBy=multi-user.target in [Install]', () => {
      const { content } = lc.generateUnit({
        agentName: 'my-agent',
        scriptPath: '/app/agent.js',
        port: 5001,
        workingDir: '/app',
      });
      assert.ok(content.includes('WantedBy=multi-user.target'), 'Missing WantedBy');
    });
  });
});
