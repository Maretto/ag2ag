#!/usr/bin/env node
'use strict';

// =============================================================================
// Unit tests — AgentServer
// Starts a real HTTP server on a random port for each test group.
// Uses Node.js built-in test runner (node:test, available since Node 18)
// =============================================================================

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentServer } = require('../../src/server');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ag2ag-srv-test-'));
}

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function makeAgentCard(name, port) {
  return {
    schemaVersion: '1.0',
    name,
    description: 'Test agent',
    url: `http://127.0.0.1:${port}`,
    capabilities: { streaming: false, pushNotifications: false },
    skills: [{ name: 'test', description: 'Test skill' }],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentServer', () => {
  let server;
  let port;

  before(async () => {
    port = 15050 + Math.floor(Math.random() * 100);
    server = new AgentServer({
      agentCard: makeAgentCard('test-agent', port),
      agentName: 'test-agent',
      port,
      taskStoreDir: tmpDir(),
      handler: async (message) => {
        const text = message?.parts?.[0]?.text || '';
        return { parts: [{ type: 'text', text: `Echo: ${text}` }] };
      },
    });
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  describe('GET /card', () => {
    test('returns the agent card', async () => {
      const { status, data } = await request(port, 'GET', '/card');
      assert.equal(status, 200);
      assert.equal(data.name, 'test-agent');
    });
  });

  describe('GET /health', () => {
    test('returns status ok', async () => {
      const { status, data } = await request(port, 'GET', '/health');
      assert.equal(status, 200);
      assert.equal(data.status, 'ok');
      assert.equal(data.agent, 'test-agent');
      assert.ok(typeof data.uptime === 'number');
      assert.ok(typeof data.version === 'string');
    });
  });

  describe('GET /metrics', () => {
    test('returns Prometheus-formatted metrics', async () => {
      const opts = { hostname: '127.0.0.1', port, path: '/metrics', method: 'GET' };
      const body = await new Promise((resolve, reject) => {
        const req = http.request(opts, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(d));
        });
        req.on('error', reject);
        req.end();
      });
      assert.ok(body.includes('ag2ag_tasks_created_total'));
      assert.ok(body.includes('ag2ag_uptime_seconds'));
    });
  });

  describe('POST /task + GET /task/:id', () => {
    test('creates a task and retrieves it', async () => {
      const { status: postStatus, data: task } = await request(port, 'POST', '/task', {
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      });
      assert.equal(postStatus, 201);
      assert.ok(task.id);
      assert.equal(task.status.state, 'submitted');

      const { status: getStatus, data: fetched } = await request(port, 'GET', `/task/${task.id}`);
      assert.equal(getStatus, 200);
      assert.equal(fetched.id, task.id);
    });

    test('returns 404 for unknown task', async () => {
      const { status } = await request(port, 'GET', '/task/does-not-exist');
      assert.equal(status, 404);
    });
  });

  describe('GET /tasks', () => {
    test('lists tasks', async () => {
      const { data } = await request(port, 'GET', '/tasks');
      assert.ok(Array.isArray(data.tasks));
      assert.ok(typeof data.count === 'number');
    });
  });

  describe('DELETE /task/:id', () => {
    test('cancels a task', async () => {
      const { data: task } = await request(port, 'POST', '/task', {
        role: 'user',
        parts: [{ type: 'text', text: 'cancel me' }],
      });
      // Wait a moment so the task is persisted
      await new Promise(r => setTimeout(r, 50));
      const { status, data: canceled } = await request(port, 'DELETE', `/task/${task.id}`);
      assert.equal(status, 200);
      assert.equal(canceled.status.state, 'canceled');
    });
  });

  describe('rate limiting', () => {
    test('returns 429 after exceeding limit', async () => {
      // Use constructor options to set a tight rate limit — avoids mutating
      // the shared config module and prevents test pollution.
      const p2 = port + 10;
      const s2 = new AgentServer({
        agentCard: makeAgentCard('rate-test', p2),
        agentName: 'rate-test',
        port: p2,
        taskStoreDir: tmpDir(),
        rateLimitMax: 2,        // allow only 2 tasks
        rateLimitWindowMs: 60_000,
      });
      await s2.start();

      try {
        const msg = { role: 'user', parts: [{ type: 'text', text: 'x' }] };
        await request(p2, 'POST', '/task', msg);
        await request(p2, 'POST', '/task', msg);
        const { status } = await request(p2, 'POST', '/task', msg);
        assert.equal(status, 429);
      } finally {
        await s2.stop();
      }
    });
  });

  describe('404 for unknown routes', () => {
    test('returns 404', async () => {
      const { status } = await request(port, 'GET', '/nonexistent');
      assert.equal(status, 404);
    });
  });

  describe('Async continuation (held tasks)', () => {
    test('(a) hold flow: handler returns { hold: true } -> task stays working, metadata.held true', async () => {
      const p = port + 20;
      const s = new AgentServer({
        agentCard: makeAgentCard('hold-test', p),
        agentName: 'hold-test',
        port: p,
        taskStoreDir: tmpDir(),
        handler: async () => ({ hold: true, note: 'waiting for worker' }),
      });
      await s.start();
      try {
        const { data: task } = await request(p, 'POST', '/task', { parts: [{ type: 'text', text: 'hold me' }] });
        await new Promise(r => setTimeout(r, 50));
        const { status, data: fetched } = await request(p, 'GET', `/task/${task.id}`);
        assert.equal(status, 200);
        assert.equal(fetched.status.state, 'working');
        assert.equal(fetched.metadata.held, true);
        assert.equal(fetched.metadata.note, 'waiting for worker');
        assert.ok(fetched.updatedAt);
      } finally {
        await s.stop();
      }
    });

    test('(b) appendArtifact AFTER handler returned lands in persisted record', async () => {
      const p = port + 21;
      const s = new AgentServer({
        agentCard: makeAgentCard('append-test', p),
        agentName: 'append-test',
        port: p,
        taskStoreDir: tmpDir(),
        handler: async () => ({ hold: true }),
      });
      await s.start();
      try {
        const { data: task } = await request(p, 'POST', '/task', { parts: [{ type: 'text', text: 'async' }] });
        await new Promise(r => setTimeout(r, 50));
        const initialTask = (await request(p, 'GET', `/task/${task.id}`)).data;
        const prevUpdatedAt = initialTask.updatedAt;

        await new Promise(r => setTimeout(r, 10));
        const appended = await s.appendArtifact(task.id, { parts: [{ type: 'text', text: 'step 1 done' }] }, { source: 'worker-1' });
        assert.equal(appended, true);

        const { data: fetched } = await request(p, 'GET', `/task/${task.id}`);
        assert.equal(fetched.artifacts.length, 1);
        assert.equal(fetched.artifacts[0].parts[0].text, 'step 1 done');
        assert.equal(fetched.artifacts[0].source, 'worker-1');
        assert.ok(fetched.updatedAt >= prevUpdatedAt);
      } finally {
        await s.stop();
      }
    });

    test('(c) appendArtifact on a completed task -> warning, no crash, returns false', async () => {
      const p = port + 22;
      const s = new AgentServer({
        agentCard: makeAgentCard('terminal-append', p),
        agentName: 'terminal-append',
        port: p,
        taskStoreDir: tmpDir(),
        handler: async () => ({ parts: [{ type: 'text', text: 'done' }] }),
      });
      await s.start();
      try {
        const { data: task } = await request(p, 'POST', '/task', { parts: [{ type: 'text', text: 'done' }] });
        await new Promise(r => setTimeout(r, 50));
        const completedTask = (await request(p, 'GET', `/task/${task.id}`)).data;
        assert.equal(completedTask.status.state, 'completed');

        const res = await s.appendArtifact(task.id, { parts: [{ type: 'text', text: 'late' }] });
        assert.equal(res, false);
      } finally {
        await s.stop();
      }
    });

    test('(d) completeTask -> completed; subsequent completeTask again -> no-op warning', async () => {
      const p = port + 23;
      const s = new AgentServer({
        agentCard: makeAgentCard('complete-test', p),
        agentName: 'complete-test',
        port: p,
        taskStoreDir: tmpDir(),
        handler: async () => ({ hold: true }),
      });
      await s.start();
      try {
        const { data: task } = await request(p, 'POST', '/task', { parts: [{ type: 'text', text: 'complete me' }] });
        await new Promise(r => setTimeout(r, 50));

        const res1 = await s.completeTask(task.id, { message: 'all good' });
        assert.equal(res1, true);

        const { data: fetched } = await request(p, 'GET', `/task/${task.id}`);
        assert.equal(fetched.status.state, 'completed');
        assert.equal(fetched.status.message, 'all good');

        const res2 = await s.completeTask(task.id, { message: 'again' });
        assert.equal(res2, false);
      } finally {
        await s.stop();
      }
    });

    test('(e) holdTimeoutMs auto-fail with message', async () => {
      const p = port + 24;
      const s = new AgentServer({
        agentCard: makeAgentCard('timeout-test', p),
        agentName: 'timeout-test',
        port: p,
        taskStoreDir: tmpDir(),
        holdTimeoutMs: 50,
        handler: async () => ({ hold: true }),
      });
      await s.start();
      try {
        const { data: task } = await request(p, 'POST', '/task', { parts: [{ type: 'text', text: 'timeout test' }] });
        await new Promise(r => setTimeout(r, 150));

        const { data: fetched } = await request(p, 'GET', `/task/${task.id}`);
        assert.equal(fetched.status.state, 'failed');
        assert.equal(fetched.status.message, 'held task timeout');
      } finally {
        await s.stop();
      }
    });

    test('(f) REGRESSION: plain handler (normal return) behaves exactly as before (completed + one artifact, no held metadata)', async () => {
      const p = port + 25;
      const s = new AgentServer({
        agentCard: makeAgentCard('regression-test', p),
        agentName: 'regression-test',
        port: p,
        taskStoreDir: tmpDir(),
        handler: async (message) => {
          return { parts: [{ type: 'text', text: 'normal result' }] };
        },
      });
      await s.start();
      try {
        const { data: task } = await request(p, 'POST', '/task', { parts: [{ type: 'text', text: 'normal' }] });
        await new Promise(r => setTimeout(r, 50));

        const { status, data: fetched } = await request(p, 'GET', `/task/${task.id}`);
        assert.equal(status, 200);
        assert.equal(fetched.status.state, 'completed');
        assert.equal(fetched.artifacts.length, 1);
        assert.equal(fetched.artifacts[0].parts[0].text, 'normal result');
        assert.equal(fetched.metadata?.held, undefined);
        assert.ok(fetched.updatedAt);
      } finally {
        await s.stop();
      }
    });
  });
});
