import { Router } from 'express';
import { createAgent, deleteAgent, getAgentById, getAgentLogs, getAgentStatus, listAgents, startAgent, stopAgent, updateAgent, registerAgentSaid, confirmAgentSaid } from '../services/agent';
import { CreateAgentRequest } from '../types';
import { getKeyInfo } from '../services/openrouter';
import { prisma } from '../db';

export const agentRouter = Router();

// Lightweight: store wallet address from container boot (no on-chain registration)
agentRouter.post('/:id/report-wallet', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const walletAddress = req.body?.walletAddress;
    if (typeof walletAddress !== 'string' || !walletAddress.trim()) {
      res.status(400).json({ error: 'walletAddress is required' });
      return;
    }

    const agent = await prisma.agent.findUnique({ where: { id: req.params.id } });
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Query on-chain SAID identity
    let saidPda: string | null = null;
    let saidVerified = false;
    let saidRegistered = false;
    try {
      const { PublicKey, Connection } = await import('@solana/web3.js');
      const SAID_PROGRAM_ID = new PublicKey('5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G');
      const walletPubkey = new PublicKey(walletAddress.trim());
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('agent'), walletPubkey.toBuffer()],
        SAID_PROGRAM_ID
      );
      saidPda = pda.toString();

      // Check if PDA account exists on-chain
      const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
      const connection = new Connection(rpcUrl);
      const accountInfo = await connection.getAccountInfo(pda);
      
      if (accountInfo && accountInfo.data) {
        saidRegistered = true;
        // SAID AgentIdentity layout (Anchor/Borsh):
        // 8 (discriminator) + 32 (owner) + 32 (authority) + 4+N (metadata_uri string) + 8 (created_at i64) + 1 (is_verified bool) + ...
        const data = accountInfo.data;
        if (data.length > 72) {
          let offset = 8 + 32 + 32; // skip discriminator + owner + authority = 72
          // Read metadata_uri (Borsh string: 4 byte LE length + string bytes)
          const uriLen = data.readUInt32LE(offset);
          offset += 4 + uriLen;
          // Skip created_at (i64, 8 bytes)
          offset += 8;
          // Read is_verified (bool, 1 byte)
          if (offset < data.length) {
            saidVerified = data[offset] === 1;
          }
        }
        console.log(`[report-wallet] On-chain SAID: pda=${saidPda} registered=${saidRegistered} verified=${saidVerified}`);
      } else {
        console.log(`[report-wallet] No on-chain SAID account found for ${walletAddress.trim()}`);
      }
    } catch (e) {
      console.error('[report-wallet] Failed to query on-chain SAID:', e);
    }

    await prisma.agent.update({
      where: { id: req.params.id },
      data: { 
        walletAddress: walletAddress.trim(), 
        ...(saidPda ? { saidPda } : {}),
        saidRegistered,
        saidVerified,
      },
    });

    res.json({ 
      ok: true, 
      walletAddress: walletAddress.trim(), 
      saidPda,
      saidRegistered,
      saidVerified,
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed' });
  }
});

// Agent-reported events (called from inside container via entrypoint/hooks)
agentRouter.post('/:id/report-event', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const agent = await prisma.agent.findUnique({ where: { id: req.params.id } });
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const { type, data } = req.body || {};
    const validTypes = ['message_sent', 'message_received', 'heartbeat', 'boot', 'shutdown', 'error', 'tool_call', 'transaction', 'system'];
    if (!type || !validTypes.includes(type)) {
      res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
      return;
    }

    // Rate limit: max 1 heartbeat per 5 min, 100 other events per hour
    if (type === 'heartbeat') {
      const recent = await prisma.activity.findFirst({
        where: { agentId: agent.id, type: 'heartbeat', createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
      });
      if (recent) {
        res.json({ ok: true, deduplicated: true });
        return;
      }
    }

    await prisma.activity.create({
      data: {
        agentId: agent.id,
        type,
        data: typeof data === 'string' ? data : data ? JSON.stringify(data) : null,
      },
    });

    // Update agent's updatedAt as a "last active" signal
    await prisma.agent.update({
      where: { id: agent.id },
      data: { updatedAt: new Date() },
    });

    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed' });
  }
});

agentRouter.post('/:id/register-said', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const walletAddress = req.body?.walletAddress;
    if (typeof walletAddress !== 'string' || !walletAddress.trim()) {
      res.status(400).json({ error: 'walletAddress is required' });
      return;
    }

    const result = await registerAgentSaid(req.params.id, walletAddress.trim());
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to register SAID identity' });
  }
});

agentRouter.post('/:id/confirm-said', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const signedTransaction = req.body?.signedTransaction;
    if (typeof signedTransaction !== 'string' || !signedTransaction.trim()) {
      res.status(400).json({ error: 'signedTransaction is required' });
      return;
    }

    const result = await confirmAgentSaid(req.params.id, signedTransaction.trim());
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to confirm SAID identity' });
  }
});

agentRouter.use(async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey === process.env.API_KEY) {
    (req as typeof req & { userId: string }).userId = 'default-user';
    next();
    return;
  }

  const { authMiddleware } = await import('../middleware/auth');
  return authMiddleware(req, res, next);
});

agentRouter.post('/', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const payload = req.body as CreateAgentRequest;

    // Guard: prevent duplicate agents with the same Telegram bot token
    if (payload.telegram_token) {
      const existing = await listAgents(userId);
      const duplicate = existing.find((a: any) => a.telegramBotToken === payload.telegram_token);
      if (duplicate) {
        res.status(409).json({ 
          error: 'An agent with this Telegram bot token already exists',
          existingAgentId: duplicate.id,
          existingAgentName: duplicate.name
        });
        return;
      }
    }

    const agent = await createAgent(userId, payload);
    res.status(201).json(agent);
  } catch (error) {
    console.error('[createAgent] FAILED:', error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error('[createAgent] Stack trace:', error.stack);
    }
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to create agent' });
  }
});

agentRouter.get('/', async (req, res) => {
  const userId = (req as typeof req & { userId: string }).userId;
  res.json(await listAgents(userId));
});

agentRouter.get('/:id', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const agent = await getAgentById(userId, req.params.id);

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const status = await getAgentStatus(userId, req.params.id);
    res.json(status);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to fetch agent' });
  }
});

agentRouter.patch('/:id', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    
    // Block API key updates for free/trial tiers
    const hasKeyUpdate = req.body.anthropic_key || req.body.openai_key || req.body.openrouter_key;
    if (hasKeyUpdate) {
      const existing = await getAgentById(userId, req.params.id);
      if (existing && (existing.tier === 'free' || existing.tier === 'trial')) {
        return res.status(403).json({ 
          error: 'API key customization requires a paid plan. Upgrade to Starter ($29/mo) or higher.' 
        });
      }
    }
    
    const agent = await updateAgent(userId, req.params.id, {
      program_md: req.body.program_md,
      config: req.body.config,
      name: req.body.name,
      anthropic_key: req.body.anthropic_key,
      openai_key: req.body.openai_key,
      openrouter_key: req.body.openrouter_key,
    });
    res.json(agent);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update agent';
    res.status(message === 'Agent not found' ? 404 : 400).json({ error: message });
  }
});

agentRouter.post('/:id/start', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const agent = await startAgent(userId, req.params.id);
    res.json(agent);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start agent';
    res.status(message === 'Agent not found' ? 404 : 400).json({ error: message });
  }
});

agentRouter.post('/:id/stop', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const agent = await stopAgent(userId, req.params.id);
    res.json(agent);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to stop agent';
    res.status(message === 'Agent not found' ? 404 : 400).json({ error: message });
  }
});

agentRouter.delete('/:id', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    await deleteAgent(userId, req.params.id);
    res.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete agent';
    res.status(message === 'Agent not found' ? 404 : 400).json({ error: message });
  }
});

agentRouter.get('/:id/logs', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    res.json(await getAgentLogs(userId, req.params.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch logs';
    res.status(message === 'Agent not found' ? 404 : 400).json({ error: message });
  }
});

agentRouter.get('/:id/api-key', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const agent = await getAgentById(userId, req.params.id);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    if (!agent.gatewayToken) {
      res.json({ gatewayToken: null });
      return;
    }

    res.json({ gatewayToken: agent.gatewayToken });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch API key' });
  }
});

agentRouter.post('/:id/rotate-key', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const agent = await getAgentById(userId, req.params.id);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    const { generateGatewayToken, hashGatewayToken } = await import('../utils/auth');
    const newToken = generateGatewayToken();
    const newHash = hashGatewayToken(newToken);

    await prisma.agent.update({
      where: { id: req.params.id },
      data: { gatewayToken: newToken, gatewayTokenHash: newHash },
    });

    res.json({ gatewayToken: newToken });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to rotate key' });
  }
});

agentRouter.get('/:id/usage', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const agent = await getAgentById(userId, req.params.id);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    // Trial agents use z.ai proxy with prompt-based quota
    if (agent.tier === 'trial') {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      res.json({
        llm: {
          provider: 'z-ai',
          unit: 'prompts',
          used: user?.trialPromptsUsed ?? 0,
          limit: user?.trialPromptsLimit ?? 500,
          remaining: Math.max(0, (user?.trialPromptsLimit ?? 500) - (user?.trialPromptsUsed ?? 0)),
        },
        tier: 'trial',
      });
      return;
    }

    if (!agent.openrouterKeyHash) { res.json({ llm: null, message: 'No OpenRouter key configured' }); return; }

    const keyInfo = await getKeyInfo(agent.openrouterKeyHash);
    res.json({
      llm: {
        provider: 'openrouter',
        unit: 'credits',
        limit: keyInfo.limit,
        used: keyInfo.usage,
        remaining: keyInfo.limit_remaining,
        usage_daily: keyInfo.usage_daily,
        usage_weekly: keyInfo.usage_weekly,
        usage_monthly: keyInfo.usage_monthly,
        disabled: keyInfo.disabled,
      },
      tier: agent.tier,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch usage' });
  }
});

agentRouter.post('/:id/chat', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const agent = await getAgentById(userId, req.params.id);

    if (!agent?.flyAppName) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Support both new messages array format and legacy single message format
    let messages: Array<{ role: string; content: string }>;
    
    if (Array.isArray(req.body?.messages)) {
      // New format: full conversation history
      messages = req.body.messages;
      if (messages.length === 0 || !messages.every(m => m.role && m.content)) {
        res.status(400).json({ error: 'messages array must contain valid {role, content} objects' });
        return;
      }
    } else if (typeof req.body?.message === 'string' && req.body.message.trim()) {
      // Legacy format: single message (backwards compatibility)
      messages = [{ role: 'user', content: req.body.message }];
    } else {
      res.status(400).json({ error: 'Either message (string) or messages (array) is required' });
      return;
    }

    // Require gateway token from client
    const providedToken = req.headers['x-gateway-token'] as string | undefined;
    if (!providedToken) {
      res.status(401).json({ error: 'x-gateway-token header is required' });
      return;
    }

    // Verify token against stored hash
    const { verifyGatewayToken } = await import('../utils/auth');
    if (!agent.gatewayTokenHash || !verifyGatewayToken(providedToken, agent.gatewayTokenHash)) {
      res.status(403).json({ error: 'Invalid gateway token' });
      return;
    }

    // Power tier gets longer timeout (Opus responses can be slow)
    const timeoutMs = (agent.tier === 'power' || agent.tier === 'pro') ? 300000 : 180000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Route to Hetzner container or legacy Fly app
      const isHetzner = agent.flyAppName?.startsWith('hetzner:');
      const port = isHetzner ? agent.flyAppName.split(':')[1] : null;
      const chatUrl = isHetzner 
        ? `http://${agent.hostIp || process.env.HETZNER_HOST || '87.99.140.184'}:${port}/v1/chat/completions`
        : `https://${agent.flyAppName}.fly.dev/v1/chat/completions`;

      // Trial agents use z.ai proxy (openai/gpt-4o), all others use OpenRouter
      const chatModel = agent.tier === 'trial'
        ? 'openai/gpt-4o'
        : 'openrouter/anthropic/claude-sonnet-4-5';

      const response = await fetch(chatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providedToken}`,
        },
        body: JSON.stringify({
          model: chatModel,
          messages: messages,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const text = await response.text();
      let data: unknown = text;
      try { data = JSON.parse(text); } catch {}

      res.status(response.status).json({ ok: response.ok, data });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      // Connection refused = container still booting
      const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('UND_ERR_CONNECT_TIMEOUT')) {
        res.status(503).json({ 
          error: 'Agent is still starting up. Please try again in a few seconds.',
          retryAfter: 5
        });
        return;
      }
      throw fetchError;
    }
  } catch (error) {
    console.error('[chat proxy error]', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Failed to proxy chat',
      details: error instanceof Error ? error.stack : undefined
    });
  }
});
