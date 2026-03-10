import { TIER_CONFIGS } from '../types';

const FLY_API_BASE = 'https://api.machines.dev/v1';
const AGENT_IMAGE = 'registry.fly.io/said-agent-test:deployment-01KKAVJWJ8ZV3TJTWARQBW4YED';

type TierKey = 'starter' | 'pro' | 'power';

type FlyMachineResponse = {
  id: string;
  name?: string;
  state?: string;
  status?: string;
  config?: unknown;
  [key: string]: unknown;
};

type FlyVolumeResponse = {
  id: string;
  name: string;
  region: string;
};

type FlyAppResponse = {
  name: string;
  organization?: { slug?: string };
};

function getHeaders(): HeadersInit {
  const token = process.env.FLY_API_TOKEN;

  if (!token) {
    throw new Error('FLY_API_TOKEN is required');
  }

  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function flyRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${FLY_API_BASE}${path}`, {
    ...init,
    headers: {
      ...getHeaders(),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Fly API error ${response.status}: ${text}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function normalizeCpuKind(cpu: string): 'shared' | 'performance' {
  return cpu.startsWith('shared') ? 'shared' : 'performance';
}

function normalizeCpuCount(cpu: string): number {
  if (cpu.includes('2x')) {
    return 2;
  }
  return 1;
}

export async function createApp(appName: string): Promise<FlyAppResponse> {
  const org = process.env.FLY_ORG;

  if (!org) {
    throw new Error('FLY_ORG is required');
  }

  return flyRequest<FlyAppResponse>('/apps', {
    method: 'POST',
    body: JSON.stringify({
      app_name: appName,
      org_slug: org,
    }),
  });
}

export async function createVolume(appName: string, volumeName: string, sizeGb: number): Promise<FlyVolumeResponse> {
  return flyRequest<FlyVolumeResponse>(`/apps/${appName}/volumes`, {
    method: 'POST',
    body: JSON.stringify({
      name: volumeName,
      region: 'ord',
      size_gb: sizeGb,
    }),
  });
}

export async function createMachine(params: {
  appName: string;
  agentId: string;
  tier: TierKey;
  volumeId: string;
  agentName?: string;
  agentDescription?: string;
  programMd?: string;
  config?: string;
  openRouterKey?: string;
  gatewayToken: string; // Required: plaintext token for container env
}): Promise<FlyMachineResponse> {
  const tierConfig = TIER_CONFIGS[params.tier];
  const gatewayToken = params.gatewayToken;

  return flyRequest<FlyMachineResponse>(`/apps/${params.appName}/machines`, {
    method: 'POST',
    body: JSON.stringify({
      config: {
        image: AGENT_IMAGE,
        env: {
          SAID_AGENT_ID: params.agentId,
          SAID_AGENT_NAME: params.agentName ?? 'SAID Agent',
          SAID_AGENT_DESCRIPTION: params.agentDescription ?? '',
          SAID_PLATFORM_API: 'https://said-platform-api.fly.dev',
          SAID_PLATFORM_API_KEY: process.env.API_KEY ?? '',
          OPENCLAW_GATEWAY_TOKEN: gatewayToken,
          OPENROUTER_API_KEY: params.openRouterKey ?? '',
          PROGRAM_MD: params.programMd ?? '',
          AGENT_CONFIG_JSON: params.config ?? '{}',
        },
        guest: {
          cpu_kind: normalizeCpuKind(tierConfig.cpu),
          cpus: normalizeCpuCount(tierConfig.cpu),
          memory_mb: tierConfig.memory,
        },
        services: [
          {
            ports: [
              {
                port: 443,
                handlers: ['tls', 'http'],
              },
              {
                port: 80,
                handlers: ['http'],
              },
            ],
            protocol: 'tcp',
            internal_port: 18789,
            autostart: true,
            autostop: 'off',
          },
        ],
        mounts: [
          {
            volume: params.volumeId,
            path: '/data',
          },
        ],
        restart: {
          policy: 'on-failure',
        },
      },
    }),
  });
}

export async function startMachine(appName: string, machineId: string): Promise<void> {
  await flyRequest<void>(`/apps/${appName}/machines/${machineId}/start`, {
    method: 'POST',
  });
}

export async function stopMachine(appName: string, machineId: string): Promise<void> {
  await flyRequest<void>(`/apps/${appName}/machines/${machineId}/stop`, {
    method: 'POST',
  });
}

export async function deleteMachine(appName: string, machineId: string): Promise<void> {
  await flyRequest<void>(`/apps/${appName}/machines/${machineId}`, {
    method: 'DELETE',
  });
}

export async function getMachine(appName: string, machineId: string): Promise<FlyMachineResponse> {
  return flyRequest<FlyMachineResponse>(`/apps/${appName}/machines/${machineId}`);
}

export async function deleteApp(appName: string): Promise<void> {
  await flyRequest<void>(`/apps/${appName}`, {
    method: 'DELETE',
  });
}
