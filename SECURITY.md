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

Tasks and artifacts survive restarts in `data/tasks/*.jsonl`. May persist prompt contents, diagnostic outputs, or other sensitive data. A retention policy exists (`ag2ag clean --days N`, default 7 days) but no automatic sanitization of sensitive content within retained tasks.

### Aggregator Agents Enable Lateral Movement

Agents like Health Proxy query multiple peers and aggregate real operational data. A compromised aggregator already has a roadmap to enumerate and interact with the ecosystem.

### Concurrency Under Load

The TaskStore uses a Promise-based Mutex to serialize writes per-agent, and a sliding-window rate limiter prevents burst overload. Concurrency tests (`test/concurrency.test.js`) validate stability under parallel load. The in-memory Mutex resets on process restart — acceptable for single-host but means a crash during a write could leave a partial JSONL line. Rate limiting is per-agent only; coordinated burst across multiple agents is not limited.

### Rate Limiting Bypass

Rate limiting is per-agent and in-memory (resets on restart). An attacker with local access can bypass it by sending requests faster than the configured window or by restarting the agent process. The rate limiter protects against accidental overload, not adversarial abuse.

### Body Size Limit

A 1MB body limit (`AG2AG_MAX_BODY_SIZE`) prevents oversized payloads but does not validate content structure. Malformed JSON within the limit still reaches the handler.

## Minimum Operational Recommendations

1. **Bind to `127.0.0.1` only** — never `0.0.0.0`
2. **Dedicated user per service** when possible — separate systemd users reduce blast radius
3. **Restrict file permissions** on `config/registry.json` and `data/tasks/*.jsonl` — `chmod 600`, owned by service user
4. **Never expose A2A ports externally** without authentication. Use SSH or WireGuard tunneling instead
5. **Configure rate limits** via `AG2AG_RATE_LIMIT_MAX` and `AG2AG_RATE_LIMIT_WINDOW_MS` to match your expected load
6. **Run `ag2ag clean` regularly** via cron to minimize data persistence exposure
7. **Use `--user` flag** on `ag2ag register` to isolate agent processes with dedicated systemd users

## Reporting

If you find a security issue, please open a GitHub Issue or contact the maintainer directly.
