#!/usr/bin/env node
'use strict';

// =============================================================================
// Health Proxy Agent — A2A Agent
// Queries Mesh Ping and API Gateway for ecosystem health
// Demonstrates real inter-agent communication via A2A
// =============================================================================

const { AgentServer } = require('../src/server');
const { AgentClient } = require('../src/client');
const http = require('http');

const PORT = parseInt(process.env.PORT) || 5010;
const client = new AgentClient({ timeout: 8000 });

const agentCard = {
  schemaVersion: '1.0',
  name: 'health-proxy',
  description: 'A2A agent that queries Mesh Ping and API Gateway to produce ecosystem health reports',
  url: `http://127.0.0.1:${PORT}`,
  capabilities: { streaming: false, pushNotifications: false },
  skills: [
    { name: 'ecosystem-health', description: 'Combined health report from Mesh Ping metrics and API Gateway status' },
    { name: 'service-check', description: 'Check health of a specific service by name' },
    { name: 'mesh-status', description: 'Raw Mesh Ping status for all services' },
  ],
};

async function _httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: 8000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function handleMessage(message, task) {
  const text = (message?.parts?.[0]?.text || '').toLowerCase();
  const lines = [];

  // ─── Gather data from other agents ──────────────────────────
  let meshData = null;
  let gatewayHealth = null;

  try {
    const res = await _httpGet(3101, '/mesh/status');
    meshData = res.data;
  } catch (e) {
    lines.push(`⚠️ Mesh Ping unreachable: ${e.message}`);
  }

  try {
    const res = await _httpGet(3099, '/api/health');
    gatewayHealth = res.data;
  } catch (e) {
    lines.push(`⚠️ API Gateway unreachable: ${e.message}`);
  }

  // ─── Route by intent ────────────────────────────────────────
  if (text.includes('check') || text.includes('specific') || text.includes('service')) {
    // Service-specific check
    const serviceName = text.replace(/check|service|health|status/gi, '').trim();
    if (serviceName && meshData?.services) {
      const svc = Object.values(meshData.services).find(s =>
        s.name.toLowerCase().includes(serviceName) || s.id.toLowerCase().includes(serviceName)
      );
      if (svc) {
        const emoji = svc.status === 'UP' ? '🟢' : svc.status === 'DEGRADED' ? '🟡' : '🔴';
        lines.push(`${emoji} **${svc.name}**: ${svc.status}`);
        lines.push(`   Latency: ${svc.latency}ms | Uptime 24h: ${svc.uptimePct24h}% | Failures: ${svc.consecutiveFailures}`);
      } else {
        lines.push(`Service "${serviceName}" not found in Mesh Ping.`);
        lines.push(`Available: ${Object.values(meshData.services).map(s => s.name).join(', ')}`);
      }
    } else {
      lines.push('Usage: "check <service-name>" (e.g., "check api-gateway")');
    }
  } else {
    // Full ecosystem health report
    lines.push('📊 **Ecosystem Health Report**\n');

    if (gatewayHealth) {
      const uptime = Math.floor(gatewayHealth.uptime / 60);
      lines.push(`🌐 API Gateway: UP (${uptime}min uptime)`);
    }

    if (meshData?.services) {
      const services = Object.values(meshData.services);
      const up = services.filter(s => s.status === 'UP').length;
      const total = services.length;
      lines.push(`📡 Mesh Ping: ${up}/${total} services UP\n`);

      for (const svc of services) {
        const emoji = svc.status === 'UP' ? '🟢' : svc.status === 'DEGRADED' ? '🟡' : '🔴';
        const latency = svc.latency !== null ? `${svc.latency}ms` : 'N/A';
        const uptime = svc.uptimePct24h !== undefined ? `${svc.uptimePct24h}%` : '?';
        lines.push(`  ${emoji} ${svc.name}: ${svc.status} | ${latency} | up ${uptime}`);
      }
    }

    if (!meshData && !gatewayHealth) {
      lines.push('❌ No monitoring data available. Mesh Ping and API Gateway may be down.');
    }
  }

  return {
    parts: [{ type: 'text', text: lines.join('\n') }],
    source: 'health-proxy',
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  const server = new AgentServer({
    agentCard,
    agentName: 'health-proxy',
    port: PORT,
    handler: handleMessage,
  });

  const info = await server.start();
  console.log(`[health-proxy] A2A agent on 127.0.0.1:${info.port}`);
  console.log(`[health-proxy] Skills: ecosystem-health, service-check, mesh-status`);

  const shutdown = async () => { await server.stop(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(e => { console.error('[health-proxy] Fatal:', e); process.exit(1); });
