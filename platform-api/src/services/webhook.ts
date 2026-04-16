import crypto from 'crypto';
import { prisma } from '../db';

const WEBHOOK_TIMEOUT_MS = 10000;

export type WebhookEvent = 'agent.created' | 'agent.running' | 'agent.stopped' | 'agent.error' | 'agent.deleted';

interface WebhookPayload {
  event: WebhookEvent;
  agent_id: string;
  external_id: string | null;
  platform: string | null;
  partner_id: string | null;
  data: Record<string, unknown>;
  timestamp: string;
}

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export async function sendWebhook(agentId: string, event: WebhookEvent, data: Record<string, unknown> = {}) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent?.webhookUrl) return;

  const payload: WebhookPayload = {
    event,
    agent_id: agent.id,
    external_id: agent.externalId,
    platform: agent.platform,
    partner_id: agent.partnerId,
    data,
    timestamp: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);
  const secret = process.env.WEBHOOK_SIGNING_SECRET || process.env.API_KEY || '';
  const signature = signPayload(body, secret);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    const response = await fetch(agent.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': event,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[webhook] ${event} to ${agent.webhookUrl} failed: ${response.status}`);
    }
  } catch (err) {
    console.error(`[webhook] ${event} to ${agent.webhookUrl} error:`, err instanceof Error ? err.message : err);
  }
}
