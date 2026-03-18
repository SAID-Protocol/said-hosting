#!/bin/bash
# Send a SAID A2A message via REST

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ $# -lt 2 ]; then
  echo "Usage: ./send.sh <RECIPIENT_ADDRESS> <MESSAGE>"
  exit 1
fi

TO="$1"
MESSAGE="$2"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# Send message
node examples/rest-agent.js "$TO" "$MESSAGE"
