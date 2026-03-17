/**
 * Hetzner Docker hosting service
 * Manages agent containers on a Hetzner VPS via SSH + Docker
 * Drop-in replacement for fly.ts
 */

import { TIER_CONFIGS } from '../types';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Hetzner server config (from env)
const HETZNER_HOST = process.env.HETZNER_HOST || '87.99.140.184';
const HETZNER_USER = process.env.HETZNER_USER || 'root';
const HETZNER_SSH_KEY = process.env.HETZNER_SSH_KEY || '/tmp/said_hetzner';

// Write SSH key from base64 env var on startup
import fs from 'fs';
if (process.env.HETZNER_SSH_KEY_B64 && !fs.existsSync(HETZNER_SSH_KEY)) {
  fs.mkdirSync('/tmp', { recursive: true });
  fs.writeFileSync(HETZNER_SSH_KEY, Buffer.from(process.env.HETZNER_SSH_KEY_B64, 'base64'), { mode: 0o600 });
  console.log('[hetzner] SSH key written from env');
}

type TierKey = 'free' | 'starter' | 'pro' | 'power';

type ContainerInfo = {
  id: string;        // container ID
  name: string;      // container name
  state: string;     // running, exited, etc.
  port: number;      // mapped port on host
};

/**
 * Execute a command on the Hetzner server via SSH
 * Uses stdin piping to avoid shell escaping issues with complex commands
 */
async function sshExec(command: string): Promise<string> {
  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    const proc = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-i', HETZNER_SSH_KEY,
      `${HETZNER_USER}@${HETZNER_HOST}`,
      'bash', '-s',
    ], { timeout: 60000 });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`SSH command failed (exit ${code}): ${stderr.trim()}`));
      } else {
        if (stderr && !stderr.includes('Warning:')) {
          console.warn('[hetzner] stderr:', stderr.trim());
        }
        resolve(stdout.trim());
      }
    });

    proc.on('error', (err: Error) => reject(new Error(`SSH spawn failed: ${err.message}`)));

    // Pipe command via stdin to avoid escaping issues
    proc.stdin.write(command);
    proc.stdin.end();
  });
}

/**
 * Find next available port on the host
 */
async function findNextPort(): Promise<number> {
  const result = await sshExec(`
    PORT=19000;
    while docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":\${PORT}->"; do
      PORT=$((PORT + 1));
    done;
    echo $PORT
  `);
  return parseInt(result, 10) || 19000;
}

/**
 * Create agent data directory and start container
 * Replaces: createApp + createVolume + createMachine
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
  const tierConfig = TIER_CONFIGS[params.tier];
  const containerName = `said-agent-${params.agentId.replace(/-/g, '').slice(0, 12)}`;
  const port = await findNextPort();
  
  // Memory limit: use tier config but cap at 2GB per container (host has 32GB)
  const memoryMb = Math.min(tierConfig.memory, 2048);
  
  // Escape env values for shell safety
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

  // Build docker run command
  const envFlags = envVars.map(v => `-e '${v}'`).join(' ');
  
  // Write large env vars (PROGRAM_MD, WORKSPACE_FILES_JSON, AGENT_CONFIG_JSON) to files
  // to avoid shell escaping issues
  const dataDir = `/opt/said-hosting/agents/${params.agentId}`;
  
  await sshExec(`mkdir -p ${dataDir}`);
  
  // Write program_md to file if present
  if (params.programMd) {
    const b64 = Buffer.from(params.programMd).toString('base64');
    await sshExec(`echo '${b64}' | base64 -d > ${dataDir}/.program_md`);
  }
  
  // Write workspace files to file if present
  if (params.workspaceFiles) {
    const b64 = Buffer.from(params.workspaceFiles).toString('base64');
    await sshExec(`echo '${b64}' | base64 -d > ${dataDir}/.workspace_files`);
  }
  
  // Write agent config to file if present
  if (params.config) {
    const b64 = Buffer.from(params.config).toString('base64');
    await sshExec(`echo '${b64}' | base64 -d > ${dataDir}/.agent_config`);
  }

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

  const containerId = await sshExec(dockerCmd);
  
  // Save port mapping
  await sshExec(`echo '${port}' > ${dataDir}/.port`);
  
  console.log(`[hetzner] Agent ${params.agentName} running as ${containerName} on port ${port}`);

  return {
    id: containerId.slice(0, 12),
    name: containerName,
    state: 'running',
    port,
  };
}

/**
 * Start a stopped container
 */
export async function startContainer(agentId: string): Promise<void> {
  const containerName = getContainerName(agentId);
  await sshExec(`docker start ${containerName}`);
}

/**
 * Stop a running container
 */
export async function stopContainer(agentId: string): Promise<void> {
  const containerName = getContainerName(agentId);
  await sshExec(`docker stop ${containerName}`);
}

/**
 * Remove container and data
 */
export async function deleteContainer(agentId: string): Promise<void> {
  const containerName = getContainerName(agentId);
  await sshExec(`docker rm -f ${containerName} 2>/dev/null; rm -rf /opt/said-hosting/agents/${agentId}`);
}

/**
 * Get container status
 */
export async function getContainer(agentId: string): Promise<ContainerInfo> {
  const containerName = getContainerName(agentId);
  const state = await sshExec(`docker inspect ${containerName} --format '{{.State.Status}}' 2>/dev/null || echo 'not_found'`);
  const portStr = await sshExec(`cat /opt/said-hosting/agents/${agentId}/.port 2>/dev/null || echo '0'`);
  
  return {
    id: containerName,
    name: containerName,
    state: state || 'unknown',
    port: parseInt(portStr, 10) || 0,
  };
}

/**
 * Get container logs
 */
export async function getContainerLogs(agentId: string, lines: number = 50): Promise<string> {
  const containerName = getContainerName(agentId);
  return sshExec(`docker logs ${containerName} --tail ${lines} 2>&1`);
}

/**
 * Get the public URL for an agent's gateway
 * For now, agents are accessible via the Hetzner IP + port
 * Later: nginx reverse proxy with subdomains
 */
export function getAgentUrl(agentId: string, port: number): string {
  return `http://${HETZNER_HOST}:${port}`;
}

/**
 * Get container name from agent ID
 */
function getContainerName(agentId: string): string {
  // Try to find by label first, fall back to naming convention
  return `said-agent-${agentId.replace(/-/g, '').slice(0, 12)}`;
}

/**
 * List all running agent containers
 */
export async function listContainers(): Promise<ContainerInfo[]> {
  const result = await sshExec(`docker ps --filter 'name=said-agent-' --format '{{.ID}}\t{{.Names}}\t{{.Status}}'`);
  if (!result) return [];
  
  return result.split('\n').map(line => {
    const [id, name, ...statusParts] = line.split('\t');
    return {
      id: id || '',
      name: name || '',
      state: statusParts.join(' ').includes('Up') ? 'running' : 'stopped',
      port: 0, // Would need to read from .port file
    };
  });
}

/**
 * Health check — verify SSH connection to Hetzner
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const result = await sshExec('echo ok');
    return result === 'ok';
  } catch {
    return false;
  }
}
