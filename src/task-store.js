#!/usr/bin/env node
'use strict';

// =============================================================================
// ag2ag — Task Store
// File-backed task persistence using JSONL (one JSON line per task)
// Falls back to in-memory if file is not writable
// Uses composite key (agentName:taskId) to prevent cross-agent leakage
// Atomic writes via temp file + rename
// Per-agent async mutex prevents concurrent write corruption
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');

const DEFAULT_STORE_DIR = path.join(__dirname, '..', 'data', 'tasks');

// ---------------------------------------------------------------------------
// Async Mutex — serialises write operations per agent
// Uses a promise chain so callers simply `await _withLock(name, fn)`.
// ---------------------------------------------------------------------------
class _Mutex {
  constructor() {
    // Map<agentName, Promise> — each entry is the tail of the current queue
    this._tails = new Map();
  }

  /**
   * Acquire the lock for `key`, run `fn()` exclusively, then release.
   * Concurrent callers are queued and run in FIFO order.
   * @param {string} key
   * @param {() => any} fn  May be synchronous or async.
   * @returns {Promise<any>}
   */
  run(key, fn) {
    const prev = this._tails.get(key) || Promise.resolve();
    // Schedule fn after whatever is currently in the queue.
    // `next` resolves/rejects with the return value of fn.
    const next = prev.then(fn, fn);
    // Keep only a no-reject tail so future callers don't get stale errors.
    this._tails.set(key, next.then(() => {}, () => {}));
    return next;
  }
}

class TaskStore {
  constructor(options = {}) {
    this.storeDir = options.storeDir || DEFAULT_STORE_DIR;
    this._memory = new Map(); // key = agentName:taskId
    this._loaded = new Set(); // which agent files have been loaded
    this._mutex = new _Mutex();
    this._cleanupTimer = null;
  }

  _key(agentName, taskId) {
    return `${agentName}:${taskId}`;
  }

  _agentFile(agentName) {
    // Sanitize agent name for filesystem
    const safe = agentName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.storeDir, `${safe}.jsonl`);
  }

  _ensureDir() {
    if (!fs.existsSync(this.storeDir)) {
      try {
        fs.mkdirSync(this.storeDir, { recursive: true });
      } catch (e) {
        return false;
      }
    }
    return true;
  }

  _loadTasks(agentName) {
    if (this._loaded.has(agentName)) return;
    this._loaded.add(agentName);
    const file = this._agentFile(agentName);
    try {
      if (!fs.existsSync(file)) return;
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        try {
          const task = JSON.parse(line);
          this._memory.set(this._key(agentName, task.id), task);
        } catch (err) {
          console.warn(`[TaskStore] Warning: Failed to parse task at line ${i + 1} for agent "${agentName}": ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`[TaskStore] Error reading file for agent "${agentName}": ${err.message}`);
    }
  }

  _appendTask(agentName, task) {
    if (!this._ensureDir()) return;
    const file = this._agentFile(agentName);
    try {
      fs.appendFileSync(file, JSON.stringify(task) + '\n');
    } catch (_) {}
  }

  _atomicWrite(agentName, lines) {
    if (!this._ensureDir()) return;
    const file = this._agentFile(agentName);
    const tmpFile = path.join(os.tmpdir(), `ag2ag-${agentName}-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmpFile, lines);
      fs.renameSync(tmpFile, file);
    } catch (e) {
      // Fallback: try direct write if rename fails (e.g. cross-device)
      try { fs.writeFileSync(file, lines); } catch (_) {}
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }

  _writeAll(agentName) {
    const tasks = Array.from(this._memory.entries())
      .filter(([key]) => key.startsWith(`${agentName}:`))
      .map(([, task]) => task);
    const content = tasks.map(t => JSON.stringify(t)).join('\n') + '\n';
    this._atomicWrite(agentName, content);
  }

  // ---------------------------------------------------------------------------
  // Public API — writes are serialised through the per-agent mutex
  // ---------------------------------------------------------------------------

  /**
   * Persist a task.  Returns a Promise that resolves with the saved task.
   * Concurrent calls for the same agent are queued (FIFO) to prevent JSONL
   * corruption under parallel load.
   */
  set(agentName, taskId, task) {
    return this._mutex.run(agentName, () => {
      task._agent = agentName;
      this._loadTasks(agentName);
      const key = this._key(agentName, taskId);
      const isNew = !this._memory.has(key);
      this._memory.set(key, task);
      if (isNew) {
        this._appendTask(agentName, task);
      } else {
        this._writeAll(agentName);
      }
      return task;
    });
  }

  get(agentName, taskId) {
    this._loadTasks(agentName);
    return this._memory.get(this._key(agentName, taskId)) || null;
  }

  list(agentName, options = {}) {
    this._loadTasks(agentName);
    const prefix = `${agentName}:`;
    let tasks = Array.from(this._memory.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, task]) => task);
    if (options.state) {
      tasks = tasks.filter(t => t.status?.state === options.state);
    }
    if (options.limit) {
      tasks = tasks.slice(-options.limit);
    }
    return tasks;
  }

  /** Delete a task.  Returns a Promise<boolean>. */
  delete(agentName, taskId) {
    return this._mutex.run(agentName, () => {
      this._loadTasks(agentName);
      const key = this._key(agentName, taskId);
      const deleted = this._memory.delete(key);
      if (deleted) this._writeAll(agentName);
      return deleted;
    });
  }

  count(agentName) {
    this._loadTasks(agentName);
    const prefix = `${agentName}:`;
    return Array.from(this._memory.keys()).filter(k => k.startsWith(prefix)).length;
  }

  /** Prune tasks older than maxDays.  Returns a Promise<number> (deleted count). */
  prune(agentName, maxDays) {
    return this._mutex.run(agentName, () => {
      this._loadTasks(agentName);
      const prefix = `${agentName}:`;
      const cutoffTime = Date.now() - (maxDays * 24 * 60 * 60 * 1000);
      let deletedCount = 0;

      for (const [key, task] of this._memory.entries()) {
        if (key.startsWith(prefix)) {
          const timestampStr = task.status?.timestamp || task.createdAt;
          let taskTime = 0;
          if (timestampStr) {
            taskTime = new Date(timestampStr).getTime();
          }

          if (taskTime > 0 && taskTime < cutoffTime) {
            this._memory.delete(key);
            deletedCount++;
          }
        }
      }

      if (deletedCount > 0) {
        this._writeAll(agentName);
      }
      return deletedCount;
    });
  }

  /**
   * Start a background timer that prunes old tasks every `intervalMs`.
   * The timer is unreffed so it will not prevent process exit.
   *
   * @param {string[]} agentNames  Agents to clean up.
   * @param {number}   [maxDays]   Tasks older than this are removed.
   * @param {number}   [intervalMs] How often to run the cleanup.
   */
  startAutoCleanup(agentNames, maxDays, intervalMs) {
    const days = maxDays || config.CLEANUP_MAX_DAYS;
    const interval = intervalMs || config.CLEANUP_INTERVAL_MS;

    if (this._cleanupTimer) clearInterval(this._cleanupTimer);

    this._cleanupTimer = setInterval(async () => {
      for (const name of agentNames) {
        try {
          const n = await this.prune(name, days);
          if (n > 0) {
            console.log(`[TaskStore] Auto-cleanup: removed ${n} old task(s) for agent "${name}"`);
          }
        } catch (e) {
          console.error(`[TaskStore] Auto-cleanup error for agent "${name}": ${e.message}`);
        }
      }
    }, interval);

    // Do not keep the Node.js event loop alive just for cleanup
    this._cleanupTimer.unref();
    return this._cleanupTimer;
  }

  /** Stop the auto-cleanup timer if running. */
  stopAutoCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}

module.exports = { TaskStore };
