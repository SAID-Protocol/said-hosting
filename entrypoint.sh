#!/bin/bash
set -e

# Auto-detect volume mount location (platform may mount at /data or /agent/data)
if [ -d "/agent/data" ] && mountpoint -q "/agent/data" 2>/dev/null; then
  DATA_DIR="/agent/data"
elif [ -d "/data" ] && mountpoint -q "/data" 2>/dev/null; then
  DATA_DIR="/data"
elif [ -d "/agent/data" ]; then
  # Fallback: use /agent/data even if not a mountpoint (for compatibility)
  DATA_DIR="/agent/data"
else
  # Last resort
  DATA_DIR="/data"
fi

WORKSPACE="/home/agent/.openclaw/workspace"
OPENCLAW_DIR="$DATA_DIR"
IDENTITY_ENV="$DATA_DIR/identity.env"

mkdir -p "$WORKSPACE" "$OPENCLAW_DIR" "$DATA_DIR" "/home/agent/.openclaw"

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
node /agent/scripts/bootstrap-identity.cjs || echo "[said-hosting] Bootstrap completed with warnings (non-fatal)"

if [ -f "$IDENTITY_ENV" ]; then
  # shellcheck disable=SC1090
  set -a
  . "$IDENTITY_ENV"
  set +a
  echo "[said-hosting] Agent wallet: ${SAID_IDENTITY_WALLET:-unknown}"
else
  echo "[said-hosting] Warning: identity env file missing at $IDENTITY_ENV"
fi

# Always write fresh config (gateway restarts need clean state)
# Use OpenRouter as LLM provider (per-agent key with spending limits)
# Trial agents use z.ai proxy instead of OpenRouter
# Falls back to direct Anthropic if no OpenRouter key provided
if [ "$SAID_AGENT_TIER" = "trial" ]; then
  # Default z.ai proxy URL if not explicitly set
  export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://app.saidprotocol.com/api/ai-proxy}"
  echo "[said-hosting] Trial agent — using z.ai proxy at $OPENAI_BASE_URL"
  node -e "
    const tgToken = process.env.SAID_TELEGRAM_TOKEN;
    const gwToken = process.env.GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN;
    const config = {
      meta: {
        lastTouchedVersion: '2026.3.8',
        lastTouchedAt: new Date().toISOString()
      },
      gateway: {
        controlUi: {
          dangerouslyAllowHostHeaderOriginFallback: true
        },
        http: {
          endpoints: {
            chatCompletions: { enabled: true }
          }
        },
        auth: gwToken ? { mode: 'token', token: gwToken } : undefined
      },
      channels: tgToken ? {
        telegram: {
          enabled: true,
          botToken: tgToken,
          dmPolicy: 'open',
          allowFrom: ['*'],
          groupPolicy: 'open',
          groupAllowFrom: ['*']
        }
      } : {},
      auth: {
        profiles: {
          'openai:default': {
            provider: 'openai',
            mode: 'api_key'
          }
        }
      },
      models: {
        providers: {
          openai: {
            baseUrl: process.env.OPENAI_BASE_URL + '/v1',
            auth: 'api-key',
            api: 'openai-completions',
            models: [
              { id: 'gpt-4o', name: 'GPT-4o (z.ai proxy)', api: 'openai-completions' }
            ]
          }
        }
      },
      agents: { defaults: { model: { primary: 'openai/gpt-4o' }, maxConcurrent: 2 } },
      env: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
        SAID_IDENTITY_WALLET: process.env.SAID_IDENTITY_WALLET,
        SAID_WALLET_ADDRESS: process.env.SAID_WALLET_ADDRESS
      }
    };
    // Clean undefined values
    if (!config.gateway.auth) delete config.gateway.auth;
    require('fs').writeFileSync('$OPENCLAW_DIR/openclaw.json', JSON.stringify(config, null, 2));
  "
elif [ -n "$OPENROUTER_API_KEY" ]; then
  echo "[said-hosting] Using OpenRouter for LLM access (per-agent key)"
  node -e "
    const tgToken = process.env.SAID_TELEGRAM_TOKEN;
    const gwToken = process.env.GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN;
    const tier = process.env.SAID_AGENT_TIER || 'free';
    const model = (tier === 'pro' || tier === 'power') 
      ? 'openrouter/anthropic/claude-sonnet-4-5' 
      : 'openrouter/anthropic/claude-sonnet-4-5';
    const config = {
      meta: {
        lastTouchedVersion: '2026.3.8',
        lastTouchedAt: new Date().toISOString()
      },
      gateway: {
        controlUi: {
          dangerouslyAllowHostHeaderOriginFallback: true
        },
        http: {
          endpoints: {
            chatCompletions: { enabled: true }
          }
        },
        auth: gwToken ? { mode: 'token', token: gwToken } : undefined
      },
      channels: tgToken ? {
        telegram: {
          enabled: true,
          botToken: tgToken,
          dmPolicy: 'open',
          allowFrom: ['*'],
          groupPolicy: 'open',
          groupAllowFrom: ['*']
        }
      } : {},
      auth: {
        profiles: {
          'openrouter:default': {
            provider: 'openrouter',
            mode: 'api_key'
          }
        }
      },
      agents: { defaults: { model: { primary: model }, maxConcurrent: 2 } },
      env: {
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
        SAID_IDENTITY_WALLET: process.env.SAID_IDENTITY_WALLET,
        SAID_WALLET_ADDRESS: process.env.SAID_WALLET_ADDRESS
      }
    };
    // Clean undefined values
    if (!config.gateway.auth) delete config.gateway.auth;
    require('fs').writeFileSync('$OPENCLAW_DIR/openclaw.json', JSON.stringify(config, null, 2));
  "
else
  echo "[said-hosting] Using direct Anthropic API key"
  node -e "
    const tgToken = process.env.SAID_TELEGRAM_TOKEN;
    const gwToken = process.env.GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN;
    const config = {
      meta: {
        lastTouchedVersion: '2026.3.8',
        lastTouchedAt: new Date().toISOString()
      },
      gateway: {
        controlUi: {
          dangerouslyAllowHostHeaderOriginFallback: true
        },
        auth: gwToken ? { mode: 'token', token: gwToken } : undefined
      },
      channels: tgToken ? {
        telegram: {
          enabled: true,
          botToken: tgToken,
          dmPolicy: 'open',
          allowFrom: ['*'],
          groupPolicy: 'open',
          groupAllowFrom: ['*']
        }
      } : {},
      agents: { defaults: { model: { primary: 'anthropic/claude-sonnet-4-5' } } },
      env: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        SAID_IDENTITY_WALLET: process.env.SAID_IDENTITY_WALLET,
        SAID_WALLET_ADDRESS: process.env.SAID_WALLET_ADDRESS
      }
    };
    if (!config.gateway.auth) delete config.gateway.auth;
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
  for f in AGENTS.md SOUL.md RESEARCH_WORKFLOW.md; do
    if [ -f "/agent/config/$f" ] && [ ! -f "$WORKSPACE/$f" ]; then
      cp "/agent/config/$f" "$WORKSPACE/$f"
      echo "[said-hosting] Copied: $f"
    fi
  done

  if [ -n "$PROGRAM_MD" ]; then
    echo "$PROGRAM_MD" > "$WORKSPACE/SOUL.md"
    echo "[said-hosting] Injected program.md into SOUL.md"
  fi
fi

# Update IDENTITY.md with wallet address (filled in at boot, partial was created by wizard)
if [ -n "$SAID_IDENTITY_WALLET" ] && [ -f "$WORKSPACE/IDENTITY.md" ]; then
  # Replace placeholder with actual wallet
  node -e "
    const fs = require('fs');
    const path = '$WORKSPACE/IDENTITY.md';
    let content = fs.readFileSync(path, 'utf8');
    const wallet = process.env.SAID_IDENTITY_WALLET;
    // Fill in all wallet placeholders
    content = content.replace(/\\[YOUR_WALLET_ADDRESS\\]/g, wallet);
    content = content.replace(/\\(wallet-address\\)/g, wallet);
    content = content.replace(/\\(filled in at boot.*?\\)/g, wallet);
    content = content.replace(/\\(filled at boot\\)/g, wallet);
    fs.writeFileSync(path, content);
    console.log('[said-hosting] Updated IDENTITY.md with wallet ' + wallet);
  "
  # Also update AGENTS.md with wallet
  if [ -f "$WORKSPACE/AGENTS.md" ]; then
    node -e "
      const fs = require('fs');
      const p = '$WORKSPACE/AGENTS.md';
      let c = fs.readFileSync(p, 'utf8');
      const w = process.env.SAID_IDENTITY_WALLET;
      c = c.replace(/\\(filled at boot\\)/g, w);
      c = c.replace(/\\(wallet-address\\)/g, w);
      fs.writeFileSync(p, c);
      console.log('[said-hosting] Updated AGENTS.md with wallet ' + w);
    "
  fi
elif [ -n "$SAID_IDENTITY_WALLET" ] && [ ! -f "$WORKSPACE/IDENTITY.md" ]; then
  # No wizard-generated IDENTITY.md — create one from scratch
  node -e "
    const fs = require('fs');
    const wallet = process.env.SAID_IDENTITY_WALLET;
    const name = process.env.SAID_AGENT_NAME || 'SAID Agent';
    const tier = process.env.SAID_TIER || 'starter';
    const content = [
      '# MY IDENTITY',
      '',
      '## Who I Am',
      '- **Name:** ' + name,
      '- **Wallet Address:** \\\`' + wallet + '\\\`',
      '- **Tier:** ' + tier,
      '- **Platform:** SAID Protocol (https://www.saidprotocol.com)',
      '- **Profile:** https://www.saidprotocol.com/agents/' + wallet,
      '- **Status:** Verified ✅ (on-chain, Solana mainnet)',
      '- **Program ID:** 5dpw6KEQPn248pnkkaYyWfHwu2nfb3LUMbTucb6LaA8G',
      '',
      '## What I Have',
      '- Solana wallet with USDC funding',
      '- On-chain verified SAID identity',
      '- A2A messaging (wss://api.saidprotocol.com)',
      '- OpenClaw tools: web search, file ops, code execution, browser',
      '- LLM access via OpenRouter',
      '',
      '## Last Boot: ' + new Date().toISOString(),
    ].join('\\n');
    fs.writeFileSync('$WORKSPACE/IDENTITY.md', content);
    console.log('[said-hosting] Created IDENTITY.md for ' + name + ' (' + wallet + ')');
  "
fi

# Clean up default OpenClaw workspace files that conflict with wizard-generated ones
rm -f "$WORKSPACE/BOOTSTRAP.md" 2>/dev/null
rm -f "$WORKSPACE/USER.md" 2>/dev/null
rm -f "$WORKSPACE/HEARTBEAT.md" 2>/dev/null
rm -f "$WORKSPACE/TOOLS.md" 2>/dev/null

# Ensure memory directory exists
mkdir -p "$WORKSPACE/memory"

# Fix ownership so agent can write to workspace (memory, scratchpad, etc.)
chown -R agent:agent "$WORKSPACE" 2>/dev/null || true

cd "$WORKSPACE"

# Report wallet address back to platform API
if [ -n "$SAID_IDENTITY_WALLET" ] && [ -n "$SAID_PLATFORM_API" ] && [ -n "$SAID_AGENT_ID" ]; then
  echo "[said-hosting] Reporting wallet $SAID_IDENTITY_WALLET to platform API..."
  curl -s -X POST "$SAID_PLATFORM_API/api/agents/$SAID_AGENT_ID/report-wallet" \
    -H "Content-Type: application/json" \
    -H "x-api-key: ${SAID_PLATFORM_API_KEY:-}" \
    -d "{\"walletAddress\": \"$SAID_IDENTITY_WALLET\"}" \
    > /dev/null 2>&1 || echo "[said-hosting] Warning: Failed to report wallet to platform API"
fi

# Helper function to report events to platform API
report_event() {
  local event_type="$1"
  local event_data="$2"
  if [ -n "$SAID_PLATFORM_API" ] && [ -n "$SAID_AGENT_ID" ]; then
    curl -s -X POST "$SAID_PLATFORM_API/api/agents/$SAID_AGENT_ID/report-event" \
      -H "Content-Type: application/json" \
      -H "x-api-key: ${SAID_PLATFORM_API_KEY:-}" \
      -d "{\"type\": \"$event_type\", \"data\": \"$event_data\"}" \
      > /dev/null 2>&1 || true
  fi
}

# Report boot event
report_event "boot" "Agent started (tier: ${SAID_AGENT_TIER:-starter}, model: ${SAID_MODEL:-default})"

# Background: report heartbeat every 10 minutes + watch for message events in logs
(
  while true; do
    sleep 600
    report_event "heartbeat" ""
  done
) &

echo "[said-hosting] Starting OpenClaw gateway..."
echo "[said-hosting] Agent: $AGENT_NAME | Tier: ${SAID_TIER:-starter} | Wallet: ${SAID_IDENTITY_WALLET:-unknown}"

export OPENCLAW_STATE_DIR="$DATA_DIR"
export HOME="/home/agent"

# Symlink config so OpenClaw finds it at ~/.openclaw/openclaw.json
rm -f /home/agent/.openclaw/openclaw.json 2>/dev/null
ln -sf "$DATA_DIR/openclaw.json" /home/agent/.openclaw/openclaw.json
export OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN"
export OPENCLAW_GATEWAY_PORT=18789
export NODE_OPTIONS="--max-old-space-size=3072"

# Telegram extension deps pre-installed in Dockerfile — clean startup
# Report Telegram errors & disable after 3 failures
TG_ERRORS=0
check_telegram_errors() {
  if tail -n 30 /tmp/openclaw/openclaw-2026-*.log | grep -q "Call to .* failed! (404:"; then
    let TG_ERRORS++
    if [ "$TG_ERRORS" -ge 3 ]; then
      echo "[said-hosting] Disabling Telegram due to repeated 404 errors"
      sed -i '/telegram:/,/}/ s/enabled: true/enabled: false/' "$DATA_DIR/openclaw.json"
      TG_ERRORS=0
    fi
  else
    TG_ERRORS=0
  fi
}
exec node /usr/local/lib/node_modules/openclaw/dist/index.js gateway --port 18789 --bind lan --allow-unconfigured &

# Monitor & check for repeated Telegram errors
echo "[said-hosting] Monitoring Telegram errors..."
while true; do
  sleep 600
  check_telegram_errors
done
