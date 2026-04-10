#!/usr/bin/env node
'use strict';

// =============================================================================
// ag2ag — CLI
// Command-line interface for managing A2A agents on a single host
// =============================================================================

const { Registry } = require('./registry');
const { Lifecycle } = require('./lifecycle');
const { AgentClient, DEFAULTS } = require('./client');
const path = require('path');
const fs = require('fs');

const registry = new Registry(process.env.AG2AG_REGISTRY_PATH);
const lifecycle = new Lifecycle(registry);

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', underline: '\x1b[4m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

const ok = (msg) => console.log(`${C.green}✓${C.reset} ${msg}`);
const err = (msg) => console.error(`${C.red}✗${C.reset} ${msg}`);
const info = (msg) => console.log(`${C.cyan}→${C.reset} ${msg}`);
const dim = (msg) => console.log(`${C.gray}  ${msg}${C.reset}`);

function pad(s, n) { return (s + ' '.repeat(n)).slice(0, n); }

function parseMs(value) {
  if (!value) return undefined;
  if (value.endsWith('s')) return parseInt(value, 10) * 1000;
  if (value.endsWith('m')) return parseInt(value, 10) * 60_000;
  return parseInt(value, 10);
}

// ─── Commands ──────────────────────────────────────────────────────────────

async function cmdInit() {
  const configDir = path.join(__dirname, '..', 'config');
  const dataDir = path.join(__dirname, '..', 'data', 'tasks');

  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const regPath = path.join(configDir, 'registry.json');
  if (!fs.existsSync(regPath)) {
    fs.writeFileSync(regPath, JSON.stringify({ agents: [], version: '1.0' }, null, 2) + '\n');
    ok('Registry initialized');
  } else {
    info('Registry already exists');
  }
  ok(`Data dir: ${dataDir}`);

  console.log(`\n${C.bold}Next:${C.reset}`);
  console.log(`  ag2ag register <name> --port <port> --unit <systemd-unit>`);
}

async function cmdRegister(name, args) {
  if (!name) return err('Usage: ag2ag register <name> --port <port> --unit <unit>');

  // Validate port if explicitly provided
  let port;
  if (args.port !== undefined) {
    port = parseInt(args.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return err(`Invalid port: "${args.port}" — must be a number between 1 and 65535`);
    }
  } else {
    port = registry.findAvailablePort();
  }

  const unit = args.unit || '';
  const description = args.description || `A2A Agent: ${name}`;
  const url = args.url || `http://127.0.0.1:${port}`;

  const agentCard = {
    schemaVersion: '1.0',
    name,
    description,
    url,
    capabilities: { streaming: false, pushNotifications: false },
    skills: args.skills
      ? args.skills.split(',').map(s => ({ name: s.trim(), description: `Skill: ${s.trim()}` }))
      : [{ name: 'default', description: 'Generic A2A agent' }],
  };

  registry.add({ name, port, systemdUnit: unit, card: agentCard });
  ok(`${C.bold}${name}${C.reset} → :${port}${unit ? ` (${unit})` : ''}`);
}

async function cmdUnregister(name) {
  if (!name) return err('Usage: ag2ag unregister <name>');
  if (registry.remove(name)) ok(`"${name}" removed from registry`);
  else err(`"${name}" not found in registry`);
}

async function cmdStart(name) {
  if (!name) return err('Usage: ag2ag start <name>');
  const result = lifecycle.start(name);
  if (result.ok) ok(`${name} started (${result.unit})`);
  else err(result.error);
}

async function cmdStop(name) {
  if (!name) return err('Usage: ag2ag stop <name>');
  const result = lifecycle.stop(name);
  if (result.ok) ok(`${name} stopped (${result.unit})`);
  else err(result.error);
}

async function cmdRestart(name) {
  if (!name) return err('Usage: ag2ag restart <name>');
  const result = lifecycle.restart(name);
  if (result.ok) ok(`${name} restarted (${result.unit})`);
  else err(result.error);
}

async function cmdStatus(options = {}) {
  const agents = registry.list();
  if (agents.length === 0) {
    info('No agents registered. Use `ag2ag register <name>` to add one.');
    return;
  }

  const client = new AgentClient({ timeout: 5000 });

  console.log(`\n${C.bold} ag2ag${C.reset} — ${agents.length} agent(s)\n`);
  console.log(` ${pad('STATUS', 4)} ${pad('NAME', 18)} ${pad('PORT', 7)} ${pad('UNIT', 35)} ${options.health ? pad('HEALTH', 12) : ''}`);
  console.log(` ${'─'.repeat(4)} ${'─'.repeat(18)} ${'─'.repeat(7)} ${'─'.repeat(35)}${options.health ? ' ' + '─'.repeat(12) : ''}`);

  for (const agent of agents) {
    const sysd = agent.systemdUnit ? lifecycle.getStatus(agent.name) : null;
    const active = sysd?.active === 'active';
    const statusIcon = active ? `${C.green}●${C.reset}` : sysd?.active === 'failed' ? `${C.red}✗${C.reset}` : `${C.yellow}○${C.reset}`;

    let healthCol = '';
    if (options.health && agent.port > 0) {
      try {
        const { status: httpStatus, data } = await client.getCard(agent.port);
        if (httpStatus === 200 && data?.name) {
          healthCol = `${C.green}responding${C.reset}`;
        } else {
          healthCol = `${C.yellow}no card${C.reset}`;
        }
      } catch (e) {
        healthCol = active ? `${C.red}unreachable${C.reset}` : `${C.dim}n/a${C.reset}`;
      }
    } else if (options.health) {
      healthCol = `${C.dim}no port${C.reset}`;
    }

    const portStr = agent.port > 0 ? `:${agent.port}` : '-';
    const unitStr = agent.systemdUnit || `${C.dim}(none)${C.reset}`;

    console.log(` ${statusIcon}  ${pad(agent.name, 18)} ${pad(portStr, 7)} ${unitStr}${options.health ? ' ' + healthCol : ''}`);
  }
  console.log();
}

async function cmdCard(name) {
  if (!name) return err('Usage: ag2ag card <name>');
  const agent = registry.get(name);
  if (!agent) return err(`"${name}" not found in registry`);

  const client = new AgentClient({ timeout: 10000 });

  // Live fetch first
  if (agent.port > 0) {
    try {
      const { data } = await client.getCard(agent.port);
      if (data?.name) return console.log(JSON.stringify(data, null, 2));
    } catch (_) {}
  }
  // Fallback to registry
  console.log(JSON.stringify(agent.card, null, 2));
  info('(Registry card — agent may be offline)');
}

async function cmdCall(name, args) {
  if (!name) return err('Usage: ag2ag call <name> <message>');
  const agent = registry.get(name);
  if (!agent) return err(`"${name}" not found in registry`);
  if (agent.port <= 0) return err(`"${name}" has no HTTP port (Discord-only agent)`);

  const message = args._message;
  if (!message) return err('Usage: ag2ag call <name> <message>');

  const requestTimeout = parseMs(args.timeout) || DEFAULTS.requestTimeout;
  const pollTimeout = parseMs(args.pollTimeout) || DEFAULTS.pollTimeout;
  const pollInterval = parseMs(args.pollInterval) || DEFAULTS.pollInterval;

  const client = new AgentClient({ timeout: requestTimeout });

  const payload = {
    role: 'user',
    parts: [{ type: 'text', text: message }],
  };

  try {
    const { data: task } = await client.sendMessage(agent.port, payload);
    info(`Task ${task.id} → ${task.status.state}`);

    if (['submitted', 'working'].includes(task.status.state)) {
      info(`Polling (timeout: ${pollTimeout/1000}s, interval: ${pollInterval/1000}s)`);
      const result = await client.waitForTask(agent.port, task.id, { timeout: pollTimeout, interval: pollInterval });
      if (result.status?.state === 'completed') {
        ok('Completed');
        if (result.artifacts?.length) {
          for (const art of result.artifacts) {
            if (args.raw) {
              console.log(JSON.stringify(art));
            } else {
              const text = art.parts?.[0]?.text || JSON.stringify(art);
              console.log(text);
            }
          }
        }
      } else {
        err(`${result.status?.state}: ${result.status?.message || 'unknown'}`);
      }
    }
  } catch (e) {
    err(`Failed: ${e.message}`);
  }
}

async function cmdList() {
  const agents = registry.list();
  if (agents.length === 0) return info('No agents registered.');
  for (const agent of agents) {
    const sysd = agent.systemdUnit ? lifecycle.getStatus(agent.name) : null;
    const active = sysd?.active === 'active' ? '●' : '○';
    console.log(`${active} ${agent.name}\t:${agent.port > 0 ? agent.port : '-'}\t${agent.systemdUnit || '-'}`);
  }
}

async function cmdLogs(name, args) {
  if (!name) return err('Usage: ag2ag logs <name>');
  console.log(lifecycle.getLogs(name, parseInt(args.lines) || 50, args.priority || null));
}

// ─── Argument Parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [], _message: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(argv[i]);
      if (args._.length > 1) {
        args._message += (args._message ? ' ' : '') + argv[i];
      }
    }
  }
  return args;
}

function showHelp() {
  console.log(`
${C.bold}ag2ag${C.reset} ${C.dim}v0.3.0${C.reset} — A2A Operational Layer for Single-Host Environments

${C.bold}Usage:${C.reset}
  ag2ag <command> [options]

${C.bold}Commands:${C.reset}
  init                              Initialize registry and data directories
  register <name> [options]         Register an agent
  unregister <name>                 Remove agent from registry
  start <name>                      Start agent via systemd
  stop <name>                       Stop agent via systemd
  restart <name>                    Restart agent via systemd
  status [--health]                 Show all agents (with HTTP health check)
  card <name>                       Show agent's AgentCard (live or registry)
  call <name> <message> [options]   Send A2A message to agent
  list                              List all registered agents
  logs <name> [--lines N] [--priority LEVEL]  Show agent logs (journalctl)

${C.bold}Register Options:${C.reset}
  --port <port>                     HTTP port (auto-assigned if omitted)
  --unit <systemd-unit>             Systemd unit name
  --description <desc>              Agent description
  --url <url>                       Agent URL (default: http://127.0.0.1:<port>)
  --skills <skill1,skill2>          Comma-separated skill names

${C.bold}Call Options:${C.reset}
  --timeout <ms|Ns|Nm>             HTTP request timeout (default: ${DEFAULTS.requestTimeout/1000}s)
  --poll-timeout <ms|Ns|Nm>        Polling timeout for result (default: ${DEFAULTS.pollTimeout/1000}s)
  --poll-interval <ms|Ns|Nm>       Time between polls (default: ${DEFAULTS.pollInterval/1000}s)
  --raw                             Output raw JSON artifacts

${C.bold}Timeout Formats:${C.reset}
  Plain number = milliseconds  |  30s = 30 seconds  |  5m = 5 minutes

${C.bold}Environment Variables:${C.reset}
  AG2AG_REQUEST_TIMEOUT   Default HTTP request timeout (ms)
  AG2AG_POLL_TIMEOUT      Default polling timeout (ms)
  AG2AG_POLL_INTERVAL     Default polling interval (ms)

${C.bold}Examples:${C.reset}
  ag2ag init
  ag2ag register diagnosticador --port 3102 --unit daemonlab-diagnosticador
  ag2ag status --health
  ag2ag call echo-agent "Hello world"
  ag2ag call deep-analyzer "Analyze X" --timeout 60s --poll-timeout 10m
  ag2ag call echo-agent "test" --raw
`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    return showHelp();
  }

  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const name = args._[0];

  switch (command) {
    case 'init': return cmdInit();
    case 'register': return cmdRegister(name, args);
    case 'unregister': return cmdUnregister(name);
    case 'start': return cmdStart(name);
    case 'stop': return cmdStop(name);
    case 'restart': return cmdRestart(name);
    case 'status': return cmdStatus(args);
    case 'card': return cmdCard(name);
    case 'call': return cmdCall(name, args);
    case 'list': return cmdList();
    case 'logs': return cmdLogs(name, args);
    default: err(`Unknown command: ${command}`); showHelp();
  }
}

module.exports = { parseArgs, parseMs };

if (require.main === module) {
  main().catch(e => err(e.message));
}
