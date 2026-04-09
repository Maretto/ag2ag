# Security Policy

## Status

**Experimental.** This project has not undergone a formal security audit.

## Known Risks

### No Authentication

All agent communication assumes localhost (`127.0.0.1`). If any agent binds to `0.0.0.0` or ports are exposed externally (via reverse proxy, firewall misconfiguration, or systemd socket activation), A2A calls become unprotected.

### No Inter-Agent Isolation

Agents run as systemd services under the same user. If agents run under the same privileged user, especially root, the blast radius increases significantly. A compromised agent can call other local agents, read accessible files, or modify the registry.

### Lifecycle Surface

The CLI executes `systemctl` commands based on registry data. The registry is a JSON file — if tampered with, it could direct lifecycle commands to arbitrary systemd units.

### Registry as Trust Point

The JSON registry (`config/registry.json`) is the source of truth for routing and lifecycle. File permissions are the only protection. An attacker with write access can redirect calls, replace unit names, or register malicious agents.

### AgentCard Metadata Exposure

`GET /card` reveals agent names, skills, ports, and capabilities. Acceptable on localhost; useful reconnaissance if exposed externally.

### JSONL Data Persistence

Tasks and artifacts survive restarts in `data/tasks/*.jsonl`. May persist prompt contents, diagnostic outputs, or other sensitive data. No retention policy or sanitization.

### Aggregator Agents Enable Lateral Movement

Agents like Health Proxy query multiple peers and aggregate real operational data. A compromised aggregator already has a roadmap to enumerate and interact with the ecosystem.

### Untested Under Concurrency

No concurrency testing performed. Potential for JSONL corruption, registry race conditions, or unpredictable behavior under parallel load.

## Minimum Operational Recommendations

1. **Bind to `127.0.0.1` only** — never `0.0.0.0`
2. **Dedicated user per service** when possible — separate systemd users reduce blast radius
3. **Restrict file permissions** on `config/registry.json` and `data/tasks/*.jsonl` — `chmod 600`, owned by service user
4. **Never expose A2A ports externally** without authentication. Use SSH or WireGuard tunneling instead

## Reporting

If you find a security issue, please open a GitHub Issue or contact the maintainer directly.
