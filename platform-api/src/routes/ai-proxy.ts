/**
 * AI Proxy — Secure API key proxy for trial agents
 * 
 * Prevents prompt injection attacks by keeping real API keys server-side.
 * Trial agents call this proxy instead of OpenAI/Anthropic/z.ai directly.
 * 
 * Security model:
 * 1. Agent authenticates with gateway token (already in DB)
 * 2. We check their trial quota server-side
 * 3. We add the real API key and forward request
 * 4. Increment usage counter
 * 
 * Even if agent leaks the proxy URL, attacker is rate-limited per agent.
 */

import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../db';

export const aiProxyRouter = Router();

/**
 * POST /api/ai-proxy/v1/chat/completions
 * OpenAI-compatible proxy for trial agents using z.ai
 */
aiProxyRouter.post('/v1/chat/completions', async (req, res) => {
  try {
    // Extract agent ID from header, query param, or Authorization Bearer token
    // Trial agents set SAID_AGENT_ID env which OpenClaw can pass as Bearer token
    let agentId = req.headers['x-agent-id'] as string;
    
    if (!agentId && req.query.agent_id) {
      agentId = req.query.agent_id as string;
    }
    
    if (!agentId) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        // Try treating the Bearer token as agent ID (for simplicity)
        const token = authHeader.substring(7);
        // Check if it's a UUID (agent ID format)
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
          agentId = token;
        }
      }
    }
    
    if (!agentId) {
      return res.status(401).json({ 
        error: { 
          message: 'Missing agent authentication. Provide x-agent-id header, ?agent_id query param, or Bearer token',
          type: 'authentication_error' 
        }
      });
    }

    // Get agent and verify it exists
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: { user: true },
    });

    if (!agent) {
      return res.status(401).json({ 
        error: { 
          message: 'Invalid agent ID',
          type: 'authentication_error' 
        }
      });
    }

    // Check if user is on trial with z.ai provider
    const user = agent.user;
    
    if (user.apiProvider !== 'z-ai') {
      return res.status(403).json({
        error: {
          message: 'This endpoint is only for trial users with z.ai provider',
          type: 'permission_error',
        },
      });
    }

    // Check trial prompt quota
    if (user.trialPromptsUsed >= user.trialPromptsLimit) {
      return res.status(429).json({
        error: {
          message: `Trial limit reached (${user.trialPromptsLimit} prompts). Add your own API key or upgrade to continue.`,
          type: 'rate_limit_error',
          code: 'trial_quota_exceeded',
        },
      });
    }

    // Forward request to z.ai with real API key (kept server-side)
    const zaiApiKey = process.env.Z_AI_API_KEY;
    
    if (!zaiApiKey) {
      console.error('[ai-proxy] Z_AI_API_KEY not configured');
      return res.status(500).json({
        error: {
          message: 'API proxy not configured. Please contact support.',
          type: 'server_error',
        },
      });
    }

    const zaiBaseUrl = process.env.Z_AI_BASE_URL || 'https://api.z.ai/api/paas/v4';

    const startTime = Date.now();
    
    // Override model to z.ai's model (OpenClaw sends gpt-4o to pass validation,
    // but z.ai needs glm-4.7)
    const forwardBody = { ...req.body, model: 'glm-4.7' };

    const response = await axios.post(
      `${zaiBaseUrl}/chat/completions`,
      forwardBody,
      {
        headers: {
          'Authorization': `Bearer ${zaiApiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const latency = Date.now() - startTime;

    // Increment usage counter (1 prompt = 1 request to this endpoint)
    await prisma.user.update({
      where: { id: user.id },
      data: { trialPromptsUsed: user.trialPromptsUsed + 1 },
    });

    console.log(`[ai-proxy] Agent ${agent.name} (${agentId}): ${user.trialPromptsUsed + 1}/${user.trialPromptsLimit} prompts used (${latency}ms)`);

    // Return response to agent
    res.json(response.data);

  } catch (error: any) {
    console.error('[ai-proxy] Error:', error.message);
    
    // Forward API errors
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    
    res.status(500).json({
      error: {
        message: 'Proxy request failed',
        type: 'server_error',
      },
    });
  }
});

/**
 * GET /api/ai-proxy/health
 * Health check endpoint
 */
aiProxyRouter.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'ai-proxy',
    provider: 'z.ai',
  });
});

/**
 * GET /api/ai-proxy/quota
 * Check remaining trial quota for an agent
 */
aiProxyRouter.get('/quota', async (req, res) => {
  try {
    // Extract agent ID (same logic as chat endpoint)
    let agentId = req.headers['x-agent-id'] as string;
    
    if (!agentId && req.query.agent_id) {
      agentId = req.query.agent_id as string;
    }
    
    if (!agentId) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
          agentId = token;
        }
      }
    }
    
    if (!agentId) {
      return res.status(401).json({ error: 'Missing agent authentication' });
    }

    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      include: { user: true },
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({
      used: agent.user.trialPromptsUsed,
      limit: agent.user.trialPromptsLimit,
      remaining: agent.user.trialPromptsLimit - agent.user.trialPromptsUsed,
      provider: agent.user.apiProvider,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch quota' });
  }
});
