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
    // Map<agentName, number[]> — array of request timestamps
    this._rateBuckets = new Map();
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
    const window = config.RATE_LIMIT_WINDOW_MS;
    const max = config.RATE_LIMIT_MAX;

    if (!this._rateBuckets.has(agentName)) {
      this._rateBuckets.set(agentName, []);
    }

    const timestamps = this._rateBuckets.get(agentName);
    // Drop timestamps outside the current window
    const cutoff = now - window;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= max) {
      return false; // over limit
    }

    timestamps.push(now);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    this.server = http.createServer(async (req, res) => {
      await this._handleRequest(req, res);
    });

    // Start auto-cleanup for this agent's tasks
    this.taskStore.startAutoCleanup([this.agentName]);

    return new Promise((resolve, reject) => {
      // Force bind to 127.0.0.1 for security, honoring the single-host localhost-only design
      this.server.listen(this.port, config.BIND_HOST, () => {
        resolve({ port: this.port, agent: this.agentName });
      });
      this.server.on('error', reject);
    });
  }

  async stop() {
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
        return this._json(res, 200, {
          status: 'ok',
          agent: this.agentName,
          uptime: process.uptime(),
          version: config.VERSION,
          tasks: {
            active: this.taskStore.count(this.agentName),
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
      if (req.method === 'POST' && url.pathname === '/task') {
        // Rate limiting
        if (!this._checkRateLimit(this.agentName)) {
          return this._json(res, 429, {
            error: 'Too many tasks — rate limit exceeded',
            retryAfterMs: config.RATE_LIMIT_WINDOW_MS,
          });
        }

        const body = await this._readBody(req, res);
        if (body === null) return; // already responded (413)
        const message = typeof body === 'string' ? JSON.parse(body) : body;

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

        // Process asynchronously if handler is provided
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

    // Keep-alive heartbeat so proxies don't close idle connections
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
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
