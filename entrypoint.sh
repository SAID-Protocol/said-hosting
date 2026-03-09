#!/bin/bash
set -e

WORKSPACE="/agent/data/workspace"
OPENCLAW_DIR="/home/agent/.openclaw"

# Initialize workspace on first run
if [ ! -d "$WORKSPACE" ]; then
  echo "[said-hosting] First run — initializing agent workspace..."
  mkdir -p "$WORKSPACE"
fi

# Always ensure .openclaw dir exists (may be first boot or volume was empty)
mkdir -p "$OPENCLAW_DIR"

# Generate gateway config with mode=local
GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")}"
AGENT_NAME="${SAID_AGENT_NAME:-SAID Agent}"
MODEL="${SAID_MODEL:-anthropic/claude-sonnet-4-5}"

cat > "$OPENCLAW_DIR/openclaw.json" << CONF
{
  "gateway": {
    "port": 18789,
    "mode": "local",
    "gatewayToken": "$GATEWAY_TOKEN"
  },
  "agent": {
    "name": "$AGENT_NAME",
    "model": "$MODEL"
  },
  "auth": {
    "anthropic": { "api_key_env": "ANTHROPIC_API_KEY" }
  }
}
CONF

echo "[said-hosting] Config written to $OPENCLAW_DIR/openclaw.json"
echo "[said-hosting] Gateway token: ${GATEWAY_TOKEN:0:8}..."
echo "[said-hosting] Agent: $AGENT_NAME | Model: $MODEL"

# Copy SAID skill if available
if [ -d /agent/skills ]; then
  mkdir -p "$OPENCLAW_DIR/skills"
  cp -r /agent/skills/* "$OPENCLAW_DIR/skills/" 2>/dev/null || true
fi

# Copy base agent files to workspace
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

echo "[said-hosting] Starting OpenClaw gateway..."
echo "[said-hosting] Agent ID: ${SAID_AGENT_ID:-unset}"
echo "[said-hosting] Tier: ${SAID_TIER:-starter}"

# Start OpenClaw gateway (foreground)
exec openclaw gateway --port 18789
