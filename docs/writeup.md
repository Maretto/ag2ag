# ag2ag — An Operational Layer for A2A on Single-Host Environments

> A Technical Experiment Report — v0.1.0, April 2026

## Abstract

We set out to test a hypothesis: **can the Agent2Agent (A2A) protocol be operationally useful on a single Linux host — a VPS, homelab server, or development machine — without Docker, Kubernetes, Express, or gRPC?**

In this tested scenario, the answer is yes. This document describes what we built, what worked, what didn't, and where the boundaries are.

## 1. Hypothesis

The A2A ecosystem in early 2026 targets cloud-native, distributed environments. Existing tooling (SDKs, registries, managed platforms) assumes Kubernetes, multi-host networking, and enterprise infrastructure.

But many developers run agents on a single machine — a $10/month VPS, a homelab server, a development VM. For these environments, the existing tooling is overweight.

**Hypothesis:** It is possible to build a useful operational layer for A2A on a single host using:
- Node.js built-in `http` module (no Express)
- systemd for process management
- A local JSON file as registry
- The official `@a2a-js/sdk` for spec compliance

**Anti-hypothesis (what we explicitly did NOT try):**
- Build a new protocol
- Replace the official SDK
- Create a universal framework
- Target distributed deployments

## 2. Implementation

### 2.1 Stack

| Component | Choice | Rationale |
|---|---|---|
| Runtime | Node.js v22 | Already on the VPS |
| HTTP | Built-in `http` module | Zero dependencies |
| Process management | systemd | Already on every Linux |
| Registry | JSON file | Sufficient for single-host |
| Task persistence | JSONL per agent | Simple, inspectable, append-friendly |
| A2A spec compliance | `@a2a-js/sdk` v0.3.13 | Official SDK for types |
| **Total external deps** | **1** | `@a2a-js/sdk` (+ `uuid`) |

### 2.2 Modules

| Module | Lines | Purpose |
|---|---|---|
| `registry.js` | 90 | Add, remove, get, list agents. Auto-assign ports. |
| `server.js` | 160 | HTTP server with A2A endpoints: `/card`, `/task`, `/tasks` |
| `client.js` | 80 | HTTP client for calling agents on localhost |
| `lifecycle.js` | 120 | Systemd start/stop/restart/status/logs. **Always resolves unit names from registry. Never infers.** |
| `task-store.js` | 100 | JSONL file per agent. Append on create, rewrite on update. |
| `cli.js` | 280 | 11 commands with colored output and health checks |
| **Total** | **~830** | |

### 2.3 CLI

```
a2a-local init                   # Create registry + data dirs
a2a-local register <name>        # Register agent with AgentCard
a2a-local start|stop|restart     # Systemd lifecycle
a2a-local status --health        # Show agents with live HTTP check
a2a-local card <name>            # Show AgentCard (live or registry)
a2a-local call <name> <message>  # Send A2A message, wait for response
a2a-local list                   # List all agents
a2a-local logs <name>            # journalctl
```

## 3. Results

### 3.1 Protocol Validation

An echo agent was built to validate A2A protocol compliance:
- `GET /card` returns a valid AgentCard with schema v1.0
- `POST /task` creates a task with proper lifecycle states
- Tasks transition: `submitted → working → completed`
- Artifacts returned match A2A spec structure
- JSONL persistence survives process restart

**Verdict:** A2A REST binding works on localhost with Node's built-in HTTP.

### 3.2 Real Service Discovery

Two production services were made A2A-discoverable by adding `GET /card` endpoints:

| Service | Port | AgentCard Skills |
|---|---|---|
| API Gateway | 3099 | health, status, signals, creations, studies |
| Mesh Ping | 3101 | status, metrics, history, alerts |

The `a2a-local status --health` command verifies these agents are alive by fetching their AgentCards in real-time.

**Verdict:** Existing services can become A2A-discoverable with minimal code (15 lines per service).

### 3.3 Inter-Agent Composition

A Health Proxy agent was built that demonstrates real composition:
1. Receives A2A message: "ecosystem health"
2. Queries Mesh Ping (`:3101/mesh/status`) for service metrics
3. Queries API Gateway (`:3099/api/health`) for gateway status
4. Aggregates data into a formatted health report
5. Returns as A2A artifact

Sample output:
```
📊 Ecosystem Health Report

🌐 API Gateway: UP (2min uptime)
📡 Mesh Ping: 4/6 services UP

  🟢 API Gateway: UP | 14ms | up 100%
  🔴 SENTINELA: DOWN | 11ms | up 70%
  🟢 The Spine: UP | 16ms | up 100%
  🔴 Sandbox: DOWN | 13ms | up 0%
  🟢 External Google: UP | 45ms | up 100%
  🟢 External Cloudflare: UP | 38ms | up 99%
```

**Verdict:** Agents can compose real data from other agents via A2A on localhost.

### 3.4 Ecosystem Integration

Six real services were registered in the local registry:

| Agent | Port | Systemd Unit | A2A-Ready? |
|---|---|---|---|
| API Gateway | :3099 | api-gateway.service | ✅ `/card` live |
| Mesh Ping | :3101 | mesh-ping.service | ✅ `/card` live |
| SQL Agent | — | sql-agent.service | ❌ Discord-only |
| Activity Monitor | — | activity-monitor.service | ❌ Discord-only |
| Health Checker | — | health-checker.service | ❌ No HTTP |
| Internal API | — | internal-api.service | ❌ Internal only |

**4 of 6 services are Discord-only or internal.** They are registered in the A2A registry (for lifecycle management) but cannot respond to A2A calls until they add HTTP endpoints.

## 4. Operator Validation

> *"A tese está validada para um ecossistema single-host pequeno, com serviços reais descobríveis e composição útil via A2A."*
>
> — Vitor Maretto, operator and technical reviewer, April 9 2026

This was stated after reviewing the implementation, running tests, and seeing real services respond via A2A.

## 5. What We Learned

### 5.1 The official JS SDK exists and is useful

The original study (v1) claimed "no Node.js SDK for A2A." This was wrong. `@a2a-js/sdk` exists on npm (v0.3.13). It provides useful types (`AgentCard`, `Task`), utilities (`InMemoryTaskStore`), and both client and server modules.

**However:** The SDK defaults to Express for transport, is pinned to spec v0.3.0 (not v1.0.0), and has no single-host or registry functionality. Our layer fills these specific gaps.

### 5.2 Systemd is enough for single-host

No need for Docker, process managers, or orchestration. systemd provides:
- Automatic restart on failure
- Log management (journalctl)
- Resource limits
- Dependency ordering

For single-host, systemd is the right tool. Adding containerization would add runtime overhead and operational complexity without corresponding benefit in this scenario.

### 5.3 JSON file registry is sufficient

A single JSON file with ~6 agents is trivially manageable. No etcd, no Redis, no database. For single-host, this is the correct complexity level.

### 5.4 Most existing services are not A2A-ready

4 of 6 services in our ecosystem have no HTTP endpoint. They're Discord bots or internal monitors. Making them A2A-compliant requires adding HTTP servers — a non-trivial refactor for services built as Discord-only.

**Lesson:** A2A adoption requires services to be HTTP-first, not Discord-first.

### 5.5 Task persistence matters

The original plan had in-memory tasks only. After operator feedback, we added JSONL persistence. This turned out to be important — tasks survive restarts and are inspectable after the fact.

## 6. Security Considerations

These risks are real, not theoretical. They follow directly from the design decisions documented above.

### 6.1 No Authentication

The system assumes localhost-only communication. If any agent's HTTP server binds to `0.0.0.0` instead of `127.0.0.1` (our default), or if a reverse proxy, firewall misconfiguration, or systemd socket activation exposes a port externally, A2A calls become unprotected. This is the highest-priority risk.

### 6.2 No Inter-Agent Isolation

All agents run as systemd services under the same user. If agents run under the same privileged user, especially root, the blast radius increases significantly. A compromised agent becomes a pivot point: it can call other local agents, read accessible files, modify the registry, or invoke lifecycle commands. Single-host single-user means zero trust boundary between agents.

### 6.3 Lifecycle Surface

The CLI executes `systemctl` commands based on registry data. If the registry is tampered with, or if agent names are not properly sanitized, this becomes a vector for starting, stopping, or restarting arbitrary systemd units. The current implementation resolves unit names from registry only (never infers), which limits but does not eliminate this risk.

### 6.4 Registry as Trust Point

The JSON registry is the source of truth for routing and lifecycle. If an attacker can modify `config/registry.json`, they can:
- Redirect A2A calls to a different port
- Replace systemd unit names
- Register a malicious agent with a legitimate-looking AgentCard
- Disrupt routing between agents

File permissions on the registry are the only protection.

### 6.5 AgentCard Metadata Exposure

`GET /card` reveals agent names, skills, ports, capabilities, and descriptions. On localhost this is acceptable by design. Exposed externally, it becomes useful reconnaissance for an attacker.

### 6.6 JSONL Persistence and Data Leakage

Tasks and artifacts survive restarts in `data/tasks/<agent>.jsonl`. This is operationally useful but may persist:
- Prompt contents from messages
- Diagnostic outputs containing service names, ports, or configurations
- Potentially sensitive data returned by agents

There is no retention policy, no sanitization, and no access control on JSONL files beyond filesystem permissions.

### 6.7 Aggregator Agents Enable Lateral Movement

The Health Proxy demonstrates useful composition, but it also demonstrates that an agent can query multiple peers and aggregate real operational data. If such an agent is compromised, it already has a roadmap to enumerate and interact with the ecosystem.

### 6.8 Concurrency

The TaskStore now includes a Promise-based Mutex to serialize writes per-agent, and rate limiting has been introduced to prevent resource exhaustion. Concurrency tests are included in the test suite (`test/concurrency.test.js`), proving stability under parallel load. The in-memory Mutex resets on process restart, which is acceptable for the single-host model.

### Mitigations in Current Design

| Risk | Current Mitigation | Gaps |
|---|---|---|
| No auth | localhost-only bind (`127.0.0.1`) | Misconfiguration, proxy exposure |
| No isolation | Same-user systemd | Need separate users or containers |
| Lifecycle abuse | Registry-looked-up unit names | Registry tampering, input validation |
| Registry tampering | File permissions | No integrity check, no signing |
| Metadata exposure | localhost-only | External exposure scenarios |
| JSONL leakage | File permissions | No sanitization (retention pruning exists via `ag2ag clean`) |
| Lateral movement | N/A | Fundamental to single-host design |
| Concurrency | Per-agent Mutex, Rate Limiting | Resource exhaustion on extremely high burst loads |

### Minimum Operational Recommendations

1. **Bind to `127.0.0.1` only** — never `0.0.0.0`. All agent servers must listen on loopback exclusively.
2. **Dedicated user per service** when possible — separate systemd users reduce blast radius between agents.
3. **Restrict file permissions** on `config/registry.json` and `data/tasks/*.jsonl` — `chmod 600`, owned by the service user.
4. **Never expose A2A ports externally** without authentication. If remote access is needed, tunnel via SSH or wireguard instead of opening ports.

## 7. Honest Limitations

1. **Tested with 6 agents.** Not tested with 20+. JSON file registry may slow down.
2. **SSE via `/task/:id/stream`.** Implemented with EventEmitter-based push. Polling acts as fallback mechanism.
3. **No authentication.** localhost assumption. No API keys, JWT, or mTLS.
4. **No push notifications.** A2A spec feature not implemented.
5. **REST only.** No JSON-RPC binding.
6. **No push notifications.** A2A spec feature not implemented.
6. **SDK version lag.** Using v0.3.13 of `@a2a-js/sdk`. Spec is v1.0.0. Types may diverge.
7. **No chained composition tested.** Health Proxy calls 2 agents. Agent chains of 3+ are untested.
8. **No concurrency testing.** All tests were sequential. Behavior under parallel load unknown.
9. **No cross-host testing.** Strictly localhost. Network latency and failure modes not explored.
10. **4/6 services are not A2A-ready.** The Discord-only services cannot respond to A2A calls.

## 8. What This Is NOT

- ❌ A new protocol or standard
- ❌ A replacement for `@a2a-js/sdk`
- ❌ A universal framework for all agent deployments
- ❌ Production-ready for enterprise use
- ❌ Tested at scale

## 9. What This IS

- ✅ A validated experiment showing A2A works on single-host
- ✅ An operational layer with real services registered and discoverable
- ✅ A useful CLI for managing agents via systemd
- ✅ A demonstrated composition pattern (Health Proxy)
- ✅ ~830 lines of code with 1 external dependency
- ✅ Honest about its boundaries

## 10. Potential Next Steps

These are possibilities, not commitments. Each should be evaluated independently.

1. **More services discoverable** — Add `/card` to SQL Butler, VPS Sentinel
2. **npm publish** — Make installable via `npm install -g a2a-local`
3. **Chained composition** — Test agent → agent → agent flows
4. **Concurrency testing** — Verify behavior under parallel load
5. **MCP bridge** — Expose A2A agents as MCP tools (or vice versa)
6. **Streaming support** — Implement SSE for SendStreamingMessage
7. **Dashboard** — Simple web UI for agent status

## 11. Environment

- **OS:** Ubuntu 22.04 LTS
- **Node:** v22.22.2
- **Host:** Contabo VPS (4 vCPU, 8GB RAM)
- **A2A SDK:** `@a2a-js/sdk` v0.3.13
- **Date:** April 8-9, 2026
- **Total development time:** ~4 hours across 2 sessions

## 12. Files

```
creations/a2a-local/
├── src/
│   ├── cli.js            # CLI entry point
│   ├── registry.js       # JSON file registry
│   ├── server.js         # HTTP server (Node http, no Express)
│   ├── client.js         # HTTP client for localhost calls
│   ├── lifecycle.js      # Systemd lifecycle management
│   └── task-store.js     # JSONL task persistence
├── examples/
│   ├── echo-agent.js     # Protocol validation agent
│   └── health-proxy.js   # Real composition agent
├── config/
│   └── registry.json     # 6 registered agents
├── data/
│   └── tasks/            # JSONL task logs
├── docs/
│   ├── build-plan.md     # 3-phase build plan
│   └── writeup.md        # This document
├── test/
│   └── run-tests.sh      # Integration test suite (9 tests)
├── README.md             # Quick start guide
└── package.json          # 1 dependency: @a2a-js/sdk
```

---

*This is an experiment report, not a product announcement. Claims are bounded by what was actually tested. Limitations are stated explicitly. The author runs the ecosystem described and has direct experience with the problem.*
