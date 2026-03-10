FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  procps \
  sqlite3 \
  && rm -rf /var/lib/apt/lists/*

# Install OpenClaw + Solana bootstrap dependencies globally
RUN npm install -g openclaw@latest @solana/web3.js @solana/spl-token tweetnacl bs58

# Create agent workspace
RUN mkdir -p /agent/workspace /agent/scripts /data

# Install script-local dependencies too so ESM scripts resolve reliably in-container
WORKDIR /agent/scripts
RUN npm init -y && npm install @solana/web3.js @solana/spl-token tweetnacl bs58

# Set working directory
WORKDIR /agent/workspace

# Copy SAID base config and skills
COPY config/ /agent/config/
COPY skills/ /agent/skills/
COPY scripts/ /agent/scripts/

# Copy entrypoint
COPY entrypoint.sh /agent/entrypoint.sh
RUN chmod +x /agent/entrypoint.sh

# Persistent Fly volume mount point
VOLUME ["/data"]

# OpenClaw gateway port
EXPOSE 18789

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:18789/health || exit 1

# Run as non-root
RUN useradd -m -s /bin/bash agent
RUN chown -R agent:agent /agent /data
USER agent

ENTRYPOINT ["/agent/entrypoint.sh"]
