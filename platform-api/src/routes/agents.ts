import { Router } from 'express';
import { createAgent, deleteAgent, getAgentById, getAgentLogs, getAgentStatus, listAgents, startAgent, stopAgent, updateAgent, registerAgentSaid, confirmAgentSaid } from '../services/agent';
import { CreateAgentRequest } from '../types';
import { getKeyInfo } from '../services/openrouter';

export const agentRouter = Router();

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

agentRouter.get('/:id/usage', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const agent = await getAgentById(userId, req.params.id);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    if (!agent.openrouterKeyHash) { res.json({ llm: null, message: 'No OpenRouter key configured' }); return; }

    const keyInfo = await getKeyInfo(agent.openrouterKeyHash);
    res.json({
      llm: {
        provider: 'openrouter',
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

    // Add timeout to fetch (180 seconds — first message reads workspace files and can be slow)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180000);

    try {
      // Route to Hetzner container or legacy Fly app
      const isHetzner = agent.flyAppName?.startsWith('hetzner:');
      const port = isHetzner ? agent.flyAppName.split(':')[1] : null;
      const chatUrl = isHetzner 
        ? `http://${process.env.HETZNER_HOST || '87.99.140.184'}:${port}/v1/chat/completions`
        : `https://${agent.flyAppName}.fly.dev/v1/chat/completions`;

      const response = await fetch(chatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providedToken}`,
        },
        body: JSON.stringify({
          model: (agent.tier === 'pro' || agent.tier === 'power') 
            ? 'openrouter/anthropic/claude-sonnet-4-5' 
            : 'openrouter/anthropic/claude-sonnet-4-5',
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
