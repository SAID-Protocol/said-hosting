#!/bin/bash
set -e

WORKSPACE="/agent/data/workspace"
OPENCLAW_DIR="/home/agent/.openclaw"
DATA_DIR="/agent/data"
IDENTITY_ENV="$DATA_DIR/identity.env"

mkdir -p "$WORKSPACE" "$OPENCLAW_DIR" "$DATA_DIR"

# Initialize workspace on first run
if [ ! -d "$WORKSPACE" ] || [ -z "$(ls -A "$WORKSPACE" 2>/dev/null)" ]; then
  echo "[said-hosting] First run — initializing agent workspace..."
  mkdir -p "$WORKSPACE"
fi

# Generate gateway config with mode=local
GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")}"
AGENT_NAME="${SAID_AGENT_NAME:-SAID Agent}"
MODEL="${SAID_MODEL:-anthropic/claude-sonnet-4-5}"

# Run identity bootstrap early on every boot (script is idempotent)
echo "[said-hosting] Bootstrapping SAID identity..."
export AGENT_DATA_DIR="$DATA_DIR"
export SAID_IDENTITY_ENV_PATH="$IDENTITY_ENV"
node /agent/scripts/bootstrap-identity.mjs || echo "[said-hosting] Bootstrap completed with warnings (non-fatal)"

if [ -f "$IDENTITY_ENV" ]; then
  # shellcheck disable=SC1090
  set -a
  . "$IDENTITY_ENV"
  set +a
  echo "[said-hosting] Agent wallet: ${SAID_IDENTITY_WALLET:-unknown}"
else
  echo "[said-hosting] Warning: identity env file missing at $IDENTITY_ENV"
fi

# Use OpenRouter as LLM provider (per-agent key with spending limits)
# Falls back to direct Anthropic if no OpenRouter key provided
if [ -n "$OPENROUTER_API_KEY" ]; then
  echo "[said-hosting] Using OpenRouter for LLM access (per-agent key)"
  node -e "
    const config = {
      meta: {
        lastTouchedVersion: '2026.2.9',
        lastTouchedAt: new Date().toISOString()
      },
      gateway: {
        port: 18789,
        bind: 'lan',
        mode: 'local',
        auth: { mode: 'token', token: process.env.OPENCLAW_GATEWAY_TOKEN || '$GATEWAY_TOKEN' },
        http: { endpoints: { chatCompletions: { enabled: true } } }
      },
      auth: {
        profiles: {
          'openrouter:default': {
            provider: 'openrouter',
            mode: 'api_key'
          }
        }
      },
      agents: { defaults: { model: { primary: 'openrouter/anthropic/claude-sonnet-4-5' } } },
      env: {
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
        SAID_IDENTITY_WALLET: process.env.SAID_IDENTITY_WALLET,
        SAID_WALLET_ADDRESS: process.env.SAID_WALLET_ADDRESS
      }
    };
    require('fs').writeFileSync('$OPENCLAW_DIR/openclaw.json', JSON.stringify(config, null, 2));
  "
else
  echo "[said-hosting] Using direct Anthropic API key"
  node -e "
    const config = {
      gateway: {
        port: 18789,
        bind: 'lan',
        mode: 'local',
        auth: { mode: 'token', token: '$GATEWAY_TOKEN' }
      },
      agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-5' } } },
      env: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        SAID_IDENTITY_WALLET: process.env.SAID_IDENTITY_WALLET,
        SAID_WALLET_ADDRESS: process.env.SAID_WALLET_ADDRESS
      }
    };
    require('fs').writeFileSync('$OPENCLAW_DIR/openclaw.json', JSON.stringify(config, null, 2));
  "
fi

echo "[said-hosting] Config written to $OPENCLAW_DIR/openclaw.json"

# Copy SAID skill if available
if [ -d /agent/skills ]; then
  mkdir -p "$OPENCLAW_DIR/skills"
  cp -r /agent/skills/* "$OPENCLAW_DIR/skills/" 2>/dev/null || true
fi

# === Workspace file generation ===
if [ -n "$WORKSPACE_FILES_JSON" ]; then
  echo "[said-hosting] Writing workspace files from wizard config..."
  node -e "
    const fs = require('fs');
    const path = require('path');
    const workspace = '$WORKSPACE';
    const files = JSON.parse(process.env.WORKSPACE_FILES_JSON);
    for (const f of files) {
      const fullPath = path.join(workspace, f.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      if (!fs.existsSync(fullPath)) {
        fs.writeFileSync(fullPath, f.content);
        console.log('[said-hosting] Wrote: ' + f.path);
      } else {
        console.log('[said-hosting] Skipped (exists): ' + f.path);
      }
    }
  "
else
  echo "[said-hosting] No WORKSPACE_FILES_JSON — using base config files"
  for f in AGENTS.md SOUL.md; do
    if [ -f "/agent/config/$f" ] && [ ! -f "$WORKSPACE/$f" ]; then
      cp "/agent/config/$f" "$WORKSPACE/$f"
    fi
  done

  if [ -n "$PROGRAM_MD" ]; then
    echo "$PROGRAM_MD" > "$WORKSPACE/SOUL.md"
    echo "[said-hosting] Injected program.md into SOUL.md"
  fi
fi

cd "$WORKSPACE"

echo "[said-hosting] Starting OpenClaw gateway..."
echo "[said-hosting] Agent: $AGENT_NAME | Tier: ${SAID_TIER:-starter} | Wallet: ${SAID_IDENTITY_WALLET:-unknown}"

openclaw gateway --port 18789 &
GATEWAY_PID=$!

echo "[said-hosting] Waiting for gateway to initialize..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:18789/ > /dev/null 2>&1; then
    echo "[said-hosting] Gateway is up after ${i}s"
    break
  fi
  sleep 1
done

PATCH_JSON='{}'
if [ -n "$OPENROUTER_API_KEY" ]; then
  echo "[said-hosting] Patching config: enabling chatCompletions + OpenRouter model"
  PATCH_JSON=$(node -e "
    console.log(JSON.stringify({
      gateway: { http: { endpoints: { chatCompletions: { enabled: true } } } },
      agents: { defaults: { model: { primary: 'openrouter/anthropic/claude-sonnet-4-5' } } },
      env: {
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
        SAID_IDENTITY_WALLET: process.env.SAID_IDENTITY_WALLET,
        SAID_WALLET_ADDRESS: process.env.SAID_WALLET_ADDRESS
      }
    }));
  ")
else
  echo "[said-hosting] Patching config: enabling chatCompletions"
  PATCH_JSON=$(node -e "
    console.log(JSON.stringify({
      gateway: { http: { endpoints: { chatCompletions: { enabled: true } } } },
      env: {
        SAID_IDENTITY_WALLET: process.env.SAID_IDENTITY_WALLET,
        SAID_WALLET_ADDRESS: process.env.SAID_WALLET_ADDRESS
      }
    }));
  ")
fi

curl -sf -X PATCH "http://127.0.0.1:18789/__openclaw__/api/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -d "$PATCH_JSON" > /dev/null 2>&1 && echo "[said-hosting] Config patched successfully" || echo "[said-hosting] Config patch failed (will retry via file)"

if ! curl -sf http://127.0.0.1:18789/v1/chat/completions -H "Authorization: Bearer $GATEWAY_TOKEN" -d '{}' 2>&1 | grep -q "model"; then
  echo "[said-hosting] Patching config file directly..."
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('$OPENCLAW_DIR/openclaw.json', 'utf8'));
    if (!cfg.gateway) cfg.gateway = {};
    if (!cfg.gateway.http) cfg.gateway.http = {};
    if (!cfg.gateway.http.endpoints) cfg.gateway.http.endpoints = {};
    cfg.gateway.http.endpoints.chatCompletions = { enabled: true };
    if (process.env.OPENCLAW_GATEWAY_TOKEN) {
      cfg.gateway.auth = cfg.gateway.auth || {};
      cfg.gateway.auth.mode = 'token';
      cfg.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
    }
    cfg.env = cfg.env || {};
    if (process.env.SAID_IDENTITY_WALLET) cfg.env.SAID_IDENTITY_WALLET = process.env.SAID_IDENTITY_WALLET;
    if (process.env.SAID_WALLET_ADDRESS) cfg.env.SAID_WALLET_ADDRESS = process.env.SAID_WALLET_ADDRESS;
    if (process.env.OPENROUTER_API_KEY) {
      cfg.agents = cfg.agents || {};
      cfg.agents.defaults = cfg.agents.defaults || {};
      cfg.agents.defaults.model = cfg.agents.defaults.model || {};
      cfg.agents.defaults.model.primary = 'openrouter/anthropic/claude-sonnet-4-5';
      cfg.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
      cfg.auth = cfg.auth || {};
      cfg.auth.profiles = cfg.auth.profiles || {};
      cfg.auth.profiles['openrouter:default'] = { provider: 'openrouter', mode: 'api_key' };
    }
    fs.writeFileSync('$OPENCLAW_DIR/openclaw.json', JSON.stringify(cfg, null, 2));
    console.log('[said-hosting] Config file patched');
  "
  kill $GATEWAY_PID 2>/dev/null
  sleep 2
  exec openclaw gateway --port 18789
fi

wait $GATEWAY_PID
