/**
 * Hetzner Docker hosting service - Multi-host support
 * Manages agent containers across multiple Hetzner VPS via SSH + Docker
 */

import { TIER_CONFIGS } from '../types';
import { prisma } from '../db';

// Hetzner server config
const HETZNER_USER = process.env.HETZNER_USER || 'root';
const HETZNER_SSH_KEY = process.env.HETZNER_SSH_KEY || '/tmp/said_hetzner';

// Multi-host configuration
const HETZNER_HOSTS = (process.env.HETZNER_HOSTS || '87.99.140.184').split(',').map(h => h.trim());

// Write SSH key from base64 env var on startup
import fs from 'fs';
if (process.env.HETZNER_SSH_KEY_B64 && !fs.existsSync(HETZNER_SSH_KEY)) {
  fs.mkdirSync('/tmp', { recursive: true });
  fs.writeFileSync(HETZNER_SSH_KEY, Buffer.from(process.env.HETZNER_SSH_KEY_B64, 'base64'), { mode: 0o600 });
  console.log('[hetzner] SSH key written from env');
}

type TierKey = 'free' | 'starter' | 'pro' | 'power';

type ContainerInfo = {
  id: string;
  name: string;
  state: string;
  port: number;
  hostIp: string;
};

/**
 * Execute a command on a specific Hetzner server via SSH
 */
async function sshExec(hostIp: string, command: string): Promise<string> {
  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    const proc = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-i', HETZNER_SSH_KEY,
      `${HETZNER_USER}@${hostIp}`,
      'bash', '-s',
    ], { timeout: 60000 });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`SSH command failed on ${hostIp} (exit ${code}): ${stderr.trim()}`));
      } else {
        if (stderr && !stderr.includes('Warning:')) {
          console.warn(`[hetzner:${hostIp}] stderr:`, stderr.trim());
        }
        resolve(stdout.trim());
      }
    });

    proc.on('error', (err: Error) => reject(new Error(`SSH spawn failed for ${hostIp}: ${err.message}`)));

    proc.stdin.write(command);
    proc.stdin.end();
  });
}

/**
 * Find next available port on a specific host
 */
async function findNextPort(hostIp: string): Promise<number> {
  const result = await sshExec(hostIp, `
    PORT=19000;
    while docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":\${PORT}->"; do
      PORT=$((PORT + 1));
    done;
    echo $PORT
  `);
  return parseInt(result, 10) || 19000;
}

/**
 * Get agent count per host for load balancing
 */
async function getHostCapacity(): Promise<Map<string, number>> {
  const agents = await prisma.agent.groupBy({
    by: ['hostIp'],
    where: {
      status: { in: ['running', 'creating'] },
    },
    _count: true,
  });

  const capacity = new Map<string, number>();
  for (const host of HETZNER_HOSTS) {
    capacity.set(host, 0);
  }
  
  for (const { hostIp, _count } of agents) {
    if (hostIp) capacity.set(hostIp, _count);
  }

  return capacity;
}

/**
 * Select the least-loaded host for new agent
 */
async function selectHost(): Promise<string> {
  const capacity = await getHostCapacity();
  
  let minLoad = Infinity;
  let selectedHost = HETZNER_HOSTS[0];
  
  for (const [host, count] of capacity.entries()) {
    if (count < minLoad) {
      minLoad = count;
      selectedHost = host;
    }
  }
  
  console.log(`[hetzner] Selected host ${selectedHost} (load: ${minLoad} agents)`);
  return selectedHost;
}

/**
 * Create agent data directory and start container
 */
export async function createContainer(params: {
  agentId: string;
  tier: TierKey;
  agentName?: string;
  agentDescription?: string;
  programMd?: string;
  config?: string;
  openRouterKey?: string;
  telegramToken?: string;
  gatewayToken: string;
  workspaceFiles?: string;
}): Promise<ContainerInfo> {
  const hostIp = await selectHost();
  const tierConfig = TIER_CONFIGS[params.tier];
  const containerName = `said-agent-${params.agentId.replace(/-/g, '').slice(0, 12)}`;
  const port = await findNextPort(hostIp);
  
  const memoryMb = Math.min(tierConfig.memory, 2048);
  
  const envVars = [
    `SAID_AGENT_TIER=${params.tier}`,
    `SAID_AGENT_ID=${params.agentId}`,
    `SAID_AGENT_NAME=${(params.agentName || 'SAID Agent').replace(/'/g, "\\'")}`,
    `SAID_AGENT_DESCRIPTION=${(params.agentDescription || '').replace(/'/g, "\\'")}`,
    `SAID_PLATFORM_API=https://app.saidprotocol.com`,
    `SAID_PLATFORM_API_KEY=${process.env.API_KEY || ''}`,
    `OPENCLAW_GATEWAY_TOKEN=${params.gatewayToken}`,
    `OPENROUTER_API_KEY=${params.openRouterKey || ''}`,
    `SAID_TELEGRAM_TOKEN=${params.telegramToken || ''}`,
    `NODE_OPTIONS=--max-old-space-size=1536`,
  ];

  const envFlags = envVars.map(v => `-e '${v}'`).join(' ');
  const dataDir = `/opt/said-hosting/agents/${params.agentId}`;
  
  await sshExec(hostIp, `mkdir -p ${dataDir} && chown -R 1000:1000 ${dataDir}`);
  
  if (params.programMd) {
    const b64 = Buffer.from(params.programMd).toString('base64');
    await sshExec(hostIp, `echo '${b64}' | base64 -d > ${dataDir}/.program_md`);
  }
  
  if (params.workspaceFiles) {
    const b64 = Buffer.from(params.workspaceFiles).toString('base64');
    await sshExec(hostIp, `echo '${b64}' | base64 -d > ${dataDir}/.workspace_files`);
  }
  
  if (params.config) {
    const b64 = Buffer.from(params.config).toString('base64');
    await sshExec(hostIp, `echo '${b64}' | base64 -d > ${dataDir}/.agent_config`);
  }

  await sshExec(hostIp, `chown -R 1000:1000 ${dataDir}`);

  const dockerCmd = `docker run -d \
    --name ${containerName} \
    --restart unless-stopped \
    --memory=${memoryMb}m \
    --cpus=0.5 \
    -v ${dataDir}:/data \
    -v /opt/said-hosting/docker/entrypoint.sh:/agent/entrypoint.sh:ro \
    -v /opt/said-hosting/docker/config:/agent/config:ro \
    -v /opt/said-hosting/docker/scripts:/agent/scripts:ro \
    -p 0.0.0.0:${port}:18789 \
    ${envFlags} \
    -e PROGRAM_MD="$(cat ${dataDir}/.program_md 2>/dev/null || echo '')" \
    -e WORKSPACE_FILES_JSON="$(cat ${dataDir}/.workspace_files 2>/dev/null || echo '[]')" \
    -e AGENT_CONFIG_JSON="$(cat ${dataDir}/.agent_config 2>/dev/null || echo '{}')" \
    said-agent:latest \
    /agent/entrypoint.sh`;

  const containerId = await sshExec(hostIp, dockerCmd);
  await sshExec(hostIp, `echo '${port}' > ${dataDir}/.port`);
  
  console.log(`[hetzner:${hostIp}] Agent ${params.agentName} running as ${containerName} on port ${port}`);

  return {
    id: containerId.slice(0, 12),
    name: containerName,
    state: 'running',
    port,
    hostIp,
  };
}

/**
 * Start a stopped container
 */
export async function startContainer(agentId: string, hostIp: string): Promise<void> {
  const containerName = getContainerName(agentId);
  await sshExec(hostIp, `docker start ${containerName}`);
}

/**
 * Stop a running container
 */
export async function stopContainer(agentId: string, hostIp: string): Promise<void> {
  const containerName = getContainerName(agentId);
  await sshExec(hostIp, `docker stop ${containerName}`);
}

/**
 * Remove container and data
 */
export async function deleteContainer(agentId: string, hostIp: string): Promise<void> {
  const containerName = getContainerName(agentId);
  await sshExec(hostIp, `docker rm -f ${containerName} 2>/dev/null; rm -rf /opt/said-hosting/agents/${agentId}`);
}

/**
 * Get container status
 */
export async function getContainer(agentId: string, hostIp: string): Promise<ContainerInfo> {
  const containerName = getContainerName(agentId);
  const state = await sshExec(hostIp, `docker inspect ${containerName} --format '{{.State.Status}}' 2>/dev/null || echo 'not_found'`);
  const portStr = await sshExec(hostIp, `cat /opt/said-hosting/agents/${agentId}/.port 2>/dev/null || echo '0'`);
  
  return {
    id: containerName,
    name: containerName,
    state: state || 'unknown',
    port: parseInt(portStr, 10) || 0,
    hostIp,
  };
}

/**
 * Get container logs
 */
export async function getContainerLogs(agentId: string, hostIp: string, lines: number = 50): Promise<string> {
  const containerName = getContainerName(agentId);
  return sshExec(hostIp, `docker logs ${containerName} --tail ${lines} 2>&1`);
}

/**
 * Get the public URL for an agent's gateway
 */
export function getAgentUrl(hostIp: string, port: number): string {
  return `http://${hostIp}:${port}`;
}

/**
 * Get container name from agent ID
 */
function getContainerName(agentId: string): string {
  return `said-agent-${agentId.replace(/-/g, '').slice(0, 12)}`;
}

/**
 * List all running agent containers across all hosts
 */
export async function listContainers(): Promise<ContainerInfo[]> {
  const allContainers: ContainerInfo[] = [];
  
  for (const hostIp of HETZNER_HOSTS) {
    try {
      const result = await sshExec(hostIp, `docker ps --filter 'name=said-agent-' --format '{{.ID}}\t{{.Names}}\t{{.Status}}'`);
      if (!result) continue;
      
      const containers = result.split('\n').map(line => {
        const [id, name, ...statusParts] = line.split('\t');
        return {
          id: id || '',
          name: name || '',
          state: statusParts.join(' ').includes('Up') ? 'running' : 'stopped',
          port: 0,
          hostIp,
        };
      });
      
      allContainers.push(...containers);
    } catch (err) {
      console.error(`[hetzner:${hostIp}] Failed to list containers:`, err);
    }
  }
  
  return allContainers;
}

/**
 * Update environment variable in container
 */
export async function updateContainerEnv(agentId: string, hostIp: string, key: string, value: string): Promise<void> {
  const containerName = getContainerName(agentId);
  const escapedValue = value.replace(/'/g, "'\\''");
  await sshExec(hostIp, `docker exec ${containerName} node -e "
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync('/data/openclaw.json', 'utf8'));
    if (!config.env) config.env = {};
    config.env['${key}'] = '${escapedValue}';
    fs.writeFileSync('/data/openclaw.json', JSON.stringify(config, null, 2));
    console.log('Updated ${key}');
  " && docker restart ${containerName}`);
}

/**
 * Update multiple env vars in container
 */
export async function updateContainerEnvBatch(agentId: string, hostIp: string, entries: [string, string][]): Promise<void> {
  const containerName = getContainerName(agentId);
  const assignments = entries.map(([k, v]) => `config.env['${k}'] = '${v.replace(/'/g, "'\\''")}';`).join('\n    ');
  await sshExec(hostIp, `docker exec ${containerName} node -e "
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync('/data/openclaw.json', 'utf8'));
    if (!config.env) config.env = {};
    ${assignments}
    fs.writeFileSync('/data/openclaw.json', JSON.stringify(config, null, 2));
    console.log('Updated ${entries.length} keys');
  " && docker restart ${containerName}`);
}

/**
 * Health check for all hosts
 */
export async function healthCheck(): Promise<{ host: string; ok: boolean }[]> {
  const results: { host: string; ok: boolean }[] = [];
  
  for (const hostIp of HETZNER_HOSTS) {
    try {
      const result = await sshExec(hostIp, 'echo ok');
      results.push({ host: hostIp, ok: result === 'ok' });
    } catch {
      results.push({ host: hostIp, ok: false });
    }
  }
  
  return results;
}
