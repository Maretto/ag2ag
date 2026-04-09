# ag2ag

**An operational layer for A2A-compatible agents on single-host environments.**

Runs on a VPS, homelab server, or dev VM. No Docker. No Kubernetes. Just Node.js + systemd.

Built on top of the official [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk).

> **Not affiliated with, endorsed by, or connected to the A2A Protocol project, Google, or the Linux Foundation.**

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
const { AgentServer } = require('ag2ag/src/server');

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

## Tested on

- Ubuntu 22.04 LTS, Node.js v22, Contabo VPS
- 6 agents registered, 2 A2A-discoverable services, 1 composition agent
- See [`docs/writeup.md`](docs/writeup.md) for the full experiment report

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE) for third-party attributions.
