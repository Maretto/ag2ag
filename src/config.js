#!/usr/bin/env node
'use strict';

// =============================================================================
// ag2ag — Configuration
// Centralizes all hardcoded values with environment variable overrides.
// All AG2AG_* env vars are documented in the README.
// =============================================================================

const pkg = require('../package.json');

module.exports = {
  // ── Server ──────────────────────────────────────────────────────────────────
  /** Maximum allowed request body size in bytes (default: 1 MB) */
  MAX_BODY_SIZE: parseInt(process.env.AG2AG_MAX_BODY_SIZE, 10) || 1024 * 1024,

  /** Default HTTP port for agent servers */
  DEFAULT_PORT: parseInt(process.env.AG2AG_PORT, 10) || 5001,

  /** Network interface to bind to — keep 127.0.0.1 for security */
  BIND_HOST: process.env.AG2AG_BIND_HOST || '127.0.0.1',

  // ── Rate Limiting ────────────────────────────────────────────────────────────
  /** Maximum number of tasks accepted per agent per window */
  RATE_LIMIT_MAX: parseInt(process.env.AG2AG_RATE_LIMIT_MAX, 10) || 60,

  /** Rate-limit sliding window in milliseconds (default: 60 s) */
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.AG2AG_RATE_LIMIT_WINDOW_MS, 10) || 60_000,

  // ── Task Store ───────────────────────────────────────────────────────────────
  /** Auto-cleanup interval in milliseconds (default: 24 h) */
  CLEANUP_INTERVAL_MS: parseInt(process.env.AG2AG_CLEANUP_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000,

  /** Number of days to retain completed tasks before pruning */
  CLEANUP_MAX_DAYS: parseInt(process.env.AG2AG_CLEANUP_MAX_DAYS, 10) || 7,

  // ── SSE ──────────────────────────────────────────────────────────────────────
  /** Interval (ms) for SSE heartbeat comment lines that prevent proxy/client timeouts */
  SSE_KEEPALIVE_MS: parseInt(process.env.AG2AG_SSE_KEEPALIVE_MS, 10) || 15_000,

  // ── Metadata ─────────────────────────────────────────────────────────────────
  /** Package version — read once at start-up */
  VERSION: pkg.version,
};
