#!/usr/bin/env node
'use strict';

// =============================================================================
// Example A2A Agent — Echo Agent
// Receives messages, echoes them back as artifacts
// Task persistence via JSONL
// =============================================================================

const { AgentServer } = require('../src/server');

const PORT = parseInt(process.env.PORT) || 5001;

const agentCard = {
  schemaVersion: '1.0',
  name: 'echo-agent',
  description: 'A simple echo agent that receives messages and returns them as artifacts',
  url: `http://127.0.0.1:${PORT}`,
  capabilities: { streaming: false, pushNotifications: false },
  skills: [{ name: 'echo', description: 'Echoes back the received message text' }],
};

async function handleMessage(message, task) {
  const text = message?.parts?.[0]?.text || message?.text || JSON.stringify(message);
  return { parts: [{ type: 'text', text: `Echo: ${text}` }] };
}

async function main() {
  const server = new AgentServer({ agentCard, agentName: 'echo-agent', port: PORT, handler: handleMessage });
  const info = await server.start();
  console.log(`[echo-agent] A2A server on 127.0.0.1:${info.port}`);
  console.log(`[echo-agent] Card: GET /card | Tasks: POST /task`);

  const shutdown = async () => { await server.stop(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(e => { console.error('[echo-agent] Fatal:', e); process.exit(1); });
