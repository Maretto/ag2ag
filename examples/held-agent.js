#!/usr/bin/env node
'use strict';

// =============================================================================
// Example A2A Agent — Delegating Bridge (Held Tasks)
// Demonstrates async continuation (hold -> appendArtifact progress -> completeTask)
// =============================================================================

const http = require('http');
const { AgentServer } = require('../src/server');

const PORT = parseInt(process.env.PORT, 10) || 5002;

const agentCard = {
  schemaVersion: '1.0',
  name: 'held-agent',
  description: 'Demonstrates async continuation with held tasks and external delegation',
  url: `http://127.0.0.1:${PORT}`,
  capabilities: { streaming: false, pushNotifications: false },
  skills: [{ name: 'delegate', description: 'Delegates to long-running task and appends progress' }],
};

async function handleMessage(message, task) {
  // Handler signals that processing is delegated asynchronously
  console.log(`[held-agent] Task ${task.id} received, holding task for async execution...`);
  return { hold: true, note: 'Delegated to external long-running job' };
}

function requestJSON(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const server = new AgentServer({
    agentCard,
    agentName: 'held-agent',
    port: PORT,
    handler: handleMessage,
    holdTimeoutMs: 10000,
  });

  await server.start();
  console.log(`[held-agent] Server running at http://127.0.0.1:${PORT}`);

  // 1. Submit task
  const createdTask = await requestJSON(PORT, 'POST', '/task', {
    role: 'user',
    parts: [{ type: 'text', text: 'Run long operation' }],
  });
  const taskId = createdTask.id;
  console.log(`[held-agent] Created task ${taskId}`);

  // Give handler a moment to execute setImmediate and hold task
  await new Promise(r => setTimeout(r, 100));

  let fetched = await requestJSON(PORT, 'GET', `/task/${taskId}`);
  console.log(`[held-agent] Task status after handler: state=${fetched.status.state}, held=${fetched.metadata?.held}`);

  // 2. Simulate external system sending progress artifact
  console.log(`[held-agent] External job emitting progress artifact...`);
  await server.appendArtifact(taskId, {
    parts: [{ type: 'text', text: 'Progress: 50% completed' }],
  }, { source: 'external-worker' });

  fetched = await requestJSON(PORT, 'GET', `/task/${taskId}`);
  console.log(`[held-agent] Artifacts count: ${fetched.artifacts.length}, updatedAt: ${fetched.updatedAt}`);

  // 3. Complete task cleanly
  console.log(`[held-agent] External job completed. Completing task...`);
  await server.completeTask(taskId, {
    artifact: { parts: [{ type: 'text', text: 'Final result: Success!' }] },
    message: 'Job completed successfully',
  });

  fetched = await requestJSON(PORT, 'GET', `/task/${taskId}`);
  console.log(`[held-agent] Final status: state=${fetched.status.state}, artifacts=${fetched.artifacts.length}`);

  await server.stop();
  console.log('[held-agent] Example finished successfully.');
}

if (require.main === module) {
  main().catch(err => {
    console.error('[held-agent] Error:', err);
    process.exit(1);
  });
}
