import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { createAgent, deleteAgent, getAgentById, getAgentLogs, getAgentStatus, listAgents, startAgent, stopAgent, updateAgent } from '../services/agent';
import { CreateAgentRequest } from '../types';

export const agentRouter = Router();

agentRouter.use(authMiddleware);

agentRouter.post('/', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const payload = req.body as CreateAgentRequest;
    const agent = await createAgent(userId, payload);
    res.status(201).json(agent);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to create agent' });
  }
});

agentRouter.get('/', (req, res) => {
  const userId = (req as typeof req & { userId: string }).userId;
  res.json(listAgents(userId));
});

agentRouter.get('/:id', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const agent = getAgentById(userId, req.params.id);

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

agentRouter.patch('/:id', (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const agent = updateAgent(userId, req.params.id, {
      program_md: req.body.program_md,
      config: req.body.config,
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

agentRouter.get('/:id/logs', (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    res.json(getAgentLogs(userId, req.params.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch logs';
    res.status(message === 'Agent not found' ? 404 : 400).json({ error: message });
  }
});

agentRouter.post('/:id/chat', async (req, res) => {
  try {
    const userId = (req as typeof req & { userId: string }).userId;
    const agent = getAgentById(userId, req.params.id);

    if (!agent?.fly_app_name) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const message = req.body?.message;
    if (typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const response = await fetch(`https://${agent.fly_app_name}.fly.dev/hooks/wake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });

    const text = await response.text();
    let data: unknown = text;

    try {
      data = JSON.parse(text);
    } catch {
      // non-JSON response is fine
    }

    res.status(response.status).json({ ok: response.ok, data });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to proxy chat' });
  }
});
