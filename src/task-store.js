#!/usr/bin/env node
'use strict';

// =============================================================================
// ag2ag — Task Store
// File-backed task persistence using JSONL (one JSON line per task)
// Falls back to in-memory if file is not writable
// Uses composite key (agentName:taskId) to prevent cross-agent leakage
// Atomic writes via temp file + rename
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_STORE_DIR = path.join(__dirname, '..', 'data', 'tasks');

class TaskStore {
  constructor(options = {}) {
    this.storeDir = options.storeDir || DEFAULT_STORE_DIR;
    this._memory = new Map(); // key = agentName:taskId
    this._loaded = new Set(); // which agent files have been loaded
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
      for (const line of lines) {
        try {
          const task = JSON.parse(line);
          this._memory.set(this._key(agentName, task.id), task);
        } catch (_) {}
      }
    } catch (_) {}
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

  set(agentName, taskId, task) {
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

  delete(agentName, taskId) {
    this._loadTasks(agentName);
    const key = this._key(agentName, taskId);
    const deleted = this._memory.delete(key);
    if (deleted) this._writeAll(agentName);
    return deleted;
  }

  count(agentName) {
    this._loadTasks(agentName);
    const prefix = `${agentName}:`;
    return Array.from(this._memory.keys()).filter(k => k.startsWith(prefix)).length;
  }
}

module.exports = { TaskStore };
