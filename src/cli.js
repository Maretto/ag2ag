#!/usr/bin/env node
'use strict';

// =============================================================================
// ag2ag — CLI
// Command-line interface for managing A2A agents on a single host
// =============================================================================

const { Registry } = require('./registry');
const { Lifecycle } = require('./lifecycle');
const { AgentClient } = require('./client');
const path = require('path');
const fs = require('fs');

const registry = new Registry();
const lifecycle = new Lifecycle(registry);
const client = new AgentClient();

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', underline: '\x1b[4m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

const ok = (msg) => console.log(`${C.green}✓${C.reset} ${msg}`);
const err = (msg) => console.error(`${C.red}✗${C.reset} ${msg}`);
const info = (msg) => console.log(`${C.cyan}→${C.reset} ${msg}`);
const dim = (msg) => console.log(`${C.gray}  ${msg}${C.reset}`);

function pad(s, n) { return (s + ' '.repeat(n)).slice(0, n); }

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

  let port = registry.findAvailablePort();
  if (args.port) {
    const parsedPort = parseInt(args.port);
    if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      return err('Invalid port number provided.');
    }
    port = parsedPort;
  }

  const unit = args.unit || '';
  const user = args.user || null;
  const description = args.description || `A2A Agent: ${name}`;
  
  // Warn if URL doesn't use 127.0.0.1, reinforcing the security model
  if (args.url && !args.url.includes('127.0.0.1') && !args.url.includes('localhost')) {
    console.warn(`${C.yellow}Warning: URL provided does not use 127.0.0.1. A2A single-host model strongly recommends binding to localhost only.${C.reset}`);
  }
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

  const registryEntry = { name, port, systemdUnit: unit, card: agentCard };
  if (user) {
    registryEntry.systemdUser = user;
  }

  registry.add(registryEntry);
  ok(`${C.bold}${name}${C.reset} → :${port}${unit ? ` (${unit})` : ''}${user ? ` [user: ${user}]` : ''}`);
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

  console.log(`\n${C.bold} ag2ag${C.reset} — ${agents.length} agent(s)\n`);
  console.log(` ${pad('STATUS', 4)} ${pad('NAME', 18)} ${pad('PORT', 7)} ${pad('UNIT', 35)} ${options.health ? pad('HEALTH', 12) : ''}`);
  console.log(` ${'─'.repeat(4)} ${'─'.repeat(18)} ${'─'.repeat(7)} ${'─'.repeat(35)}${options.health ? ' ' + '─'.repeat(12) : ''}`);

  for (const agent of agents) {
    const sysd = agent.systemdUnit ? lifecycle.getStatus(agent.name) : null;
    const active = sysd?.active === 'active';
    const statusIcon = active ? `${C.green}●${C.reset}` : sysd?.active === 'failed' ? `${C.red}✗${C.reset}` : `${C.yellow}○${C.reset}`;
    const statusText = active ? `${C.green}up${C.reset}` : sysd?.active || `${C.dim}—${C.reset}`;

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

  const payload = {
    role: 'user',
    parts: [{ type: 'text', text: message }],
  };

  try {
    const { data: task } = await client.sendMessage(agent.port, payload);
    info(`Task ${task.id} → ${task.status.state}`);

    if (['submitted', 'working'].includes(task.status.state)) {
      const result = await client.waitForTask(agent.port, task.id, { timeout: 30000 });
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
  console.log(lifecycle.getLogs(name, parseInt(args.lines) || 50));
}

async function cmdUi(args) {
  const http = require('http');
  const port = parseInt(args.port) || 5000;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>ag2ag - Local Dashboard</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #f4f4f9; color: #333; margin: 0; padding: 2rem; }
    h1 { margin-top: 0; color: #2c3e50; }
    .agent-card { background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 1rem; }
    .agent-title { font-size: 1.25rem; font-weight: bold; margin-bottom: 0.5rem; display: flex; align-items: center; justify-content: space-between; }
    .status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #ccc; margin-right: 8px; }
    .status-dot.active { background: #2ecc71; }
    .meta { font-size: 0.9rem; color: #7f8c8d; margin-bottom: 1rem; }
    .skills { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .skill { background: #e0f2fe; color: #0284c7; padding: 0.2rem 0.6rem; border-radius: 4px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>ag2ag Local Dashboard</h1>
  <div id="agents">Loading...</div>
  <script>
    async function loadAgents() {
      try {
        const res = await fetch('/api/agents');
        const agents = await res.json();
        const html = agents.map(a => \`
          <div class="agent-card">
            <div class="agent-title">
              <div><span class="status-dot \${a.active === 'active' ? 'active' : ''}"></span>\${a.name}</div>
              <span class="meta">:\${a.port}</span>
            </div>
            <div class="meta">\${a.card.description || 'No description'}</div>
            <div class="skills">
              \${(a.card.skills || []).map(s => \`<span class="skill" title="\${s.description}">\${s.name}</span>\`).join('')}
            </div>
          </div>
        \`).join('');
        document.getElementById('agents').innerHTML = html || 'No agents registered.';
      } catch (e) {
        document.getElementById('agents').innerHTML = 'Error loading agents.';
      }
    }
    loadAgents();
    setInterval(loadAgents, 5000);
  </script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else if (req.url === '/api/agents') {
      const agents = registry.list().map(a => {
        const sysd = a.systemdUnit ? lifecycle.getStatus(a.name) : null;
        return { ...a, active: sysd ? sysd.active : 'unknown' };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agents));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, '127.0.0.1', () => {
    ok(`Local dashboard running at http://127.0.0.1:${port}`);
    info(`Press Ctrl+C to stop`);
  });
}

async function cmdClean(args) {
  const { TaskStore } = require('./task-store');
  const taskStore = new TaskStore();
  const days = parseInt(args.days) || 7;
  
  if (days < 0) return err('Days must be a non-negative number.');

  const agents = registry.list();
  if (agents.length === 0) return info('No agents registered.');

  let totalDeleted = 0;
  for (const agent of agents) {
    try {
      const deleted = taskStore.prune(agent.name, days);
      if (deleted > 0) {
        ok(`Pruned ${deleted} tasks for agent "${agent.name}" (older than ${days} days)`);
        totalDeleted += deleted;
      }
    } catch (e) {
      err(`Failed to clean tasks for ${agent.name}: ${e.message}`);
    }
  }
  
  if (totalDeleted === 0) {
    info(`No tasks older than ${days} days found to clean.`);
  } else {
    ok(`Cleaned a total of ${totalDeleted} tasks.`);
  }
}

// ─── Argument Parsing ──────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [], _message: '' };
  let capturing = false;
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
${C.bold}ag2ag${C.reset} ${C.dim}v0.1.0${C.reset} — A2A Operational Layer for Single-Host Environments

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
  call <name> <message> [--raw]     Send A2A message to agent
  list                              List all registered agents
  logs <name> [--lines N]           Show agent logs (journalctl)
  clean [--days N]                  Clean tasks older than N days (default 7)
  ui [--port N]                     Start local web dashboard

${C.bold}Register Options:${C.reset}
  --port <port>                     HTTP port (auto-assigned if omitted)
  --unit <systemd-unit>             Systemd unit name
  --user <systemd-user>             Systemd user to run the agent (for isolation)
  --description <desc>              Agent description
  --url <url>                       Agent URL (default: http://127.0.0.1:<port>)
  --skills <skill1,skill2>          Comma-separated skill names

${C.bold}Examples:${C.reset}
  ag2ag init
  ag2ag register my-agent --port 5001 --description "Does useful things"
  ag2ag status --health
  ag2ag call echo-agent "Hello world"
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
    case 'clean': return cmdClean(args);
    case 'ui': return cmdUi(args);
    default: err(`Unknown command: ${command}`); showHelp();
  }
}

main().catch(e => err(e.message));
