# a2a-local — Build Plan

## Overview

Build an operational layer for running A2A-compliant agents on a single Linux host. Uses `@a2a-js/sdk` for spec compliance, adds systemd lifecycle, local registry, and CLI tooling.

## Phases

### Phase 1: Foundation (Day 1)
**Goal:** Minimal working system — register agents, serve AgentCards, send messages.

#### 1.1 Project Setup
- `npm init` with `@a2a-js/sdk` as dependency
- File structure:
  ```
  a2a-local/
  ├── src/
  │   ├── cli.js          # CLI entry point
  │   ├── registry.js     # JSON registry manager
  │   ├── server.js       # AgentCard + A2A REST server wrapper
  │   ├── lifecycle.js    # Systemd service management
  │   └── client.js       # Call other agents (A2A client)
  ├── config/
  │   └── registry.json   # Agent registry (created on init)
  ├── docs/
  │   └── writeup.md      # Technical writeup
  ├── examples/
  │   └── example-agent.js
  ├── README.md
  └── package.json
  ```

#### 1.2 Registry (`registry.js`)
- JSON file at `config/registry.json`
- Schema:
  ```json
  {
    "agents": [
      {
        "name": "diagnosticador",
        "port": 3102,
        "systemdUnit": "daemonlab-diagnosticador",
        "card": { /* full AgentCard */ },
        "registeredAt": "ISO date"
      }
    ]
  }
  ```
- Operations: `add()`, `remove()`, `get(name)`, `list()`, `findByPort()`

#### 1.3 Server Wrapper (`server.js`)
- Wraps `@a2a-js/sdk` server functionality
- Creates HTTP server on specified port (Node `http`, no Express)
- Endpoints:
  - `GET /card` → returns AgentCard
  - `POST /task` → SendMessage (A2A)
  - `GET /task/:id` → GetTask
  - `GET /tasks` → ListTasks
  - `DELETE /task/:id` → CancelTask
- In-memory task store (no persistence needed for MVP)
- Each agent gets its own server instance

#### 1.4 CLI (`cli.js`)
- Parse commands: `init`, `register`, `start`, `stop`, `status`, `call`, `card`, `list`, `logs`
- `init`: create registry file + directories
- `register`: add agent to registry, validate AgentCard
- `start/stop`: delegate to `lifecycle.js`
- `status`: check all agents' health (GET /card for each)
- `call`: send message to agent via client
- `card`: pretty-print agent card
- `list`: show all registered agents
- `logs`: `journalctl -u <unit> --no-pager -n 50`

#### 1.5 Lifecycle (`lifecycle.js`)
- `start(name)`: `systemctl start <unit>`
- `stop(name)`: `systemctl stop <unit>`
- `isActive(name)`: `systemctl is-active <unit>`
- `getLogs(name, lines)`: `journalctl -u <unit> --no-pager -n <lines>`

#### 1.6 Client (`client.js`)
- `sendMessage(agentName, message)`: POST /task to localhost:port
- `getTask(agentName, taskId)`: GET /task/:id
- `listTasks(agentName)`: GET /tasks
- `getCard(agentName)`: GET /card
- Pure HTTP calls, no SDK dependency on client side

#### 1.7 Example Agent
- Simple echo agent that receives messages and responds
- Demonstrates how to wrap existing logic in A2A server

### Phase 2: Integration (Day 2)
**Goal:** Register real ecosystem agents, test inter-agent communication.

#### 2.1 Register Existing Services
- Create AgentCards for: Diagnosticador, Mesh Ping, SQL Butler, VPS Sentinel
- Each gets A2A endpoints added (or proxied via existing HTTP servers)
- Register all in registry.json

#### 2.2 Inter-Agent Communication Test
- Diagnosticador → Mesh Ping: "check health of agent X"
- SQL Butler → Diagnosticador: "is service Y running?"
- Mesh Ping → all agents: periodic GET /card for liveness

#### 2.3 Integration with Lab Watcher
- Lab Watcher reads registry.json for service list
- Reports A2A compliance status alongside systemd status

### Phase 3: Polish + Writeup (Day 3)
**Goal:** npm package, documentation, technical writeup.

#### 3.1 Package Polish
- Proper `package.json` with bin entry for CLI
- `npm link` for global access
- Help text for each command
- Error handling and validation

#### 3.2 Technical Writeup
- `docs/writeup.md` — see separate writeup plan below
- Covers: motivation, architecture, comparison with alternatives, limitations

#### 3.3 Examples
- Echo agent (simple)
- Bridge agent (receives A2A → calls external API)
- Orchestrator agent (receives task → delegates to other agents)

## Dependencies

| Package | Purpose | Required? |
|---|---|---|
| `@a2a-js/sdk` | A2A spec compliance (AgentCard, Task types) | Yes |
| Node `http` | HTTP server (no Express) | Built-in |
| Node `child_process` | systemctl calls | Built-in |
| Node `fs` | Registry file read/write | Built-in |

**Zero external deps beyond `@a2a-js/sdk`.**

## Testing Strategy

1. **Unit tests:** Registry operations (add, remove, list, get)
2. **Integration tests:** Start server → send message → get task → verify response
3. **E2E test:** Register → start → call → status → stop
4. **Real-world test:** Register Diagnosticador, call from another agent

## Risks

| Risk | Mitigation |
|---|---|
| `@a2a-js/sdk` v0.3.0 incompatible with our needs | Use only AgentCard + Task types, implement REST binding ourselves |
| Express peer dep pulls heavy tree | Use only type definitions from SDK, implement server with Node http |
| SDK API changes between v0.3.0 and v1.0.0 | Pin version, isolate SDK usage behind wrapper |

## Timeline

| Phase | Duration | Deliverable |
|---|---|---|
| Phase 1 | 1 day | Working CLI + registry + server wrapper |
| Phase 2 | 1 day | Real agents registered + inter-agent calls |
| Phase 3 | 1 day | npm package + writeup + examples |
| **Total** | **3 days** | Production-ready a2a-local |

---

_Created by the Daemon of Creation — 2026-04-08_
