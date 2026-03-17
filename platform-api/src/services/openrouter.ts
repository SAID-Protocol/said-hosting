/**
 * OpenRouter Key Management Service
 * Creates/manages per-agent API keys with spending limits via Management API
 */

const OPENROUTER_API = 'https://openrouter.ai/api/v1';

function getManagementKey(): string {
  const key = process.env.OPENROUTER_MANAGEMENT_KEY;
  if (!key) throw new Error('OPENROUTER_MANAGEMENT_KEY is required');
  return key;
}

function headers(): HeadersInit {
  return {
    Authorization: `Bearer ${getManagementKey()}`,
    'Content-Type': 'application/json',
  };
}

export interface OpenRouterKey {
  hash: string;
  key: string;          // Only returned on create
  name: string;
  label: string;
  disabled: boolean;
  limit: number | null;
  limit_remaining: number | null;
  limit_reset: string | null;
  usage: number;
  usage_daily: number;
  usage_weekly: number;
  usage_monthly: number;
  created_at: string;
}

export interface OpenRouterKeyInfo {
  hash: string;
  name: string;
  label: string;
  disabled: boolean;
  limit: number | null;
  limit_remaining: number | null;
  limit_reset: string | null;
  usage: number;
  usage_daily: number;
  usage_weekly: number;
  usage_monthly: number;
}

// Tier → OpenRouter credit limit (USD)
const TIER_CREDIT_LIMITS: Record<string, number> = {
  free: 1,
  starter: 5,
  pro: 15,
  power: 50,
};

/**
 * Create a per-agent OpenRouter API key with tier-based spending limit
 */
export async function createAgentKey(agentId: string, agentName: string, tier: string): Promise<{ key: string; hash: string; limit: number }> {
  const limit = TIER_CREDIT_LIMITS[tier] ?? TIER_CREDIT_LIMITS.starter;

  const res = await fetch(`${OPENROUTER_API}/keys`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      name: `said-agent-${agentId.slice(0, 8)}-${agentName.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 20)}`,
      limit,
      limitReset: 'monthly',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter create key failed (${res.status}): ${text}`);
  }

  const json = await res.json() as { data: OpenRouterKeyInfo; key: string };
  return {
    key: json.key,
    hash: json.data.hash,
    limit,
  };
}

/**
 * Get usage/status of an agent's OpenRouter key
 */
export async function getKeyInfo(keyHash: string): Promise<OpenRouterKeyInfo> {
  const res = await fetch(`${OPENROUTER_API}/keys/${keyHash}`, {
    headers: headers(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter get key failed (${res.status}): ${text}`);
  }

  const json = await res.json() as { data: OpenRouterKeyInfo };
  return json.data;
}

/**
 * Disable an agent's key (pause, not delete)
 */
export async function disableKey(keyHash: string): Promise<void> {
  const res = await fetch(`${OPENROUTER_API}/keys/${keyHash}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ disabled: true }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter disable key failed (${res.status}): ${text}`);
  }
}

/**
 * Re-enable an agent's key
 */
export async function enableKey(keyHash: string): Promise<void> {
  const res = await fetch(`${OPENROUTER_API}/keys/${keyHash}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ disabled: false }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter enable key failed (${res.status}): ${text}`);
  }
}

/**
 * Update key spending limit (e.g. on tier change)
 */
export async function updateKeyLimit(keyHash: string, newLimit: number): Promise<void> {
  const res = await fetch(`${OPENROUTER_API}/keys/${keyHash}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ limit: newLimit }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter update key failed (${res.status}): ${text}`);
  }
}

/**
 * Delete an agent's key permanently (on agent deletion)
 */
export async function deleteKey(keyHash: string): Promise<void> {
  const res = await fetch(`${OPENROUTER_API}/keys/${keyHash}`, {
    method: 'DELETE',
    headers: headers(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter delete key failed (${res.status}): ${text}`);
  }
}
