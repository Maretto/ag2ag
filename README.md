# ag2ag

**Run A2A-compatible agents on a single host. Node.js + systemd. No Docker. No Kubernetes.**

> ⚠️ **Experimental.** Validated on a single-host setup (6+ agents, 1 VPS). Not production-ready. See [When to use](#when-to-use--when-not-to-use) and [SECURITY.md](SECURITY.md).

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

- **Registry** — local JSON file tracking all agents, ports, systemd units. Supports schema migration for future versions.
- **Lifecycle** — start, stop, restart agents via systemd with `--user` flag support
- **Discovery** — `GET /card` on each agent for A2A-compatible AgentCards
- **Messaging** — send messages between agents on localhost
- **Task persistence** — JSONL files survive restarts. Auto-cleanup of old tasks (configurable retention).
- **SSE Streaming** — `/task/:id/stream` for real-time task updates via Server-Sent Events
- **Rate limiting** — sliding window per agent (configurable via env vars)
- **Health & Metrics** — `/health` and `/metrics` endpoints for observability
- **Config module** — centralized configuration with environment variable overrides
- **Jules integration** — CLI command to interact with Google Jules API for code generation
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

# View logs with priority filter
ag2ag logs my-agent --priority err

# Clean old tasks
ag2ag clean --days 7

# Start web dashboard
ag2ag ui --port 8080
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
ag2ag logs <name>             journalctl for the agent (--lines N, --priority LEVEL)
ag2ag clean [--days N]        Clean tasks older than N days (default 7)
ag2ag ui [--port N]           Start local web dashboard
ag2ag jules <subcommand>      Interact with Jules API (create, status, approve, list, activities)
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

## Configuration

All configuration is centralized in `src/config.js` with environment variable overrides:

| Env Variable | Default | Description |
|---|---|---|
| `AG2AG_PORT` | 5001 | Default HTTP port |
| `AG2AG_BIND_HOST` | 127.0.0.1 | Network interface (keep localhost!) |
| `AG2AG_MAX_BODY_SIZE` | 1048576 (1MB) | Max request body size in bytes |
| `AG2AG_RATE_LIMIT_MAX` | 60 | Max tasks per agent per window |
| `AG2AG_RATE_LIMIT_WINDOW_MS` | 60000 (60s) | Rate limit sliding window |
| `AG2AG_CLEANUP_INTERVAL_MS` | 86400000 (24h) | Auto-cleanup interval |
| `AG2AG_CLEANUP_MAX_DAYS` | 7 | Days to retain completed tasks |
| `AG2AG_SSE_KEEPALIVE_MS` | 15000 (15s) | SSE heartbeat interval |

## Testing

```bash
npm test              # Run all tests
npm run test:unit     # Unit tests only
npm run test:concurrency  # Concurrency tests
```

Test suites: `cli`, `config`, `lifecycle`, `registry`, `server`, `task-store`, `concurrency`.

## Stack

| Component | Choice |
|---|---|
| HTTP | Node.js built-in `http` (no Express) |
| Process management | systemd |
| Registry | JSON file with schema migration |
| Task persistence | JSONL per agent, async Mutex for writes |
| Rate limiting | Sliding window (in-memory) |
| SSE | EventEmitter-based |
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
The `@a2a-js/sdk` provides protocol types and server helpers. ag2ag adds the operational layer on top: local registry, systemd lifecycle management, CLI, task persistence, rate limiting, SSE streaming, and single-host conventions.

**Can I run AI agents with this?**
Yes. Any agent that exposes an A2A-compatible HTTP interface works. The handler function receives messages and returns responses — you decide what the agent does (call an LLM, query a database, monitor services, etc).

**Does it work without systemd?**
Lifecycle commands (start/stop/restart) require systemd. But registry, discovery, messaging, and the HTTP server work independently.

**Is this secure?**
Not for production. All communication is localhost HTTP with no authentication. See [SECURITY.md](SECURITY.md) for known risks and mitigations.

**What Node.js version is required?**
Node.js 18+ (uses `fetch`, `crypto.randomUUID`). Tested on v22.

## Tested on

- Ubuntu 22.04 LTS, Node.js v22, Contabo VPS
- 6+ agents registered, A2A-discoverable services, composition agents
- Concurrency tested with parallel load (see `test/concurrency.test.js`)
- See [`docs/writeup.md`](docs/writeup.md) for the full experiment report

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE) for third-party attributions.
