import crypto from 'crypto';
import { prisma } from '../db';
import { CreateAgentRequest, TIER_CONFIGS } from '../types';
import { createApp, createMachine, createVolume, deleteApp, deleteMachine, getMachine, startMachine, stopMachine } from './fly';
import { createAgentKey, deleteKey, disableKey, enableKey } from './openrouter';

function generateId(): string { return crypto.randomUUID(); }
function shortId(id: string): string { return id.replace(/-/g, '').slice(0, 8); }

function logActivity(agentId: string, type: string, data: string) {
  prisma.activity.create({ data: { agentId, type, data } }).catch(console.error);
}

export async function createAgent(userId: string, payload: CreateAgentRequest) {
  const agentId = generateId();
  const sid = shortId(agentId);
  const appName = `said-${sid}`;
  const volumeName = `data_${sid}`;
  const tier = payload.tier ?? 'starter';
  const tierConfig = TIER_CONFIGS[tier];
  // Gateway token generated here and passed to both DB and Fly machine
  const gatewayToken = crypto.randomBytes(24).toString('hex');

  if (!payload.name?.trim()) throw new Error('Agent name is required');

  let machineId: string | null = null;
  let orKeyHash: string | null = null;
  try {
    // 1. Create OpenRouter API key with tier spending limit
    const orKey = await createAgentKey(agentId, payload.name.trim(), tier);
    orKeyHash = orKey.hash;

    // 2. Create Fly app, volume, machine
    await createApp(appName);
    const volume = await createVolume(appName, volumeName, tierConfig.volumeSize);
    const machine = await createMachine({
      appName, agentId, tier, volumeId: volume.id,
      agentName: payload.name.trim(),
      agentDescription: payload.description || `Hosted SAID agent: ${payload.name.trim()}`,
      programMd: payload.program_md,
      config: payload.config ? JSON.stringify(payload.config) : undefined,
      openRouterKey: orKey.key,
      gatewayToken,
    });
    machineId = machine.id;

    // Only store the key hash — raw key is passed to the container env and never persisted by us
    const agent = await prisma.agent.create({
      data: {
        id: agentId,
        userId,
        name: payload.name.trim(),
        flyMachineId: machine.id,
        flyAppName: appName,
        status: 'running',
        tier,
        programMd: payload.program_md ?? null,
        config: payload.config ? JSON.stringify(payload.config) : null,
        gatewayToken,
        aiCreditsLimit: tierConfig.aiCredits,
        openrouterKeyHash: orKey.hash,
      },
    });
    logActivity(agentId, 'system', `Agent created on Fly app ${appName} with OpenRouter key (limit: $${orKey.limit}/mo)`);
    return agent;
  } catch (error) {
    if (orKeyHash) { try { await deleteKey(orKeyHash); } catch {} }
    if (machineId) { try { await deleteMachine(appName, machineId); } catch {} }
    try { await deleteApp(appName); } catch {}
    throw error;
  }
}

export async function listAgents(userId: string) {
  return prisma.agent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getAgentById(userId: string, agentId: string) {
  return prisma.agent.findFirst({
    where: { id: agentId, userId },
  });
}

export async function updateAgent(userId: string, agentId: string, updates: { program_md?: string | null; config?: Record<string, unknown> | null }) {
  const existing = await getAgentById(userId, agentId);
  if (!existing) throw new Error('Agent not found');

  return prisma.agent.update({
    where: { id: agentId },
    data: {
      programMd: updates.program_md ?? existing.programMd,
      config: updates.config === undefined ? existing.config : updates.config === null ? null : JSON.stringify(updates.config),
    },
  });
}

export async function startAgent(userId: string, agentId: string) {
  const agent = await getAgentById(userId, agentId);
  if (!agent?.flyAppName || !agent?.flyMachineId) throw new Error('Agent not found');
  await startMachine(agent.flyAppName, agent.flyMachineId);
  if (agent.openrouterKeyHash) { try { await enableKey(agent.openrouterKeyHash); } catch {} }
  const updated = await prisma.agent.update({ where: { id: agentId }, data: { status: 'running' } });
  logActivity(agentId, 'system', 'Agent started');
  return updated;
}

export async function stopAgent(userId: string, agentId: string) {
  const agent = await getAgentById(userId, agentId);
  if (!agent?.flyAppName || !agent?.flyMachineId) throw new Error('Agent not found');
  await stopMachine(agent.flyAppName, agent.flyMachineId);
  if (agent.openrouterKeyHash) { try { await disableKey(agent.openrouterKeyHash); } catch {} }
  const updated = await prisma.agent.update({ where: { id: agentId }, data: { status: 'stopped' } });
  logActivity(agentId, 'system', 'Agent stopped');
  return updated;
}

export async function deleteAgent(userId: string, agentId: string) {
  const agent = await getAgentById(userId, agentId);
  if (!agent?.flyAppName || !agent?.flyMachineId) throw new Error('Agent not found');
  // Revoke OpenRouter key
  if (agent.openrouterKeyHash) { try { await deleteKey(agent.openrouterKeyHash); } catch {} }
  await deleteMachine(agent.flyAppName, agent.flyMachineId);
  await deleteApp(agent.flyAppName);
  await prisma.activity.deleteMany({ where: { agentId } });
  await prisma.agent.delete({ where: { id: agentId } });
}

export async function getAgentStatus(userId: string, agentId: string) {
  const agent = await getAgentById(userId, agentId);
  if (!agent?.flyAppName || !agent?.flyMachineId) throw new Error('Agent not found');
  const fly = await getMachine(agent.flyAppName, agent.flyMachineId);
  return { agent, fly };
}

export async function getAgentLogs(userId: string, agentId: string) {
  const agent = await getAgentById(userId, agentId);
  if (!agent) throw new Error('Agent not found');
  return prisma.activity.findMany({
    where: { agentId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}
