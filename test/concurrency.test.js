#!/usr/bin/env node
'use strict';

// =============================================================================
// Concurrency / Stress tests — TaskStore + AgentServer
// Tests data integrity under 100+ parallel task submissions.
// Uses Node.js built-in test runner (node:test, available since Node 18)
// =============================================================================

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskStore } = require('../src/task-store');
const { AgentServer } = require('../src/server');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ag2ag-concurrency-'));
}

function postTask(port, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ role: 'user', parts: [{ type: 'text', text }] });
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: '/task',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Stress tests for TaskStore directly (in-process)
// ---------------------------------------------------------------------------

describe('TaskStore — concurrent writes', () => {
  test('100 concurrent set() calls produce 100 distinct tasks on disk', async () => {
    const dir = tmpDir();
    const store = new TaskStore({ storeDir: dir });
    const N = 100;
    const agent = 'stress-agent';

    // Fire N set() calls concurrently — no awaiting between them
    const promises = Array.from({ length: N }, (_, i) => {
      const id = `task-${i}`;
      return store.set(agent, id, {
        id,
        status: { state: 'completed', timestamp: new Date().toISOString() },
        messages: [],
        artifacts: [],
        metadata: {},
      });
    });

    await Promise.all(promises);

    // Verify in-memory state
    assert.equal(store.count(agent), N, 'All 100 tasks should be in memory');

    // Verify disk state by loading a fresh store instance
    const store2 = new TaskStore({ storeDir: dir });
    assert.equal(store2.count(agent), N, 'All 100 tasks should be persisted to disk');

    // Verify all IDs are present and unique
    const tasks = store2.list(agent);
    const ids = new Set(tasks.map(t => t.id));
    assert.equal(ids.size, N, 'All task IDs should be unique');
  });

  test('concurrent update of the same task does not corrupt data', async () => {
    const dir = tmpDir();
    const store = new TaskStore({ storeDir: dir });
    const agent = 'update-agent';
    const id = 'shared-task';

    // Create the initial task
    await store.set(agent, id, {
      id,
      status: { state: 'submitted', timestamp: new Date().toISOString() },
      messages: [],
      artifacts: [],
      metadata: { counter: 0 },
    });

    // 50 concurrent increments
    const N = 50;
    const promises = Array.from({ length: N }, async (_, i) => {
      const task = store.get(agent, id);
      task.metadata.counter = i; // each sets a different value
      return store.set(agent, id, { ...task });
    });

    await Promise.all(promises);

    // The task must still be parseable and have the right structure
    const final = store.get(agent, id);
    assert.ok(final, 'Task must exist after concurrent updates');
    assert.equal(final.id, id);
    assert.ok(typeof final.metadata.counter === 'number');

    // Reload from disk — must not be corrupt
    const store2 = new TaskStore({ storeDir: dir });
    const reloaded = store2.get(agent, id);
    assert.ok(reloaded, 'Task must be readable from disk after concurrent updates');
    assert.equal(reloaded.id, id);
  });
});

// ---------------------------------------------------------------------------
// Stress tests via HTTP (end-to-end)
// ---------------------------------------------------------------------------

describe('AgentServer — concurrent HTTP task submissions', () => {
  let server;
  let port;
  const AGENT = 'http-stress';

  before(async () => {
    port = 15200 + Math.floor(Math.random() * 100);

    // Temporarily disable rate limiting for this test
    const cfg = require('../src/config');
    cfg.RATE_LIMIT_MAX = 10_000;

    server = new AgentServer({
      agentCard: {
        schemaVersion: '1.0',
        name: AGENT,
        description: 'Stress test agent',
        url: `http://127.0.0.1:${port}`,
        capabilities: { streaming: false, pushNotifications: false },
        skills: [{ name: 'stress', description: 'Stress testing' }],
      },
      agentName: AGENT,
      port,
      taskStoreDir: tmpDir(),
    });
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  test('100 concurrent POST /task requests all return 201', async () => {
    const N = 100;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => postTask(port, `stress message ${i}`))
    );

    const statuses = results.map(r => r.status);
    const non201 = statuses.filter(s => s !== 201);
    assert.equal(non201.length, 0, `Expected all 201, got: ${JSON.stringify(non201)}`);

    // All returned task IDs must be unique
    const ids = new Set(results.map(r => r.data.id));
    assert.equal(ids.size, N, 'Each task must have a unique ID');
  });

  test('task listing shows all submitted tasks', async () => {
    // Wait briefly for any in-flight handler work
    await new Promise(r => setTimeout(r, 100));

    const opts = {
      hostname: '127.0.0.1',
      port,
      path: '/tasks',
      method: 'GET',
    };

    const { data } = await new Promise((resolve, reject) => {
      const req = http.request(opts, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(d) }));
      });
      req.on('error', reject);
      req.end();
    });

    assert.ok(data.count >= 100, `Expected at least 100 tasks, got ${data.count}`);
  });
});
