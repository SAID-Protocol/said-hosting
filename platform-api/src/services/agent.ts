import crypto from 'crypto';
import { run, get, all, save } from '../db';
import { Agent, CreateAgentRequest, TIER_CONFIGS } from '../types';
import { createApp, createMachine, createVolume, deleteApp, deleteMachine, getMachine, startMachine, stopMachine } from './fly';

function generateId(): string { return crypto.randomUUID(); }
function shortId(id: string): string { return id.replace(/-/g, '').slice(0, 8); }
function now(): string { return new Date().toISOString(); }

function logActivity(agentId: string, type: string, data: string) {
  run('INSERT INTO activity (agent_id, type, data) VALUES (?, ?, ?)', [agentId, type, data]);
}

export async function createAgent(userId: string, payload: CreateAgentRequest): Promise<Agent> {
  const agentId = generateId();
  const sid = shortId(agentId);
  const appName = `said-${sid}`;
  const volumeName = `data_${sid}`;
  const tier = payload.tier ?? 'starter';
  const tierConfig = TIER_CONFIGS[tier];
  const gatewayToken = crypto.randomBytes(24).toString('hex');

  if (!payload.name?.trim()) throw new Error('Agent name is required');

  let machineId: string | null = null;
  try {
    await createApp(appName);
    const volume = await createVolume(appName, volumeName, tierConfig.volumeSize);
    const machine = await createMachine({
      appName, agentId, tier, volumeId: volume.id,
      programMd: payload.program_md,
      config: payload.config ? JSON.stringify(payload.config) : undefined,
    });
    machineId = machine.id;

    run(
      `INSERT INTO agents (id, user_id, name, fly_machine_id, fly_app_name, status, tier, program_md, config, gateway_token, ai_credits_limit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, userId, payload.name.trim(), machine.id, appName, 'running', tier,
       payload.program_md ?? null, payload.config ? JSON.stringify(payload.config) : null,
       gatewayToken, tierConfig.aiCredits, now(), now()]
    );
    logActivity(agentId, 'system', `Agent created on Fly app ${appName}`);
    return get('SELECT * FROM agents WHERE id = ?', [agentId]) as Agent;
  } catch (error) {
    if (machineId) { try { await deleteMachine(appName, machineId); } catch {} }
    try { await deleteApp(appName); } catch {}
    throw error;
  }
}

export function listAgents(userId: string): Agent[] {
  return all('SELECT * FROM agents WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}

export function getAgentById(userId: string, agentId: string): Agent | undefined {
  return get('SELECT * FROM agents WHERE id = ? AND user_id = ?', [agentId, userId]);
}

export function updateAgent(userId: string, agentId: string, updates: { program_md?: string | null; config?: Record<string, unknown> | null }): Agent {
  const existing = getAgentById(userId, agentId);
  if (!existing) throw new Error('Agent not found');

  const nextProgramMd = updates.program_md ?? existing.program_md;
  const nextConfig = updates.config === undefined ? existing.config : updates.config === null ? null : JSON.stringify(updates.config);

  run('UPDATE agents SET program_md = ?, config = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    [nextProgramMd, nextConfig, now(), agentId, userId]);
  logActivity(agentId, 'system', 'Agent configuration updated');
  return getAgentById(userId, agentId) as Agent;
}

export async function startAgent(userId: string, agentId: string): Promise<Agent> {
  const agent = getAgentById(userId, agentId);
  if (!agent?.fly_app_name || !agent?.fly_machine_id) throw new Error('Agent not found');
  await startMachine(agent.fly_app_name, agent.fly_machine_id);
  run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', ['running', now(), agentId]);
  logActivity(agentId, 'system', 'Agent started');
  return getAgentById(userId, agentId) as Agent;
}

export async function stopAgent(userId: string, agentId: string): Promise<Agent> {
  const agent = getAgentById(userId, agentId);
  if (!agent?.fly_app_name || !agent?.fly_machine_id) throw new Error('Agent not found');
  await stopMachine(agent.fly_app_name, agent.fly_machine_id);
  run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', ['stopped', now(), agentId]);
  logActivity(agentId, 'system', 'Agent stopped');
  return getAgentById(userId, agentId) as Agent;
}

export async function deleteAgent(userId: string, agentId: string): Promise<void> {
  const agent = getAgentById(userId, agentId);
  if (!agent?.fly_app_name || !agent?.fly_machine_id) throw new Error('Agent not found');
  await deleteMachine(agent.fly_app_name, agent.fly_machine_id);
  await deleteApp(agent.fly_app_name);
  run('DELETE FROM activity WHERE agent_id = ?', [agentId]);
  run('DELETE FROM agents WHERE id = ? AND user_id = ?', [agentId, userId]);
}

export async function getAgentStatus(userId: string, agentId: string) {
  const agent = getAgentById(userId, agentId);
  if (!agent?.fly_app_name || !agent?.fly_machine_id) throw new Error('Agent not found');
  const fly = await getMachine(agent.fly_app_name, agent.fly_machine_id);
  return { agent, fly };
}

export function getAgentLogs(userId: string, agentId: string) {
  const agent = getAgentById(userId, agentId);
  if (!agent) throw new Error('Agent not found');
  return all('SELECT * FROM activity WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50', [agentId]);
}
