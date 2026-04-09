#!/usr/bin/env node
'use strict';

// =============================================================================
// a2a-local — Client
// Call other agents on localhost via A2A REST
// =============================================================================

const http = require('http');

class AgentClient {
  constructor(options = {}) {
    this.timeout = options.timeout || 30000;
  }

  async _request(port, method, path, body = null) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json' },
        timeout: this.timeout,
      };

      const req = http.request(opts, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ status: res.statusCode, data });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async getCard(port) {
    return this._request(port, 'GET', '/card');
  }

  async sendMessage(port, message) {
    return this._request(port, 'POST', '/task', message);
  }

  async getTask(port, taskId) {
    return this._request(port, 'GET', `/task/${taskId}`);
  }

  async listTasks(port) {
    return this._request(port, 'GET', '/tasks');
  }

  async cancelTask(port, taskId) {
    return this._request(port, 'DELETE', `/task/${taskId}`);
  }

  // Poll task until completed/failed/canceled or timeout
  async waitForTask(port, taskId, options = {}) {
    const interval = options.interval || 1000;
    const timeout = options.timeout || 60000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const { data: task } = await this.getTask(port, taskId);
      if (['completed', 'failed', 'canceled', 'rejected'].includes(task.status?.state)) {
        return task;
      }
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`Task ${taskId} did not complete within ${timeout}ms`);
  }
}

module.exports = { AgentClient };
