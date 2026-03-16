export interface User {
  id: string;
  privy_id: string | null;
  email: string | null;
  tier: 'starter' | 'pro' | 'power' | 'staker';
  said_pubkey: string | null;
  created_at: string;
}

export interface Agent {
  id: string;
  user_id: string;
  name: string;
  fly_machine_id: string | null;
  fly_app_name: string | null;
  status: 'creating' | 'running' | 'paused' | 'stopped' | 'error';
  tier: 'starter' | 'pro' | 'power';
  said_identity: string | null;
  program_md: string | null;
  config: string | null;
  ai_credits_used: number;
  ai_credits_limit: number;
  created_at: string;
  updated_at: string;
}

export interface ActivityItem {
  id: number;
  agent_id: string;
  type: 'message' | 'trade' | 'system' | 'error' | 'skill';
  data: string | null;
  created_at: string;
}

export interface CreateAgentRequest {
  name: string;
  description?: string;
  tier?: 'starter' | 'pro' | 'power';
  program_md?: string;
  config?: Record<string, unknown>;
  telegram_token?: string;
}

export type TierConfig = {
  cpu: string;
  memory: number;
  volumeSize: number;
  aiCredits: number;
};

export const TIER_CONFIGS: Record<string, TierConfig> = {
  starter: { cpu: 'performance-1x', memory: 2048, volumeSize: 1, aiCredits: 5 },
  pro: { cpu: 'performance-1x', memory: 2048, volumeSize: 5, aiCredits: 15 },
  power: { cpu: 'performance-1x', memory: 4096, volumeSize: 10, aiCredits: 50 },
};
