#!/bin/bash
set -e

WORKSPACE="/agent/data/workspace"
OPENCLAW_DIR="/agent/data/.openclaw"

# Initialize workspace on first run
if [ ! -d "$WORKSPACE" ]; then
  echo "[said-hosting] First run — initializing agent workspace..."
  mkdir -p "$WORKSPACE"
  mkdir -p "$OPENCLAW_DIR"
  
  # Copy base config if not exists
  if [ ! -f "$OPENCLAW_DIR/openclaw.json" ]; then
    cp /agent/config/openclaw.json "$OPENCLAW_DIR/openclaw.json"
  fi
  
  # Copy SAID skill
  mkdir -p "$OPENCLAW_DIR/skills"
  cp -r /agent/skills/* "$OPENCLAW_DIR/skills/" 2>/dev/null || true
  
  # Copy base agent files (SOUL.md, AGENTS.md, etc.)
  cp /agent/config/AGENTS.md "$WORKSPACE/AGENTS.md" 2>/dev/null || true
  cp /agent/config/SOUL.md "$WORKSPACE/SOUL.md" 2>/dev/null || true
  
  echo "[said-hosting] Workspace initialized."
fi

# Symlink .openclaw to data volume for persistence
export OPENCLAW_HOME="$OPENCLAW_DIR"
export OPENCLAW_WORKSPACE="$WORKSPACE"

cd "$WORKSPACE"

echo "[said-hosting] Starting OpenClaw gateway..."
echo "[said-hosting] Agent ID: ${SAID_AGENT_ID:-unset}"
echo "[said-hosting] Tier: ${SAID_TIER:-starter}"

# Start OpenClaw gateway (foreground)
exec openclaw gateway --port 18789
