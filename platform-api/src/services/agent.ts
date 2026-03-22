import crypto from 'crypto';
import { prisma } from '../db';
import { CreateAgentRequest, TIER_CONFIGS } from '../types';
import { createContainer, deleteContainer, getContainer, startContainer, stopContainer, updateContainerEnv, updateContainerEnvBatch } from './hetzner-multi';
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

function buildWorkspaceConfig(payload: CreateAgentRequest, tier: 'free' | 'trial' | 'starter' | 'pro' | 'power'): WorkspaceConfig {
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
  console.log('[createAgent] telegram_token present:', !!payload.telegram_token, 'tier:', payload.tier);
  const agentId = generateId();
  
  // Get user with existing agents
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { agents: true } });
  
  if (!user) {
    throw new Error('User not found');
  }
  
  const existingAgents = user.agents.filter(a => a.status !== 'error');
  
  // Auto-start trial for first agent if user has no agents and no trial/subscription
  if (existingAgents.length === 0 && (user.billingStatus === 'none' || !user.billingStatus)) {
    console.log('[createAgent] Auto-starting trial for first agent');
    const { startTrial } = await import('./billing');
    await startTrial(userId, payload.tier || 'starter', 'all_inclusive');
    // Reload user to get updated billing status
    const updatedUser = await prisma.user.findUnique({ where: { id: userId }, include: { agents: true } });
    if (updatedUser) {
      Object.assign(user, updatedUser);
    }
  }
  
  let tier = payload.tier ?? 'starter';
  
  if (user.billingStatus === 'trial') {
    // Trial users limited to 1 agent, but check if they have funds to upgrade
    if (existingAgents.length >= 1) {
      // Check if user has sufficient USDC to pay for this agent
      if (user.privyWalletAddress) {
        const { getWalletUsdcBalance } = await import('./billing');
        const balance = await getWalletUsdcBalance(user.privyWalletAddress);
        const monthlyPrice = 29; // Starter tier minimum
        
        if (balance >= monthlyPrice) {
          console.log('[createAgent] User has funds - upgrading trial agent to paid tier');
          
          // Find trial agent and upgrade it
          const trialAgent = existingAgents.find(a => a.tier === 'trial');
          if (trialAgent) {
            const { deleteKey, createAgentKey } = await import('./openrouter');
            const upgradeTier = payload.tier || 'starter'; // Use selected tier
            
            // Delete old $5 trial key
            if (trialAgent.openrouterKeyHash) {
              try {
                await deleteKey(trialAgent.openrouterKeyHash);
                console.log('[createAgent] Deleted trial OpenRouter key');
              } catch (err) {
                console.warn('[createAgent] Failed to delete trial key:', err);
              }
            }
            
            // Create new key with proper monthly limit
            const { hash: newKeyHash } = await createAgentKey(trialAgent.id, trialAgent.name, upgradeTier);
            
            // Update agent: tier + new key
            await prisma.agent.update({
              where: { id: trialAgent.id },
              data: {
                tier: upgradeTier,
                openrouterKeyHash: newKeyHash,
              },
            });
            
            console.log(`[createAgent] Upgraded trial agent ${trialAgent.id} from trial → ${upgradeTier}`);
          }
          
          // Update billing status to active
          await prisma.user.update({
            where: { id: userId },
            data: {
              billingStatus: 'active',
            },
          });
          user.billingStatus = 'active';
          // Continue to create 2nd agent with selected tier
        } else {
          throw new Error(`Trial limited to 1 agent. Add at least $${monthlyPrice} USDC to your wallet to create more agents.`);
        }
      } else {
        throw new Error('Trial limited to 1 agent. Add funds to your wallet to create more agents.');
      }
    } else {
      tier = 'trial';
      console.log('[createAgent] User on trial - overriding tier to "trial"');
    }
  } else if (user.billingStatus === 'none' || user.billingStatus === 'paused' || user.billingStatus === 'cancelled') {
    // Post-trial: require active subscription or grace period
    throw new Error('Please add funds to create agents. Visit billing settings to activate your subscription.');
  }
  
  const tierConfig = TIER_CONFIGS[tier];
  const gatewayToken = generateGatewayToken();
  const gatewayTokenHash = hashGatewayToken(gatewayToken);

  if (!payload.name?.trim()) throw new Error('Agent name is required');

  const workspaceConfig = buildWorkspaceConfig(payload, tier);
  workspaceConfig.agentId = agentId;
  workspaceConfig.flyAppName = `hetzner-${agentId.slice(0, 8)}`;
  workspaceConfig.createdAt = new Date().toISOString();
  const workspace = generateWorkspace(workspaceConfig);

  let containerId: string | null = null;
  let orKeyHash: string | null = null;
  try {
    // Use custom API key if provided, otherwise create a managed OpenRouter key
    let apiKey: string;
    if (payload.custom_api_key?.trim()) {
      apiKey = payload.custom_api_key.trim();
      console.log('[createAgent] Using custom API key (user-provided)');
    } else {
      const orKey = await createAgentKey(agentId, payload.name.trim(), tier);
      orKeyHash = orKey.hash;
      apiKey = orKey.key;
      console.log('[createAgent] Using managed OpenRouter key');
    }

    // Create DB record FIRST so bootstrap can find it when container starts
    const agent = await prisma.agent.create({
      data: {
        id: agentId,
        name: payload.name.trim(),
        status: 'creating',
        tier,
        programMd: payload.program_md ?? null,
        config: payload.config ? JSON.stringify(payload.config) : null,
        gatewayTokenHash,
        aiCreditsLimit: tierConfig.aiCredits,
        openrouterKeyHash: orKeyHash,
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
    console.log('[createAgent] ✅ Database record created for agent:', agentId);

    // Now deploy the container — bootstrap will call /register-said which needs the DB record
    const container = await createContainer({
      agentId,
      tier,
      agentName: payload.name.trim(),
      agentDescription: payload.description || `Hosted SAID agent: ${payload.name.trim()}`,
      programMd: payload.program_md,
      config: payload.config ? JSON.stringify(payload.config) : undefined,
      workspaceFiles: JSON.stringify(workspace.files),
      openRouterKey: apiKey,
      telegramToken: payload.telegram_token,
      gatewayToken,
    });
    containerId = container.id;
    console.log('[createAgent] Container deployed:', container.id, 'on', container.hostIp);

    // Update DB record with container info
    const updatedAgent = await prisma.agent.update({
      where: { id: agentId },
      data: {
        flyMachineId: container.id,
        flyAppName: `hetzner:${container.port}`,
        hostIp: container.hostIp,
        status: 'running',
      },
    });

    logActivity(agentId, 'system', `Agent created on Hetzner (port ${container.port})${payload.custom_api_key ? ' with custom API key' : ' with managed OpenRouter key'}`);
    
    // Return agent with plaintext gateway token (only time it's exposed)
    return { ...updatedAgent, gatewayToken };
  } catch (error) {
    if (orKeyHash) { try { await deleteKey(orKeyHash); } catch {} }
    // Clean up orphaned DB record if container creation failed
    try { await prisma.agent.delete({ where: { id: agentId } }); } catch {}
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

export async function updateAgent(userId: string, agentId: string, updates: { program_md?: string | null; config?: Record<string, unknown> | null; name?: string; anthropic_key?: string; openai_key?: string; openrouter_key?: string }) {
  const existing = await getAgentById(userId, agentId);
  if (!existing) throw new Error('Agent not found');

  // Update API keys on the container if provided
  const keyUpdates: [string, string][] = [];
  if (updates.anthropic_key?.trim()) keyUpdates.push(['ANTHROPIC_API_KEY', updates.anthropic_key.trim()]);
  if (updates.openai_key?.trim()) keyUpdates.push(['OPENAI_API_KEY', updates.openai_key.trim()]);
  if (updates.openrouter_key?.trim()) keyUpdates.push(['OPENROUTER_API_KEY', updates.openrouter_key.trim()]);

  if (keyUpdates.length > 0 && existing.hostIp) {
    try {
      await updateContainerEnvBatch(agentId, existing.hostIp, keyUpdates);
      const providers = keyUpdates.map(([k]) => k.replace('_API_KEY', '').toLowerCase()).join(', ');
      logActivity(agentId, 'system', `API keys updated: ${providers}`);
    } catch (err) {
      console.error('[updateAgent] Failed to update container API keys:', err);
      throw new Error('Failed to update API keys on container');
    }
  }

  return prisma.agent.update({
    where: { id: agentId },
    data: {
      name: updates.name ?? existing.name,
      programMd: updates.program_md ?? existing.programMd,
      config: updates.config === undefined ? existing.config : updates.config === null ? null : JSON.stringify(updates.config),
    },
  });
}

export async function startAgent(userId: string, agentId: string) {
  const agent = await getAgentById(userId, agentId);
  if (!agent) throw new Error('Agent not found');
  if (!agent.hostIp) throw new Error('Agent host IP missing');
  await startContainer(agentId, agent.hostIp);
  if (agent.openrouterKeyHash) { try { await enableKey(agent.openrouterKeyHash); } catch {} }
  const updated = await prisma.agent.update({ where: { id: agentId }, data: { status: 'running' } });
  logActivity(agentId, 'system', 'Agent started');
  return updated;
}

export async function stopAgent(userId: string, agentId: string) {
  const agent = await getAgentById(userId, agentId);
  if (!agent) throw new Error('Agent not found');
  if (!agent.hostIp) throw new Error('Agent host IP missing');
  await stopContainer(agentId, agent.hostIp);
  if (agent.openrouterKeyHash) { try { await disableKey(agent.openrouterKeyHash); } catch {} }
  const updated = await prisma.agent.update({ where: { id: agentId }, data: { status: 'stopped' } });
  logActivity(agentId, 'system', 'Agent stopped');
  return updated;
}

export async function deleteAgent(userId: string, agentId: string) {
  const agent = await getAgentById(userId, agentId);
  if (!agent) throw new Error('Agent not found');
  if (agent.openrouterKeyHash) { try { await deleteKey(agent.openrouterKeyHash); } catch {} }
  if (agent.hostIp) { await deleteContainer(agentId, agent.hostIp); }
  await prisma.activity.deleteMany({ where: { agentId } });
  await prisma.agent.delete({ where: { id: agentId } });
}

export async function getAgentStatus(userId: string, agentId: string) {
  const agent = await getAgentById(userId, agentId);
  if (!agent) throw new Error('Agent not found');
  if (!agent.hostIp) throw new Error('Agent host IP missing');
  const container = await getContainer(agentId, agent.hostIp);
  return { agent, container };
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
