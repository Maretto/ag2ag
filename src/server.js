#!/usr/bin/env node
'use strict';

// =============================================================================
// ag2ag — Agent Server Wrapper
// Creates a lightweight HTTP server exposing A2A endpoints
// Uses Node http for transport, @a2a-js/sdk for spec types
// File-backed task persistence via TaskStore
// EventEmitter-based SSE (no polling)
// Rate limiting per agent (sliding window)
// /health and /metrics endpoints
// =============================================================================

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { TaskStore } = require('./task-store');
const config = require('./config');

class AgentServer {
  constructor(options) {
    this.agentCard = options.agentCard;
    this.agentName = options.agentName || options.agentCard?.name || 'unknown';
    this.port = options.port || config.DEFAULT_PORT;
    this.handler = options.handler || null;
    this.taskStore = new TaskStore({ storeDir: options.taskStoreDir });
    this.server = null;

    // Rate-limit configuration — prefer constructor options so callers (e.g. tests)
    // can override without mutating the shared config module.
    this._rateLimitMax = options.rateLimitMax != null ? options.rateLimitMax : config.RATE_LIMIT_MAX;
    this._rateLimitWindowMs = options.rateLimitWindowMs != null ? options.rateLimitWindowMs : config.RATE_LIMIT_WINDOW_MS;

    // EventEmitter for SSE — keyed by taskId
    this._emitter = new EventEmitter();
    this._emitter.setMaxListeners(0); // allow many SSE clients

    // Metrics counters (reset on restart)
    this._metrics = {
      tasksCreated: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksCanceled: 0,
      startTime: Date.now(),
    };

    // Rate limiting — sliding window per agent name
    // Map<agentName, number[]> — array of request timestamps within the current window
    this._rateBuckets = new Map();

    // SIGHUP reload
    this._onSigHup = () => {
      console.log(`[ag2ag:${this.agentName}] Received SIGHUP, hot-reloading config...`);
      // Update config reference without deleting require cache since config exports primitives
      // For simple primitives, we just re-read the environment overrides if any
      this._rateLimitMax = options.rateLimitMax != null ? options.rateLimitMax : (parseInt(process.env.AG2AG_RATE_LIMIT_MAX, 10) || 60);
      this._rateLimitWindowMs = options.rateLimitWindowMs != null ? options.rateLimitWindowMs : (parseInt(process.env.AG2AG_RATE_LIMIT_WINDOW_MS, 10) || 60000);

      // Restart cleanup with potentially new config
      this.taskStore.stopAutoCleanup();
      const maxDays = parseInt(process.env.AG2AG_CLEANUP_MAX_DAYS, 10) || 7;
      const intervalMs = parseInt(process.env.AG2AG_CLEANUP_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000;
      const maxTasks = parseInt(process.env.AG2AG_CLEANUP_MAX_TASKS, 10) || 1000;
      this.taskStore.startAutoCleanup([this.agentName], maxDays, intervalMs, maxTasks);
    };
  }

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  /**
   * Check whether `agentName` is within the rate limit.
   * Uses a sliding-window counter keyed to the agent name.
   * @returns {boolean} true if the request should be allowed
   */
  _checkRateLimit(agentName) {
    const now = Date.now();
    const cutoff = now - this._rateLimitWindowMs;

    // Use filter (O(n)) instead of repeated shift() (O(n²)) to evict expired entries
    const prev = this._rateBuckets.get(agentName) || [];
    const current = prev.filter(t => t >= cutoff);

    if (current.length >= this._rateLimitMax) {
      this._rateBuckets.set(agentName, current);
      return false; // over limit
    }

    current.push(now);
    this._rateBuckets.set(agentName, current);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    this.server = http.createServer(async (req, res) => {
      const startTime = Date.now();

      // Hook into response end to log
      res.on('finish', () => {
        const duration = Date.now() - startTime;
        console.log(`[ag2ag:${this.agentName}] ${req.method} ${req.url} ${res.statusCode} - ${duration}ms`);
      });

      await this._handleRequest(req, res);
    });

    // Start auto-cleanup for this agent's tasks
    this.taskStore.startAutoCleanup([this.agentName]);

    // Register SIGHUP listener
    process.on('SIGHUP', this._onSigHup);

    return new Promise((resolve, reject) => {
      // Force bind to 127.0.0.1 for security, honoring the single-host localhost-only design
      this.server.listen(this.port, config.BIND_HOST, () => {
        resolve({ port: this.port, agent: this.agentName });
      });
      this.server.on('error', reject);
    });
  }

  async stop() {
    process.removeListener('SIGHUP', this._onSigHup);
    this.taskStore.stopAutoCleanup();
    if (this.server) {
      return new Promise(resolve => this.server.close(resolve));
    }
  }

  // ---------------------------------------------------------------------------
  // Request routing
  // ---------------------------------------------------------------------------

  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);

    try {
      // GET /card — AgentCard
      if (req.method === 'GET' && url.pathname === '/card') {
        return this._json(res, 200, this.agentCard);
      }

      // GET /health — Health check
      if (req.method === 'GET' && url.pathname === '/health') {
        const mem = process.memoryUsage();
        const active = this.taskStore.count(this.agentName);

        // Mark as degraded if active tasks are incredibly high or RSS memory > 500MB
        const isDegraded = active > 5000 || mem.rss > 500 * 1024 * 1024;

        return this._json(res, isDegraded ? 207 : 200, {
          status: isDegraded ? 'degraded' : 'ok',
          agent: this.agentName,
          uptime: process.uptime(),
          version: config.VERSION,
          degraded: isDegraded,
          memory: {
            rss: mem.rss,
            heapTotal: mem.heapTotal,
            heapUsed: mem.heapUsed,
            external: mem.external,
          },
          tasks: {
            active: active,
            created: this._metrics.tasksCreated,
            completed: this._metrics.tasksCompleted,
            failed: this._metrics.tasksFailed,
            canceled: this._metrics.tasksCanceled,
          },
        });
      }

      // GET /metrics — Prometheus-compatible counters
      if (req.method === 'GET' && url.pathname === '/metrics') {
        return this._metrics_response(res);
      }

      // GET /task/:id — Get task
      const taskMatch = url.pathname.match(/^\/task\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && taskMatch) {
        const taskId = taskMatch[1];
        const task = this.taskStore.get(this.agentName, taskId);
        if (!task) return this._json(res, 404, { error: 'Task not found' });
        return this._json(res, 200, task);
      }

      // GET /task/:id/stream — SSE for task updates (EventEmitter-based)
      const streamMatch = url.pathname.match(/^\/task\/([a-zA-Z0-9_-]+)\/stream$/);
      if (req.method === 'GET' && streamMatch) {
        return this._handleSSE(req, res, streamMatch[1]);
      }

      // GET /tasks — List tasks
      if (req.method === 'GET' && url.pathname === '/tasks') {
        const state = url.searchParams.get('state') || undefined;
        const tasks = this.taskStore.list(this.agentName, { state });
        return this._json(res, 200, { tasks, count: tasks.length });
      }

      // DELETE /task/:id — Cancel task
      if (req.method === 'DELETE' && taskMatch) {
        const taskId = taskMatch[1];
        const task = this.taskStore.get(this.agentName, taskId);
        if (!task) return this._json(res, 404, { error: 'Task not found' });
        task.status.state = 'canceled';
        task.status.timestamp = new Date().toISOString();
        await this.taskStore.set(this.agentName, taskId, task);
        this._emitter.emit(`task:${taskId}`, task);
        this._metrics.tasksCanceled++;
        return this._json(res, 200, task);
      }

      // POST /task — Create task (SendMessage)
      // POST /call — Create task and wait for completion synchronously
      if (req.method === 'POST' && (url.pathname === '/task' || url.pathname === '/call')) {
        // Rate limiting
        if (!this._checkRateLimit(this.agentName)) {
          return this._json(res, 429, {
            error: 'Too many tasks — rate limit exceeded',
            retryAfterMs: this._rateLimitWindowMs,
          });
        }

        const body = await this._readBody(req, res);
        if (body === null) return; // already responded (413)

        let message;
        try {
          message = typeof body === 'string' ? JSON.parse(body) : body;
        } catch (e) {
          return this._json(res, 400, { error: 'Invalid JSON payload' });
        }

        // Basic validation: ensure it's an object, has 'role' and 'parts' or is at least a non-null object
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          return this._json(res, 400, { error: 'Payload must be a JSON object' });
        }
        if (!message.role || typeof message.role !== 'string') {
          return this._json(res, 400, { error: 'Validation Error: Missing or invalid "role" field' });
        }
        if (!Array.isArray(message.parts)) {
          return this._json(res, 400, { error: 'Validation Error: "parts" must be an array' });
        }

        const taskId = crypto.randomUUID();
        const task = {
          id: taskId,
          status: { state: 'submitted', timestamp: new Date().toISOString() },
          messages: [message],
          artifacts: [],
          metadata: {},
        };
        await this.taskStore.set(this.agentName, taskId, task);
        this._emitter.emit(`task:${taskId}`, task);
        this._metrics.tasksCreated++;

        if (url.pathname === '/call') {
          // Synchronous execution
          if (!this.handler) {
             return this._json(res, 500, { error: 'No handler configured for synchronous call' });
          }
          try {
            task.status.state = 'working';
            task.status.timestamp = new Date().toISOString();
            await this.taskStore.set(this.agentName, taskId, task);
            this._emitter.emit(`task:${taskId}`, task);

            const result = await this.handler(message, task);

            task.status.state = 'completed';
            task.status.timestamp = new Date().toISOString();
            if (result) task.artifacts.push(result);
            await this.taskStore.set(this.agentName, taskId, task);
            this._emitter.emit(`task:${taskId}`, task);
            this._metrics.tasksCompleted++;
            return this._json(res, 200, task);
          } catch (e) {
            task.status.state = 'failed';
            task.status.timestamp = new Date().toISOString();
            task.status.message = e.message;
            await this.taskStore.set(this.agentName, taskId, task);
            this._emitter.emit(`task:${taskId}`, task);
            this._metrics.tasksFailed++;
            return this._json(res, 500, task);
          }
        } else {
          // Asynchronous execution
          if (this.handler) {
            setImmediate(async () => {
              try {
                task.status.state = 'working';
                task.status.timestamp = new Date().toISOString();
                await this.taskStore.set(this.agentName, taskId, task);
                this._emitter.emit(`task:${taskId}`, task);

                const result = await this.handler(message, task);

                task.status.state = 'completed';
                task.status.timestamp = new Date().toISOString();
                if (result) task.artifacts.push(result);
                await this.taskStore.set(this.agentName, taskId, task);
                this._emitter.emit(`task:${taskId}`, task);
                this._metrics.tasksCompleted++;
              } catch (e) {
                task.status.state = 'failed';
                task.status.timestamp = new Date().toISOString();
                task.status.message = e.message;
                await this.taskStore.set(this.agentName, taskId, task);
                this._emitter.emit(`task:${taskId}`, task);
                this._metrics.tasksFailed++;
              }
            });
          }
          return this._json(res, 201, task);
        }
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (e) {
      this._json(res, 500, { error: e.message });
    }
  }

  // ---------------------------------------------------------------------------
  // SSE — EventEmitter-based (no polling)
  // ---------------------------------------------------------------------------

  _handleSSE(req, res, taskId) {
    const task = this.taskStore.get(this.agentName, taskId);
    if (!task) return this._json(res, 404, { error: 'Task not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send current state immediately
    res.write(`data: ${JSON.stringify({ type: 'status', task })}\n\n`);

    // If already in a terminal state, close immediately
    const TERMINAL = ['completed', 'failed', 'canceled', 'rejected'];
    if (TERMINAL.includes(task.status.state)) {
      res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
      return res.end();
    }

    // Keep-alive heartbeat so proxies don't close idle connections.
    // Uses the SSE comment syntax (': ...') which clients must ignore per spec.
    const keepAlive = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, config.SSE_KEEPALIVE_MS);

    const onUpdate = (updatedTask) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ type: 'status', task: updatedTask })}\n\n`);
      if (TERMINAL.includes(updatedTask.status.state)) {
        res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
        cleanup();
        res.end();
      }
    };

    const cleanup = () => {
      clearInterval(keepAlive);
      this._emitter.off(`task:${taskId}`, onUpdate);
    };

    this._emitter.on(`task:${taskId}`, onUpdate);
    req.on('close', cleanup);
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  _metrics_response(res) {
    const m = this._metrics;
    const uptime = ((Date.now() - m.startTime) / 1000).toFixed(1);
    const active = this.taskStore.count(this.agentName);

    const lines = [
      `# HELP ag2ag_tasks_created_total Total tasks received`,
      `# TYPE ag2ag_tasks_created_total counter`,
      `ag2ag_tasks_created_total{agent="${this.agentName}"} ${m.tasksCreated}`,
      `# HELP ag2ag_tasks_completed_total Tasks finished successfully`,
      `# TYPE ag2ag_tasks_completed_total counter`,
      `ag2ag_tasks_completed_total{agent="${this.agentName}"} ${m.tasksCompleted}`,
      `# HELP ag2ag_tasks_failed_total Tasks that ended in failure`,
      `# TYPE ag2ag_tasks_failed_total counter`,
      `ag2ag_tasks_failed_total{agent="${this.agentName}"} ${m.tasksFailed}`,
      `# HELP ag2ag_tasks_canceled_total Tasks that were canceled`,
      `# TYPE ag2ag_tasks_canceled_total counter`,
      `ag2ag_tasks_canceled_total{agent="${this.agentName}"} ${m.tasksCanceled}`,
      `# HELP ag2ag_tasks_active Current tasks in store`,
      `# TYPE ag2ag_tasks_active gauge`,
      `ag2ag_tasks_active{agent="${this.agentName}"} ${active}`,
      `# HELP ag2ag_uptime_seconds Seconds since server start`,
      `# TYPE ag2ag_uptime_seconds gauge`,
      `ag2ag_uptime_seconds{agent="${this.agentName}"} ${uptime}`,
    ];

    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(lines.join('\n') + '\n');
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  _readBody(req, res) {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      let overflowed = false;
      req.on('data', chunk => {
        if (overflowed) return; // discard data after overflow
        size += chunk.length;
        if (size > config.MAX_BODY_SIZE) {
          overflowed = true;
          this._json(res, 413, { error: `Payload too large (max ${config.MAX_BODY_SIZE} bytes)` });
          resolve(null);
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (overflowed) return;
        try { resolve(body ? JSON.parse(body) : {}); }
        catch (e) { resolve(body); }
      });
      req.on('error', reject);
    });
  }
}

module.exports = { AgentServer };
