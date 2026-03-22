#!/bin/bash
# Backup critical agent data (wallet keys + identity files) from all Hetzner servers
# Run daily via cron: 0 4 * * * /opt/said-hosting/scripts/backup-agent-data.sh
#
# Each server gets a local backup at /opt/said-hosting/backups/YYYY-MM-DD/
# Critical files: wallet.json, said-identity.json, identity.env, openclaw.json

set -euo pipefail

SSH_KEY="${SSH_KEY:-/root/.ssh/said_hetzner}"
SERVERS=(87.99.140.184 5.78.185.103 5.78.186.196 204.168.183.164)
DATE=$(date +%Y-%m-%d)
RETENTION_DAYS=30

log() { echo "[backup $(date +%H:%M:%S)] $*"; }

for ip in "${SERVERS[@]}"; do
  log "Backing up $ip..."
  
  ssh -i "$SSH_KEY" -o ConnectTimeout=10 -o StrictHostKeyChecking=no "root@$ip" bash -s "$DATE" "$RETENTION_DAYS" <<'REMOTE'
    DATE="$1"
    RETENTION="$2"
    BACKUP_DIR="/opt/said-hosting/backups/$DATE"
    AGENT_DIR="/opt/said-hosting/agents"
    
    mkdir -p "$BACKUP_DIR"
    
    if [ ! -d "$AGENT_DIR" ] || [ -z "$(ls -A "$AGENT_DIR" 2>/dev/null)" ]; then
      echo "  [warn] No agent directories on this server"
      exit 0
    fi
    
    count=0
    for agent_dir in "$AGENT_DIR"/*/; do
      id=$(basename "$agent_dir")
      dest="$BACKUP_DIR/$id"
      mkdir -p "$dest"
      
      # Copy only critical files (not full data)
      for f in wallet.json said-identity.json identity.env openclaw.json; do
        if [ -f "$agent_dir/$f" ]; then
          cp "$agent_dir/$f" "$dest/"
        fi
      done
      count=$((count + 1))
    done
    
    echo "  Backed up $count agents to $BACKUP_DIR"
    
    # Also backup from running containers that might not have host mounts
    for c in $(docker ps --format '{{.Names}}' | grep '^said-agent-'); do
      container_id=$(echo "$c" | sed 's/said-agent-//')
      dest="$BACKUP_DIR/container-$container_id"
      mkdir -p "$dest"
      
      for f in wallet.json said-identity.json identity.env; do
        docker cp "$c:/data/$f" "$dest/" 2>/dev/null || true
      done
    done
    
    # Prune old backups
    find /opt/said-hosting/backups -maxdepth 1 -type d -mtime +$RETENTION -exec rm -rf {} + 2>/dev/null || true
    echo "  Pruned backups older than $RETENTION days"
REMOTE
  
  log "Done with $ip"
done

log "All servers backed up."
