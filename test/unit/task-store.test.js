#!/usr/bin/env node
'use strict';

// =============================================================================
// Unit tests — TaskStore
// Uses Node.js built-in test runner (node:test, available since Node 18)
// =============================================================================

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskStore } = require('../../src/task-store');

// Helper: temporary store directory isolated per test run
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ag2ag-ts-test-'));
}

function makeTask(id, state = 'submitted') {
  return {
    id,
    status: { state, timestamp: new Date().toISOString() },
    messages: [],
    artifacts: [],
    metadata: {},
  };
}

describe('TaskStore', () => {
  describe('basic CRUD', () => {
    test('set and get a task', async () => {
      const store = new TaskStore({ storeDir: tmpDir() });
      const task = makeTask('t1');
      await store.set('agent1', 't1', task);
      const got = store.get('agent1', 't1');
      assert.equal(got.id, 't1');
      assert.equal(got._agent, 'agent1');
    });

    test('get returns null for unknown task', () => {
      const store = new TaskStore({ storeDir: tmpDir() });
      assert.equal(store.get('agent1', 'nope'), null);
    });

    test('list returns tasks for the right agent only', async () => {
      const store = new TaskStore({ storeDir: tmpDir() });
      await store.set('agent1', 't1', makeTask('t1'));
      await store.set('agent2', 't2', makeTask('t2'));
      const list1 = store.list('agent1');
      const list2 = store.list('agent2');
      assert.equal(list1.length, 1);
      assert.equal(list2.length, 1);
      assert.equal(list1[0].id, 't1');
      assert.equal(list2[0].id, 't2');
    });

    test('list filters by state', async () => {
      const store = new TaskStore({ storeDir: tmpDir() });
      await store.set('a', 't1', makeTask('t1', 'submitted'));
      await store.set('a', 't2', makeTask('t2', 'completed'));
      const submitted = store.list('a', { state: 'submitted' });
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0].id, 't1');
    });

    test('delete removes a task', async () => {
      const store = new TaskStore({ storeDir: tmpDir() });
      await store.set('a', 't1', makeTask('t1'));
      const deleted = await store.delete('a', 't1');
      assert.equal(deleted, true);
      assert.equal(store.get('a', 't1'), null);
    });

    test('delete returns false for unknown task', async () => {
      const store = new TaskStore({ storeDir: tmpDir() });
      assert.equal(await store.delete('a', 'ghost'), false);
    });

    test('count returns correct number', async () => {
      const store = new TaskStore({ storeDir: tmpDir() });
      assert.equal(store.count('a'), 0);
      await store.set('a', 't1', makeTask('t1'));
      await store.set('a', 't2', makeTask('t2'));
      assert.equal(store.count('a'), 2);
    });
  });

  describe('persistence', () => {
    test('tasks survive a store reload', async () => {
      const dir = tmpDir();
      const store1 = new TaskStore({ storeDir: dir });
      await store1.set('agent', 'p1', makeTask('p1', 'completed'));

      // New instance reads from the same directory
      const store2 = new TaskStore({ storeDir: dir });
      const task = store2.get('agent', 'p1');
      assert.ok(task, 'task should exist after reload');
      assert.equal(task.id, 'p1');
      assert.equal(task.status.state, 'completed');
    });

    test('updates are written to disk', async () => {
      const dir = tmpDir();
      const store = new TaskStore({ storeDir: dir });
      const task = makeTask('u1', 'submitted');
      await store.set('agent', 'u1', task);
      task.status.state = 'completed';
      await store.set('agent', 'u1', task);

      const store2 = new TaskStore({ storeDir: dir });
      const got = store2.get('agent', 'u1');
      assert.equal(got.status.state, 'completed');
    });
  });

  describe('prune', () => {
    test('removes tasks older than maxDays', async () => {
      const store = new TaskStore({ storeDir: tmpDir() });
      // Create a task with an old timestamp
      const oldTask = makeTask('old1', 'completed');
      oldTask.status.timestamp = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
      await store.set('a', 'old1', oldTask);

      // Create a recent task
      await store.set('a', 'new1', makeTask('new1', 'completed'));

      const deleted = await store.prune('a', 7);
      assert.equal(deleted, 1);
      assert.equal(store.get('a', 'old1'), null);
      assert.ok(store.get('a', 'new1'), 'recent task should remain');
    });

    test('returns 0 when nothing to prune', async () => {
      const store = new TaskStore({ storeDir: tmpDir() });
      await store.set('a', 't1', makeTask('t1', 'completed'));
      const deleted = await store.prune('a', 7);
      assert.equal(deleted, 0);
    });
  });

  describe('auto-cleanup', () => {
    test('startAutoCleanup returns a timer and stopAutoCleanup clears it', () => {
      const store = new TaskStore({ storeDir: tmpDir() });
      const timer = store.startAutoCleanup(['agent'], 7, 60_000);
      assert.ok(timer, 'should return a timer');
      store.stopAutoCleanup();
      assert.equal(store._cleanupTimer, null);
    });
  });
});
