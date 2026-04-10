#!/usr/bin/env node
'use strict';

// =============================================================================
// ag2ag — Registry Manager
// Manages the local JSON registry of A2A agents
// =============================================================================

const fs = require('fs');
const path = require('path');

const DEFAULT_REGISTRY_PATH = path.join(__dirname, '..', 'config', 'registry.json');

class Registry {
  constructor(registryPath) {
    this.path = registryPath || DEFAULT_REGISTRY_PATH;
    this._data = null;
  }

  /**
   * Migrate registry data from older schema versions to the current one.
   * Add a new `if` block here for each future version bump.
   * @param {object} data  Raw parsed JSON from disk.
   * @returns {object}     Migrated data object.
   */
  _migrate(data) {
    if (!data || typeof data !== 'object') {
      return { agents: [], version: '1.0' };
    }
    // Ensure the agents array exists (pre-1.0 might be missing it)
    if (!Array.isArray(data.agents)) {
      data.agents = [];
    }
    // Normalise version field
    if (!data.version) {
      data.version = '1.0';
    }
    // Future migrations go here, e.g.:
    // if (data.version === '1.0') { data = this._migrateV1toV2(data); }
    return data;
  }

  _load() {
    if (this._data) return this._data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this._data = this._migrate(raw);
    } catch (e) {
      this._data = { agents: [], version: '1.0' };
    }
    return this._data;
  }

  _save() {
    const dir = path.dirname(this.path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify(this._data, null, 2) + '\n');
  }

  add(agent) {
    const data = this._load();
    const existing = data.agents.findIndex(a => a.name === agent.name);
    if (existing >= 0) {
      data.agents[existing] = { ...data.agents[existing], ...agent, updatedAt: new Date().toISOString() };
    } else {
      data.agents.push({ ...agent, registeredAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    this._save();
    return agent;
  }

  remove(name) {
    const data = this._load();
    const before = data.agents.length;
    data.agents = data.agents.filter(a => a.name !== name);
    if (data.agents.length < before) {
      this._save();
      return true;
    }
    return false;
  }

  get(name) {
    const data = this._load();
    return data.agents.find(a => a.name === name) || null;
  }

  list() {
    return this._load().agents;
  }

  findByPort(port) {
    return this._load().agents.find(a => a.port === port) || null;
  }

  findAvailablePort(startPort = 5001) {
    const usedPorts = new Set(this._load().agents.map(a => a.port));
    let port = startPort;
    while (usedPorts.has(port)) port++;
    return port;
  }

  update(name, updates) {
    const data = this._load();
    const agent = data.agents.find(a => a.name === name);
    if (!agent) return null;
    Object.assign(agent, updates, { updatedAt: new Date().toISOString() });
    this._save();
    return agent;
  }

  count() {
    return this._load().agents.length;
  }
}

module.exports = { Registry, DEFAULT_REGISTRY_PATH };
