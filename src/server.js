#!/usr/bin/env node
'use strict';

// =============================================================================
// ag2ag — Agent Server Wrapper
// Creates a lightweight HTTP server exposing A2A endpoints
// Uses Node http for transport, @a2a-js/sdk for spec types
// File-backed task persistence via TaskStore
// =============================================================================

const http = require('http');
const crypto = require('crypto');
const { TaskStore } = require('./task-store');

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

class AgentServer {
  constructor(options) {
    this.agentCard = options.agentCard;
    this.agentName = options.agentName || options.agentCard?.name || 'unknown';
    this.port = options.port || 5001;
    this.handler = options.handler || null;
    this.taskStore = new TaskStore({ storeDir: options.taskStoreDir });
    this.server = null;
  }

  async start() {
    this.server = http.createServer(async (req, res) => {
      await this._handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      // Force bind to 127.0.0.1 for security, honoring the single-host localhost-only design
      this.server.listen(this.port, '127.0.0.1', () => {
        resolve({ port: this.port, agent: this.agentName });
      });
      this.server.on('error', reject);
    });
  }

  async stop() {
    if (this.server) {
      return new Promise(resolve => this.server.close(resolve));
    }
  }

  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);

    try {
      // GET /card — AgentCard
      if (req.method === 'GET' && url.pathname === '/card') {
        return this._json(res, 200, this.agentCard);
      }

      // GET /task/:id — Get task
      const taskMatch = url.pathname.match(/^\/task\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'GET' && taskMatch) {
        const taskId = taskMatch[1];
        const task = this.taskStore.get(this.agentName, taskId);
        if (!task) return this._json(res, 404, { error: 'Task not found' });
        return this._json(res, 200, task);
      }
      
      // GET /task/:id/stream — SSE for task updates
      const streamMatch = url.pathname.match(/^\/task\/([a-zA-Z0-9_-]+)\/stream$/);
      if (req.method === 'GET' && streamMatch) {
        const taskId = streamMatch[1];
        const task = this.taskStore.get(this.agentName, taskId);
        if (!task) return this._json(res, 404, { error: 'Task not found' });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        
        // Initial state
        res.write(`data: ${JSON.stringify({ type: 'status', task })}\n\n`);

        if (['completed', 'failed', 'canceled', 'rejected'].includes(task.status.state)) {
            res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
            return res.end();
        }

        // Extremely simple polling loop to simulate SSE events (since taskStore is file backed)
        const interval = setInterval(() => {
          const currentTask = this.taskStore.get(this.agentName, taskId);
          if (!currentTask) {
             clearInterval(interval);
             return res.end();
          }
          res.write(`data: ${JSON.stringify({ type: 'status', task: currentTask })}\n\n`);
          if (['completed', 'failed', 'canceled', 'rejected'].includes(currentTask.status.state)) {
             clearInterval(interval);
             res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
             res.end();
          }
        }, 1000);
        
        req.on('close', () => clearInterval(interval));
        return;
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
        this.taskStore.set(this.agentName, taskId, task);
        return this._json(res, 200, task);
      }

      // POST /task — Create task (SendMessage)
      if (req.method === 'POST' && url.pathname === '/task') {
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
        this.taskStore.set(this.agentName, taskId, task);

        // Process asynchronously if handler is provided
        if (this.handler) {
          setImmediate(async () => {
            try {
              task.status.state = 'working';
              task.status.timestamp = new Date().toISOString();
              this.taskStore.set(this.agentName, taskId, task);

              const result = await this.handler(message, task);

              task.status.state = 'completed';
              task.status.timestamp = new Date().toISOString();
              if (result) task.artifacts.push(result);
              this.taskStore.set(this.agentName, taskId, task);
            } catch (e) {
              task.status.state = 'failed';
              task.status.timestamp = new Date().toISOString();
              task.status.message = e.message;
              this.taskStore.set(this.agentName, taskId, task);
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
        if (size > MAX_BODY_SIZE) {
          overflowed = true;
          this._json(res, 413, { error: 'Payload too large (max 1MB)' });
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
