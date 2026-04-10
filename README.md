# ag2ag

**Run A2A-compatible agents on a single host. Node.js + systemd. No Docker. No Kubernetes.**

> ⚠️ **Experimental.** Validated on a small single-host setup (6 agents, 1 VPS). Not production-ready. See [When to use](#when-to-use--when-not-to-use) and [SECURITY.md](SECURITY.md).

Runs on a VPS, homelab server, or dev VM. No Docker. No Kubernetes. Just Node.js + systemd.

Built on top of the official [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk).

> **Not affiliated with, endorsed by, or connected to the A2A Protocol project, Google, or the Linux Foundation.**

---

## When to use / When not to use

**Use ag2ag if:**
- You run agents on a single Linux host (VPS, homelab, dev VM)
- You want A2A discoverability without Docker or Kubernetes
- You need a lightweight CLI to manage agent lifecycle via systemd
- You're prototyping or experimenting with A2A locally
- You want agents to discover and call each other on localhost

**Do NOT use ag2ag if:**
- You need multi-host or distributed deployment
- You need authentication, encryption, or network-level security
- You're building a production system requiring isolation between agents

---

## What it does

- **Registry** — local JSON file tracking all agents, ports, systemd units
- **Lifecycle** — start, stop, restart agents via systemd
- **Discovery** — `GET /card` on each agent for A2A-compatible AgentCards
- **Messaging** — send messages between agents on localhost
- **Task persistence** — JSONL files survive restarts
- **CLI** — manage everything from the terminal

## Quick start

```bash
npm install -g ag2ag

# Initialize
ag2ag init

# Register an agent
ag2ag register my-agent --port 5001 --description "Does useful things"

# Start it
ag2ag start my-agent

# Check health
ag2ag status --health

# Get its AgentCard
ag2ag card my-agent

# Send a message
ag2ag call my-agent "hello"
```

## Real output

```
$ ag2ag status --health

 ag2ag — 3 agent(s)

 STAT NAME               PORT    UNIT                     HEALTH
 ●    api-gateway        :3099   api-gateway.service      responding
 ●    mesh-ping          :3101   mesh-ping.service        responding
 ●    echo-agent         :5000   echo-agent.service       responding
```

```
$ ag2ag call health-proxy "ecosystem health"

📊 Ecosystem Health Report

🌐 API Gateway: UP (2min uptime)
📡 Mesh Ping: 4/6 services UP

  🟢 API Gateway: UP | 14ms | up 100%
  🟢 Mesh Ping: UP | 8ms | up 100%
  🟢 Internal API: UP | 16ms | up 100%
  🔴 Sandbox: DOWN | 13ms | up 0%
```

## CLI commands

```
ag2ag init                    Create registry + data dirs
ag2ag register <name>         Register agent with AgentCard
ag2ag remove <name>           Remove from registry
ag2ag list                    List all agents
ag2ag start|stop|restart      Systemd lifecycle management
ag2ag status [--health]       Show agents (with live HTTP check)
ag2ag card <name>             Show AgentCard (live or from registry)
ag2ag call <name> <message>   Send A2A message, wait for response
ag2ag logs <name>             journalctl for the agent
```

## Building an agent

```javascript
const { AgentServer } = require('ag2ag');

const card = {
  schemaVersion: '1.0',
  name: 'my-agent',
  description: 'Does useful things',
  url: 'http://127.0.0.1:5001',
  capabilities: { streaming: false, pushNotifications: false },
  skills: [{ name: 'do-thing', description: 'Does a thing' }],
};

async function handleMessage(message, task) {
  return {
    parts: [{ type: 'text', text: 'Done!' }],
    source: 'my-agent',
    timestamp: new Date().toISOString(),
  };
}

const server = new AgentServer({
  agentCard: card,
  agentName: 'my-agent',
  port: 5001,
  handler: handleMessage,
});

server.start();
```

See `examples/` for complete agents:
- **echo-agent.js** — minimal A2A protocol validation
- **health-proxy.js** — real agent that queries other agents for ecosystem health

## Stack

| Component | Choice |
|---|---|
| HTTP | Node.js built-in `http` (no Express) |
| Process management | systemd |
| Registry | JSON file |
| Task persistence | JSONL per agent |
| A2A compliance | `@a2a-js/sdk` v0.3.13 |
| External dependencies | 1 |

## Alternatives

| Tool | Best for | ag2ag difference |
|---|---|---|
| **Docker Compose** | Multi-container apps with networking | ag2ag skips containers entirely — lighter for simple agents |
| **Kubernetes** | Large-scale distributed systems | ag2ag targets single-host — no cluster overhead |
| **Nomad** | Mixed workload orchestration | ag2ag is agent-specific with A2A discovery built-in |
| **PM2** | Node.js process management | ag2ag adds A2A protocol, discovery, and inter-agent messaging |
| **systemd raw** | Service management | ag2ag wraps systemd with registry, CLI, and A2A compliance |
| **A2A SDK alone** | Building A2A agents from scratch | ag2ag provides the operational layer (registry, lifecycle, persistence) |

## FAQ

**What is A2A?**
A2A (Agent-to-Agent) is an open protocol by the Linux Foundation for AI agent interoperability. It defines how agents discover each other's capabilities and collaborate. See [a2a-protocol.org](https://a2a-protocol.org).

**How is this different from the A2A SDK?**
The `@a2a-js/sdk` provides protocol types and server helpers. ag2ag adds the operational layer on top: local registry, systemd lifecycle management, CLI, task persistence, and single-host conventions.

**Can I run AI agents with this?**
Yes. Any agent that exposes an A2A-compatible HTTP interface works. The handler function receives messages and returns responses — you decide what the agent does (call an LLM, query a database, monitor services, etc).

**Does it work without systemd?**
Lifecycle commands (start/stop/restart) require systemd. But registry, discovery, messaging, and the HTTP server work independently.

**Is this secure?**
Not for production. All communication is localhost HTTP with no authentication. See [SECURITY.md](SECURITY.md) for known risks and mitigations.

**How do I run AI agents locally?**
Install ag2ag, register your agents with their ports, start them. They discover each other via AgentCards and communicate via A2A messages on localhost.

**What Node.js version is required?**
Node.js 18+ (uses `fetch`, `crypto.randomUUID`). Tested on v22.

## Tested on

- Ubuntu 22.04 LTS, Node.js v22, Contabo VPS
- 6 agents registered, 2 A2A-discoverable services, 1 composition agent
- See [`docs/writeup.md`](docs/writeup.md) for the full experiment report

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE) for third-party attributions.
