---
title: "How to Run A2A-Compatible Agents on a Single VPS (No Docker, No Kubernetes)"
published: false
description: "A practical guide to running Agent-to-Agent protocol agents on a single host with Node.js and systemd — using ag2ag, an open-source operational layer."
tags: a2a, aiagents, nodejs, selfhosted
cover_image: https://raw.githubusercontent.com/Maretto/ag2ag/main/docs/cover.png
---

The [Agent-to-Agent (A2A) protocol](https://a2a-protocol.org) is becoming the standard for AI agent interoperability. But most guides assume you're running Kubernetes, Docker Compose, or a cloud platform.

What if you just want to run a few agents on a single VPS? No containers. No orchestration. Just agents talking to each other on localhost.

That's what [ag2ag](https://github.com/Maretto/ag2ag) does.

## What is ag2ag?

ag2ag is an open-source operational layer for running A2A-compatible agents on a single host. It provides:

- **Local registry** — JSON file tracking all your agents, their ports, and systemd units
- **Lifecycle management** — start, stop, restart agents via systemd with `--user` support
- **Discovery** — each agent exposes an AgentCard at `GET /card`
- **Messaging** — agents send messages to each other on localhost
- **Task persistence** — JSONL files that survive restarts, with auto-cleanup
- **SSE Streaming** — real-time task updates via Server-Sent Events
- **Rate limiting** — sliding window per agent to prevent abuse
- **Health & Metrics** — built-in observability endpoints
- **Config module** — centralized settings with environment variable overrides
- **CLI** — manage everything from the terminal

One external dependency: [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk). Everything else is Node.js built-ins.

> **Not affiliated with, endorsed by, or connected to the A2A Protocol project, Google, or the Linux Foundation.**

## Prerequisites

- A Linux server (VPS, homelab, dev VM)
- Node.js 18+
- systemd (comes with any modern Linux distro)

```bash
node --version  # v22.x recommended
```

## Step 1: Install ag2ag

```bash
npm install -g ag2ag
```

Or clone and link:

```bash
git clone https://github.com/Maretto/ag2ag.git
cd ag2ag && npm install && npm link
```

## Step 2: Initialize

```bash
ag2ag init
```

This creates the registry file and data directories.

## Step 3: Build Your First Agent

Create a file called `my-agent.js`:

```javascript
const { AgentServer } = require('ag2ag');

const card = {
  schemaVersion: '1.0',
  name: 'greeter',
  description: 'A simple greeting agent',
  url: 'http://127.0.0.1:5001',
  capabilities: { streaming: false, pushNotifications: false },
  skills: [
    { name: 'greet', description: 'Returns a friendly greeting' }
  ],
};

async function handleMessage(message, task) {
  const text = message.parts?.[0]?.text || 'unknown';

  return {
    parts: [{ type: 'text', text: `Hello! You said: "${text}"` }],
    source: 'greeter',
    timestamp: new Date().toISOString(),
  };
}

const server = new AgentServer({
  agentCard: card,
  agentName: 'greeter',
  port: 5001,
  handler: handleMessage,
});

server.start().then(({ port }) => {
  console.log(`Greeter agent running on port ${port}`);
});
```

## Step 4: Test It

```bash
node my-agent.js &
```

Check its AgentCard:

```bash
curl http://127.0.0.1:5001/card | jq .
```

Send a message:

```bash
ag2ag register greeter --port 5001 --description "A simple greeting agent"
ag2ag call greeter "Hey there"
```

## Step 5: Build a Second Agent (That Calls the First)

Now the interesting part — an agent that discovers and calls another agent:

```javascript
const { AgentServer, AgentClient } = require('ag2ag');

const card = {
  schemaVersion: '1.0',
  name: 'orchestrator',
  description: 'Calls the greeter agent and returns the response',
  url: 'http://127.0.0.1:5002',
  capabilities: { streaming: false, pushNotifications: false },
  skills: [
    { name: 'forward-greeting', description: 'Forwards a message to the greeter' }
  ],
};

async function handleMessage(message, task) {
  const text = message.parts?.[0]?.text || 'hello from orchestrator';

  const client = new AgentClient();
  const result = await client.sendMessage(5001, {
    role: 'user',
    parts: [{ type: 'text', text }],
  });

  const completed = await client.waitForTask(5001, result.data.id, {
    interval: 500,
    timeout: 10000,
  });

  const response = completed.artifacts?.[0]?.parts?.[0]?.text || 'no response';

  return {
    parts: [{ type: 'text', text: `Greeter responded: "${response}"` }],
    source: 'orchestrator',
    timestamp: new Date().toISOString(),
  };
}

const server = new AgentServer({
  agentCard: card,
  agentName: 'orchestrator',
  port: 5002,
  handler: handleMessage,
});

server.start().then(({ port }) => {
  console.log(`Orchestrator running on port ${port}`);
});
```

Run it:

```bash
node orchestrator.js &
ag2ag register orchestrator --port 5002 --description "Calls greeter agent"
ag2ag call orchestrator "A2A is cool"
```

You just built **agent composition** — one agent discovering and calling another via the A2A protocol.

## Step 6: Deploy with systemd

For production use, you want agents running as systemd services. ag2ag handles this:

```bash
# Generate a systemd unit
ag2ag register greeter --port 5001 --unit greeter.service

# Start as a service
ag2ag start greeter

# Check status
ag2ag status --health

# View logs with priority filter
ag2ag logs greeter --priority err
```

Agents now survive reboots, restart on failure, and integrate with your server's logging.

## Configuration

All settings are centralized and configurable via environment variables:

```bash
# Override defaults
AG2AG_PORT=5005 ag2ag start my-agent
AG2AG_RATE_LIMIT_MAX=100 AG2AG_RATE_LIMIT_WINDOW_MS=120000 ag2ag start my-agent
```

| Variable | Default | What it controls |
|---|---|---|
| `AG2AG_PORT` | 5001 | Default HTTP port |
| `AG2AG_BIND_HOST` | 127.0.0.1 | Network interface |
| `AG2AG_MAX_BODY_SIZE` | 1MB | Max request body |
| `AG2AG_RATE_LIMIT_MAX` | 60 | Tasks per agent per window |
| `AG2AG_RATE_LIMIT_WINDOW_MS` | 60s | Rate limit window |
| `AG2AG_CLEANUP_MAX_DAYS` | 7 | Task retention period |

## Additional Commands

```bash
# Clean old tasks
ag2ag clean --days 7

# Start web dashboard
ag2ag ui --port 8080

# Interact with Jules API for code generation
ag2ag jules create "Add error handling" --repo my-project
ag2ag jules status <session-id>
ag2ag jules approve <session-id>
```

## Real-World Example: Health Proxy

I use this in production with a **Health Proxy** agent that queries multiple services and returns an aggregated health report:

```javascript
async function handleMessage(message, task) {
  const client = new AgentClient();

  const [gateway, mesh] = await Promise.all([
    client.getCard(3099),
    client.getCard(3101),
  ]);

  return {
    parts: [{
      type: 'text',
      text: `API Gateway: ${gateway.data.name}\nMesh Ping: ${mesh.data.name}`
    }],
    source: 'health-proxy',
    timestamp: new Date().toISOString(),
  };
}
```

This agent doesn't know about the other agents at build time — it discovers them at runtime via their AgentCards.

## Testing

ag2ag includes comprehensive test suites:

```bash
npm test              # All tests
npm run test:unit     # Unit tests (cli, config, lifecycle, registry, server, task-store)
npm run test:concurrency  # Concurrency stress tests
```

## Security Considerations

ag2ag is designed for **localhost-only** environments. Important limitations:

- **No authentication** — all communication is unencrypted HTTP on loopback
- **No inter-agent isolation** — agents run as systemd services, typically under the same user
- **Body limit** — 1MB max payload per request

For more details, see [SECURITY.md](https://github.com/Maretto/ag2ag/blob/main/SECURITY.md).

## When to Use This vs Alternatives

| Situation | Use |
|---|---|
| Single VPS, 2-20 agents | ag2ag |
| Multi-host, distributed | Docker Compose, Kubernetes |
| Need auth/encryption | Build your own auth layer or use a service mesh |
| Just managing Node.js processes | PM2 |
| Building A2A agents from scratch | @a2a-js/sdk directly |

## What's Next

ag2ag is experimental but functional. It's been validated with 6+ agents on a single VPS, including real composition patterns and concurrency stress testing.

If you're experimenting with the A2A protocol and want a lightweight way to run agents without container overhead, give it a try:

- **GitHub:** [Maretto/ag2ag](https://github.com/Maretto/ag2ag)
- **npm:** `npm install ag2ag`
- **License:** MIT

PRs, issues, and feedback welcome.

---

*Have you tried running A2A agents locally? What's your setup like? I'd love to hear about it in the comments.*
