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
      gateway: {
        port: 18789,
        bind: 'all',
        mode: 'local',
        auth: { mode: 'token', token: process.env.OPENCLAW_GATEWAY_TOKEN || '$GATEWAY_TOKEN' }
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
        bind: 'all',
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

# Start OpenClaw gateway (foreground)
exec openclaw gateway --port 18789
