#!/bin/bash
set -e

WORKSPACE="/agent/data/workspace"
OPENCLAW_DIR="/home/agent/.openclaw"
DATA_DIR="/agent/data"

# Initialize workspace on first run
if [ ! -d "$WORKSPACE" ]; then
  echo "[said-hosting] First run — initializing agent workspace..."
  mkdir -p "$WORKSPACE"
fi

# Always ensure .openclaw dir exists
mkdir -p "$OPENCLAW_DIR"

# Generate gateway config with mode=local
GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")}"
AGENT_NAME="${SAID_AGENT_NAME:-SAID Agent}"
MODEL="${SAID_MODEL:-anthropic/claude-sonnet-4-5}"

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
      env: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
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
      env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
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

# Copy base agent files to workspace (first boot only)
for f in AGENTS.md SOUL.md; do
  if [ -f "/agent/config/$f" ] && [ ! -f "$WORKSPACE/$f" ]; then
    cp "/agent/config/$f" "$WORKSPACE/$f"
  fi
done

# Write program.md from env if provided
if [ -n "$PROGRAM_MD" ]; then
  echo "$PROGRAM_MD" > "$WORKSPACE/SOUL.md"
  echo "[said-hosting] Injected program.md into SOUL.md"
fi

cd "$WORKSPACE"

# === SAID Identity Bootstrap (first boot) ===
if [ ! -f "$DATA_DIR/wallet.json" ]; then
  echo "[said-hosting] First boot — bootstrapping SAID identity..."
  export AGENT_DATA_DIR="$DATA_DIR"
  node /agent/scripts/bootstrap-identity.mjs || echo "[said-hosting] Bootstrap completed with warnings (non-fatal)"
  echo "[said-hosting] Identity bootstrap complete."
else
  echo "[said-hosting] Wallet exists, skipping bootstrap."
  # Show wallet address
  node -e "
    const fs = require('fs');
    const { Keypair } = require('@solana/web3.js');
    const raw = JSON.parse(fs.readFileSync('$DATA_DIR/wallet.json', 'utf8'));
    const kp = Keypair.fromSecretKey(Uint8Array.from(raw));
    console.log('[said-hosting] Agent wallet: ' + kp.publicKey.toString());
  " 2>/dev/null || true
fi

echo "[said-hosting] Starting OpenClaw gateway..."
echo "[said-hosting] Agent: $AGENT_NAME | Tier: ${SAID_TIER:-starter}"

# Start OpenClaw gateway in background, then patch config after it initializes
openclaw gateway --port 18789 &
GATEWAY_PID=$!

# Wait for gateway to be ready (it rewrites config on first boot)
echo "[said-hosting] Waiting for gateway to initialize..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:18789/ > /dev/null 2>&1; then
    echo "[said-hosting] Gateway is up after ${i}s"
    break
  fi
  sleep 1
done

# Patch config AFTER OpenClaw has done its normalization
PATCH_JSON='{}'
if [ -n "$OPENROUTER_API_KEY" ]; then
  echo "[said-hosting] Patching config: enabling chatCompletions + OpenRouter model"
  PATCH_JSON=$(node -e "
    console.log(JSON.stringify({
      gateway: { http: { endpoints: { chatCompletions: { enabled: true } } } },
      agents: { defaults: { model: { primary: 'openrouter/anthropic/claude-sonnet-4-5' } } },
      env: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
    }));
  ")
else
  echo "[said-hosting] Patching config: enabling chatCompletions"
  PATCH_JSON='{"gateway":{"http":{"endpoints":{"chatCompletions":{"enabled":true}}}}}'
fi

# Apply the patch via the gateway's HTTP API
curl -sf -X PATCH "http://127.0.0.1:18789/__openclaw__/api/config" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -d "$PATCH_JSON" > /dev/null 2>&1 && echo "[said-hosting] Config patched successfully" || echo "[said-hosting] Config patch failed (will retry via file)"

# Fallback: if API patch didn't work, patch the file directly and restart
if ! curl -sf http://127.0.0.1:18789/v1/chat/completions -H "Authorization: Bearer $GATEWAY_TOKEN" -d '{}' 2>&1 | grep -q "model"; then
  echo "[said-hosting] Patching config file directly..."
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('$OPENCLAW_DIR/openclaw.json', 'utf8'));
    if (!cfg.gateway) cfg.gateway = {};
    if (!cfg.gateway.http) cfg.gateway.http = {};
    if (!cfg.gateway.http.endpoints) cfg.gateway.http.endpoints = {};
    cfg.gateway.http.endpoints.chatCompletions = { enabled: true };
    if (process.env.OPENROUTER_API_KEY) {
      cfg.agents = cfg.agents || {};
      cfg.agents.defaults = cfg.agents.defaults || {};
      cfg.agents.defaults.model = cfg.agents.defaults.model || {};
      cfg.agents.defaults.model.primary = 'openrouter/anthropic/claude-sonnet-4-5';
      cfg.env = cfg.env || {};
      cfg.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    }
    fs.writeFileSync('$OPENCLAW_DIR/openclaw.json', JSON.stringify(cfg, null, 2));
    console.log('[said-hosting] Config file patched');
  "
  # Restart gateway to pick up changes
  kill $GATEWAY_PID 2>/dev/null
  sleep 2
  exec openclaw gateway --port 18789
fi

# Keep the background gateway process as the main process
wait $GATEWAY_PID
