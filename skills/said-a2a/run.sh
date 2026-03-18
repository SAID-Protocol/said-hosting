#!/bin/bash
# SAID A2A WebSocket Agent
# Starts persistent agent listening for messages

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# Run WebSocket agent
node examples/websocket-agent.js
