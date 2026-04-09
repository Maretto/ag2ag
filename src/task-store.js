#!/usr/bin/env node
'use strict';

// =============================================================================
// a2a-local — Task Store
// File-backed task persistence using JSONL (one JSON line per task)
// Falls back to in-memory if file is not writable
// =============================================================================

const fs = require('fs');
const path = require('path');

const DEFAULT_STORE_DIR = path.join(__dirname, '..', 'data', 'tasks');

class TaskStore {
  constructor(options = {}) {
    this.storeDir = options.storeDir || DEFAULT_STORE_DIR;
    this._memory = new Map(); // fallback
    this._loaded = new Set(); // which agent files have been loaded
  }

  _agentFile(agentName) {
    return path.join(this.storeDir, `${agentName}.jsonl`);
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
          this._memory.set(task.id, task);
        } catch (_) {}
      }
    } catch (_) {}
  }

  _appendTask(task) {
    if (!this._ensureDir()) return;
    const agentName = task._agent || 'unknown';
    const file = this._agentFile(agentName);
    try {
      fs.appendFileSync(file, JSON.stringify(task) + '\n');
    } catch (_) {}
  }

  _writeAll(agentName) {
    if (!this._ensureDir()) return;
    const file = this._agentFile(agentName);
    try {
      const tasks = Array.from(this._memory.values()).filter(t => t._agent === agentName);
      fs.writeFileSync(file, tasks.map(t => JSON.stringify(t)).join('\n') + '\n');
    } catch (_) {}
  }

  set(agentName, taskId, task) {
    task._agent = agentName;
    this._loadTasks(agentName);
    const isNew = !this._memory.has(taskId);
    this._memory.set(taskId, task);
    if (isNew) {
      this._appendTask(task);
    } else {
      this._writeAll(agentName); // rewrite on update
    }
    return task;
  }

  get(agentName, taskId) {
    this._loadTasks(agentName);
    return this._memory.get(taskId) || null;
  }

  list(agentName, options = {}) {
    this._loadTasks(agentName);
    let tasks = Array.from(this._memory.values()).filter(t => t._agent === agentName);
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
    const deleted = this._memory.delete(taskId);
    if (deleted) this._writeAll(agentName);
    return deleted;
  }

  count(agentName) {
    this._loadTasks(agentName);
    return Array.from(this._memory.values()).filter(t => t._agent === agentName).length;
  }
}

module.exports = { TaskStore };
