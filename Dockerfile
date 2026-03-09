FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  procps \
  sqlite3 \
  && rm -rf /var/lib/apt/lists/*

# Install OpenClaw globally
RUN npm install -g openclaw@latest

# Create agent workspace
RUN mkdir -p /agent/workspace /agent/data

# Set working directory
WORKDIR /agent/workspace

# Copy SAID base config and skills
COPY config/ /agent/config/
COPY skills/ /agent/skills/

# Copy entrypoint
COPY entrypoint.sh /agent/entrypoint.sh
RUN chmod +x /agent/entrypoint.sh

# Agent workspace is the persistent volume mount point
VOLUME ["/agent/data"]

# OpenClaw gateway port
EXPOSE 18789

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:18789/health || exit 1

# Run as non-root
RUN useradd -m -s /bin/bash agent
RUN chown -R agent:agent /agent
USER agent

ENTRYPOINT ["/agent/entrypoint.sh"]
