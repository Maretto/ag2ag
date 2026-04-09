#!/usr/bin/env node
'use strict';

// =============================================================================
// a2a-local — Agent Server Wrapper
// Creates a lightweight HTTP server exposing A2A endpoints
// Uses @a2a-js/sdk for spec types, Node http for transport
// File-backed task persistence via TaskStore
// =============================================================================

const http = require('http');
const { InMemoryTaskStore: SDKTaskStore, DefaultRequestHandler } = require('@a2a-js/sdk/server');
const { TaskStore } = require('./task-store');

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

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

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
        const body = await this._readBody(req);
        const message = typeof body === 'string' ? JSON.parse(body) : body;

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch (e) { resolve(body); }
      });
      req.on('error', reject);
    });
  }
}

module.exports = { AgentServer };
