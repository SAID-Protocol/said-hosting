FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  procps \
  sqlite3 \
  && rm -rf /var/lib/apt/lists/*

# Install OpenClaw + Solana bootstrap dependencies globally
RUN npm install -g openclaw@2026.3.12 @solana/web3.js @solana/spl-token tweetnacl bs58

# Install Prisma CLI globally for database migrations
RUN npm install -g prisma

# Pre-install Telegram extension dependencies (avoids first-load hang in container)
RUN cd /usr/local/lib/node_modules/openclaw/extensions/telegram && npm install 2>/dev/null || true

# Create agent directories (workspace will be on mounted volume)
RUN mkdir -p /agent/scripts /data

# Copy scripts first (before installing dependencies)
COPY scripts/ /agent/scripts/

# Install script-local dependencies so ESM scripts resolve reliably in-container
WORKDIR /agent/scripts
RUN npm init -y && npm install @solana/web3.js @solana/spl-token tweetnacl bs58

# NOTE: Working directory will be set to /agent/data/workspace by entrypoint.sh
# Do NOT set WORKDIR here - it would create an ephemeral directory

# Copy SAID base config and skills
COPY config/ /agent/config/
COPY skills/ /agent/skills/

# Install skill dependencies
RUN cd /agent/skills/said-a2a && npm install --omit=dev 2>/dev/null || true

# Copy entrypoint
COPY entrypoint.sh /agent/entrypoint.sh
RUN chmod +x /agent/entrypoint.sh

# Persistent volume mount point
VOLUME ["/data"]

# OpenClaw gateway port
EXPOSE 18789

# Health check
HEALTHCHECK --interval=30s --timeout=15s --start-period=120s --retries=5 \
  CMD curl -f http://localhost:18789/health || exit 1

# Create swap file for memory overflow (allows 2GB machines to handle 1.8GB RSS)
RUN fallocate -l 1G /agent/swapfile && chmod 600 /agent/swapfile && mkswap /agent/swapfile

# Cap V8 heap to leave room for OS + extensions
ENV NODE_OPTIONS="--max-old-space-size=1536"

# Enable Node.js to find globally installed modules (required for ESM imports in bootstrap script)
ENV NODE_PATH="/usr/local/lib/node_modules"

# Run as non-root
RUN useradd -m -s /bin/bash agent
RUN chown -R agent:agent /agent /data

# Wrapper script: enable swap as root, then exec entrypoint as agent
RUN printf '#!/bin/bash\nswapon /agent/swapfile 2>/dev/null || true\nchown -R agent:agent /data 2>/dev/null || true\nexec su -s /bin/bash agent -c "/agent/entrypoint.sh"\n' > /agent/start.sh && chmod +x /agent/start.sh

ENTRYPOINT ["/agent/start.sh"]
