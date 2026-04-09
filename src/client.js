#!/usr/bin/env node
'use strict';

// =============================================================================
// ag2ag — Client
// Call other agents on localhost via A2A REST
// =============================================================================

const http = require('http');

// Defaults — can be overridden via constructor options or env vars
const DEFAULTS = {
  requestTimeout: parseInt(process.env.AG2AG_REQUEST_TIMEOUT, 10) || 120_000,  // 2min per HTTP request
  pollTimeout:    parseInt(process.env.AG2AG_POLL_TIMEOUT, 10)    || 300_000,  // 5min waitForTask polling
  pollInterval:   parseInt(process.env.AG2AG_POLL_INTERVAL, 10)   || 1_000,    // 1s between polls
};

class AgentClient {
  constructor(options = {}) {
    this.timeout = options.timeout || DEFAULTS.requestTimeout;
  }

  async _request(port, method, path, body = null, timeoutOverride) {
    const timeout = timeoutOverride || this.timeout;
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json' },
        timeout,
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

  // Poll task until completed/failed/canceled/rejected or timeout
  // Checks HTTP status before trusting response body
  // Options: { timeout: ms, interval: ms }
  async waitForTask(port, taskId, options = {}) {
    const interval = options.interval || DEFAULTS.pollInterval;
    const timeout  = options.timeout  || DEFAULTS.pollTimeout;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const res = await this.getTask(port, taskId);

      if (res.status === 404) {
        // Task doesn't exist yet or was deleted — keep polling
      } else if (res.status >= 500) {
        throw new Error(`Server error ${res.status} while polling task ${taskId}`);
      } else if (res.status >= 400) {
        throw new Error(`Client error ${res.status} while polling task ${taskId}`);
      } else if (res.data?.status?.state) {
        const state = res.data.status.state;
        if (['completed', 'failed', 'canceled', 'rejected'].includes(state)) {
          return res.data;
        }
      }
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`Task ${taskId} did not complete within ${timeout}ms`);
  }
}

module.exports = { AgentClient, DEFAULTS };
