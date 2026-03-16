import crypto from 'crypto';
import { prisma } from '../db';
import { CreateAgentRequest, TIER_CONFIGS } from '../types';
import { createApp, createMachine, createVolume, deleteApp, deleteMachine, getMachine, startMachine, stopMachine } from './fly';
import { createAgentKey, deleteKey, disableKey, enableKey } from './openrouter';
import { generateGatewayToken, hashGatewayToken } from '../utils/auth';
import { generateWorkspace, WorkspaceConfig } from './workspace';
import { confirmHostedAgent, fundAgentWallet, getFundingAmountUsdc, registerHostedAgent } from './said';
import { registerAgentMetaplex } from './metaplex';

function generateId(): string { return crypto.randomUUID(); }
function shortId(id: string): string { return id.replace(/-/g, '').slice(0, 8); }

function logActivity(agentId: string, type: string, data: string) {
  prisma.activity.create({ data: { agentId, type, data } }).catch(console.error);
}

function buildWorkspaceConfig(payload: CreateAgentRequest, tier: 'starter' | 'pro' | 'power'): WorkspaceConfig {
  const rawConfig = (payload.config ?? {}) as Record<string, unknown>;
  const personality = (rawConfig.personality ?? {}) as Record<string, unknown>;
  const spendingLimits = (rawConfig.spendingLimits ?? rawConfig.spending_limits ?? {}) as Record<string, unknown>;

  return {
    ...rawConfig,
    name: payload.name.trim(),
    template: typeof rawConfig.template === 'string' ? rawConfig.template : 'personal-assistant',
    personality: {
      communication: personality.communication as string | number | null | undefined
        ?? personality.style as string | number | null | undefined
        ?? rawConfig.communication as string | number | null | undefined,
      initiative: personality.initiative as string | number | null | undefined
        ?? rawConfig.initiative as string | number | null | undefined,
      detail: personality.detail as string | number | null | undefined
        ?? rawConfig.detail as string | number | null | undefined,
    },
    skills: Array.isArray(rawConfig.skills) ? rawConfig.skills.filter((skill): skill is string => typeof skill === 'string') : [],
    autonomy: typeof rawConfig.autonomy === 'string' ? rawConfig.autonomy : 'balanced',
    spendingLimits: {
      perAction: typeof spendingLimits.perAction === 'number' ? spendingLimits.perAction : typeof spendingLimits.per_action === 'number' ? spendingLimits.per_action : undefined,
      daily: typeof spendingLimits.daily === 'number' ? spendingLimits.daily : undefined,
      monthly: typeof spendingLimits.monthly === 'number' ? spendingLimits.monthly : undefined,
      currency: typeof spendingLimits.currency === 'string' ? spendingLimits.currency : 'USD',
    },
    customInstructions:
      typeof rawConfig.customInstructions === 'string'
        ? rawConfig.customInstructions
        : typeof rawConfig.custom_instructions === 'string'
          ? rawConfig.custom_instructions
          : typeof payload.program_md === 'string'
            ? payload.program_md
            : undefined,
    tier,
  };
}

export async function createAgent(userId: string, payload: CreateAgentRequest) {
  const agentId = generateId();
  const sid = shortId(agentId);
  const appName = `said-${sid}`;
  const volumeName = `data_${sid}`;
  const tier = payload.tier ?? 'starter';
  const tierConfig = TIER_CONFIGS[tier];
  const gatewayToken = generateGatewayToken();
  const gatewayTokenHash = hashGatewayToken(gatewayToken);

  if (!payload.name?.trim()) throw new Error('Agent name is required');

  const workspaceConfig = buildWorkspaceConfig(payload, tier);
  workspaceConfig.agentId = agentId;
  workspaceConfig.flyAppName = appName;
  workspaceConfig.createdAt = new Date().toISOString();
  const workspace = generateWorkspace(workspaceConfig);

  let machineId: string | null = null;
  let orKeyHash: string | null = null;
  try {
    const orKey = await createAgentKey(agentId, payload.name.trim(), tier);
    orKeyHash = orKey.hash;

    await createApp(appName);
    const volume = await createVolume(appName, volumeName, tierConfig.volumeSize);

    const machine = await createMachine({
      appName,
      agentId,
      tier,
      volumeId: volume.id,
      agentName: payload.name.trim(),
      agentDescription: payload.description || `Hosted SAID agent: ${payload.name.trim()}`,
      programMd: payload.program_md,
      config: payload.config ? JSON.stringify(payload.config) : undefined,
      workspaceFiles: JSON.stringify(workspace.files),
      openRouterKey: orKey.key,
      telegramToken: payload.telegram_token,
      gatewayToken,
    });
    machineId = machine.id;

    const agent = await prisma.agent.create({
      data: {
        id: agentId,
        name: payload.name.trim(),
        flyMachineId: machine.id,
        flyAppName: appName,
        status: 'running',
        tier,
        programMd: payload.program_md ?? null,
        config: payload.config ? JSON.stringify(payload.config) : null,
        gatewayTokenHash,
        aiCreditsLimit: tierConfig.aiCredits,
        openrouterKeyHash: orKey.hash,
        fundingStatus: 'pending',
        fundingAmountUsdc: getFundingAmountUsdc(tier),
        user: {
          connectOrCreate: {
            where: { id: userId },
            create: { id: userId, tier: 'pro' },
          },
        },
      },
    });
    logActivity(agentId, 'system', `Agent created on Fly app ${appName} with OpenRouter key (limit: $${orKey.limit}/mo)`);
    
    // Return agent with plaintext gateway token (only time it's exposed)
    return { ...agent, gatewayToken };
  } catch (error) {
    if (orKeyHash) { try { await deleteKey(orKeyHash); } catch {} }
    if (machineId) { try { await deleteMachine(appName, machineId); } catch {} }
    try { await deleteApp(appName); } catch {}
    throw error;
  }
}

export async function registerAgentSaid(agentId: string, walletAddress: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw new Error('Agent not found');

  const registration = await registerHostedAgent({
    wallet: walletAddress,
    name: agent.name,
    description: `Hosted SAID agent: ${agent.name}`,
    capabilities: ['messaging', 'web-search'],
  });

  if (!registration.success || !registration.unsignedTransaction) {
    throw new Error(registration.error || 'Failed to register SAID identity');
  }

  await prisma.agent.update({
    where: { id: agentId },
    data: {
      walletAddress,
      status: agent.status === 'creating' ? 'creating' : agent.status,
      saidRegistrationTx: registration.unsignedTransaction,
    },
  });

  logActivity(agentId, 'system', `Prepared SAID registration for wallet ${walletAddress}`);

  return {
    unsignedTransaction: registration.unsignedTransaction,
    saidPda: registration.pda ?? null,
  };
}

export async function confirmAgentSaid(agentId: string, signedTransaction: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw new Error('Agent not found');
  if (!agent.walletAddress) throw new Error('Agent wallet address missing');

  const confirmation = await confirmHostedAgent({
    signedTransaction,
    wallet: agent.walletAddress,
    name: agent.name,
    description: `Hosted SAID agent: ${agent.name}`,
    capabilities: ['messaging', 'web-search'],
  });
  if (!confirmation.success) {
    throw new Error(confirmation.error || 'Failed to confirm SAID identity');
  }

  const walletAddress = confirmation.wallet || agent.walletAddress;
  const saidPda = confirmation.saidPda || agent.saidPda;

  const updated = await prisma.agent.update({
    where: { id: agentId },
    data: {
      walletAddress,
      saidPda,
      saidRegistrationTx: null,
    },
  });

  logActivity(agentId, 'system', `Confirmed SAID registration${saidPda ? ` (${saidPda})` : ''}`);

  let funding = await fundAgentWallet(walletAddress || '', agent.tier);
  if (!walletAddress) {
    funding = {
      success: false,
      amountUsdc: getFundingAmountUsdc(agent.tier),
      error: 'Wallet address missing after SAID confirmation',
    };
  }

  const fundedAgent = await prisma.agent.update({
    where: { id: agentId },
    data: funding.success
      ? {
          fundingStatus: 'funded',
          fundingAmountUsdc: funding.amountUsdc,
          fundingSignature: funding.signature,
          fundingLastError: null,
          fundedAt: new Date(),
        }
      : {
          fundingStatus: 'failed',
          fundingAmountUsdc: funding.amountUsdc,
          fundingLastError: funding.error,
        },
  });

  if (funding.success) {
    logActivity(agentId, 'system', `Funded ${funding.amountUsdc} USDC (${funding.signature})`);
  } else {
    console.error(`[agents] Failed to fund agent ${agentId}: ${funding.error}`);
    logActivity(agentId, 'error', `USDC funding failed: ${funding.error}`);
  }

  // Metaplex Agent Registry — create NFT + register identity (non-blocking)
  let metaplex: { assetAddress?: string; registrationUri?: string } = {};
  if (walletAddress && process.env.PLATFORM_WALLET_KEYPAIR) {
    try {
      const metaplexResult = await registerAgentMetaplex({
        name: agent.name,
        description: `Hosted SAID agent: ${agent.name}`,
        walletAddress,
        capabilities: ['messaging', 'web-search'],
        tier: agent.tier,
        flyAppName: agent.flyAppName ?? undefined,
      });

      if (metaplexResult.success) {
        metaplex = {
          assetAddress: metaplexResult.assetAddress,
          registrationUri: metaplexResult.registrationUri,
        };
        await prisma.agent.update({
          where: { id: agentId },
          data: {
            metaplexAsset: metaplexResult.assetAddress,
            metaplexUri: metaplexResult.registrationUri,
          },
        });
        logActivity(agentId, 'system', `Metaplex NFT minted: ${metaplexResult.assetAddress}`);
      } else {
        console.error(`[agents] Metaplex registration failed for ${agentId}: ${metaplexResult.error}`);
        logActivity(agentId, 'warning', `Metaplex NFT mint failed: ${metaplexResult.error}`);
      }
    } catch (error) {
      console.error(`[agents] Metaplex error for ${agentId}:`, error);
      logActivity(agentId, 'warning', `Metaplex error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }

  return {
    agent: fundedAgent,
    saidPda,
    signature: confirmation.signature,
    funding,
    metaplex,
  };
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
