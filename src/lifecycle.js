#!/usr/bin/env node
'use strict';

// =============================================================================
// ag2ag — Lifecycle Manager
// Systemd-first agent lifecycle management
// ALWAYS resolves unit name from registry. NEVER infers.
// Uses execFileSync — no shell injection surface.
// =============================================================================

const { execFileSync } = require('child_process');

// Validate unit name: only allow systemd-safe characters
function _validateUnitName(unit) {
  if (!unit || typeof unit !== 'string') return false;
  // systemd unit names: alphanumeric, dash, dot, at-sign, escape, colon, underscore
  return /^[a-zA-Z0-9_.@:-]+$/.test(unit) && unit.length <= 256;
}

function run(args) {
  try {
    const output = execFileSync('systemctl', args, { encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
    return { ok: true, output: output.trim() };
  } catch (e) {
    return { ok: false, output: e.stdout?.toString().trim() || '', stderr: e.stderr?.toString().trim() || e.message };
  }
}

class Lifecycle {
  constructor(registry) {
    this.registry = registry;
  }

  // Always resolve from registry. Never guess. Validate unit name.
  _resolveUnit(agentName) {
    const agent = this.registry.get(agentName);
    if (!agent) return { error: `Agent "${agentName}" not found in registry` };
    if (!agent.systemdUnit) return { error: `Agent "${agentName}" has no systemd unit configured` };
    if (!_validateUnitName(agent.systemdUnit)) return { error: `Invalid unit name: "${agent.systemdUnit}"` };
    return { unit: agent.systemdUnit };
  }

  start(agentName) {
    const resolved = this._resolveUnit(agentName);
    if (resolved.error) return { ok: false, error: resolved.error };
    const { unit } = resolved;

    const r = run(['start', unit]);
    if (!r.ok) {
      const exists = run(['cat', unit]);
      if (!exists.ok) return { ok: false, error: `Unit ${unit} does not exist on this system. Is the agent deployed?` };
      return { ok: false, error: `Failed to start ${unit}: ${r.stderr}` };
    }
    return { ok: true, unit };
  }

  stop(agentName) {
    const resolved = this._resolveUnit(agentName);
    if (resolved.error) return { ok: false, error: resolved.error };
    const { unit } = resolved;

    const r = run(['stop', unit]);
    if (!r.ok) return { ok: false, error: `Failed to stop ${unit}: ${r.stderr}` };
    return { ok: true, unit };
  }

  restart(agentName) {
    const resolved = this._resolveUnit(agentName);
    if (resolved.error) return { ok: false, error: resolved.error };
    const { unit } = resolved;

    const r = run(['restart', unit]);
    if (!r.ok) return { ok: false, error: `Failed to restart ${unit}: ${r.stderr}` };
    return { ok: true, unit };
  }

  isActive(agentName) {
    const resolved = this._resolveUnit(agentName);
    if (resolved.error) return false;
    const r = run(['is-active', resolved.unit]);
    return r.ok && r.output === 'active';
  }

  getStatus(agentName) {
    const resolved = this._resolveUnit(agentName);
    if (resolved.error) return { unit: null, active: 'unknown', enabled: 'unknown', error: resolved.error };

    const { unit } = resolved;
    const activeR = run(['is-active', unit]);
    const enabledR = run(['is-enabled', unit]);
    return {
      unit,
      active: activeR.ok ? activeR.output : 'unknown',
      enabled: enabledR.ok ? enabledR.output : 'unknown',
    };
  }

  getLogs(agentName, lines = 50) {
    const resolved = this._resolveUnit(agentName);
    if (resolved.error) return resolved.error;
    const safeLines = Math.max(1, Math.min(parseInt(lines) || 50, 500));
    const r = run(['--no-pager', `-n${safeLines}`, '-u', resolved.unit]);
    return r.ok ? r.output : `Could not read logs for ${resolved.unit}`;
  }

  // Generate a systemd unit file for a new agent
  generateUnit(options) {
    const {
      agentName,
      scriptPath,
      port,
      envVars = {},
      workingDir,
      description = `A2A Agent: ${agentName}`,
      after = 'network.target',
      restart = 'on-failure',
      restartSec = 5,
      user = 'root',
    } = options;

    const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const unitName = `ag2ag-${safeName}`;

    const envLines = Object.entries(envVars)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `Environment="${k}=${v}"`)
      .join('\n');

    return {
      unitName,
      content: `[Unit]
Description=${description}
After=${after}

[Service]
Type=simple
User=${user}
WorkingDirectory=${workingDir}
ExecStart=/usr/bin/node ${scriptPath}
Restart=${restart}
RestartSec=${restartSec}
${port ? `Environment="PORT=${port}"` : ''}
${envLines}

[Install]
WantedBy=multi-user.target
`,
    };
  }
}

module.exports = { Lifecycle };
