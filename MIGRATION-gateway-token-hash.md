# Migration: Hash Gateway Tokens

**Date:** March 9, 2026  
**Branch:** `feature/gateway-token-fix`  
**Issue:** Gateway tokens stored in plaintext in database

## Changes

### Schema Changes (`platform-api/prisma/schema.prisma`)
- Renamed `gatewayToken` → `gatewayTokenHash`
- Column now stores SHA-256 hash instead of plaintext token

### Code Changes
1. **New file:** `platform-api/src/utils/auth.ts`
   - `generateGatewayToken()` - Generate secure random token
   - `hashGatewayToken()` - SHA-256 hash function
   - `verifyGatewayToken()` - Verify plaintext against hash

2. **Updated:** `platform-api/src/services/agent.ts`
   - Import hash utilities
   - Generate token + hash on agent creation
   - Store only hash in database
   - Pass plaintext to Fly container (unchanged)

3. **Updated:** `platform-api/src/services/fly.ts`
   - Removed duplicate `createGatewayToken()` function
   - Removed unused crypto import
   - Made `gatewayToken` param required (was optional)

## Database Migration

### Option A: Automatic (via Prisma)
```bash
cd platform-api
npx prisma db push
```
This will:
- Rename `gateway_token` column to `gateway_token_hash`
- Preserve existing data (but tokens will be invalid)

### Option B: Manual SQL
```sql
-- Rename column
ALTER TABLE agents 
RENAME COLUMN gateway_token TO gateway_token_hash;

-- Optional: Clear existing tokens (they're plaintext, can't be hashed retroactively)
UPDATE agents SET gateway_token_hash = NULL;
```

## Impact

**Existing agents:** Will have plaintext tokens in the `gateway_token_hash` column. These won't work for verification. Options:
1. Clear the column (agents will need tokens regenerated)
2. Leave them (agents still have the plaintext token in their env vars and can connect)

**New agents:** Will get properly hashed tokens from creation.

## Security Notes
- Plaintext tokens are never logged or stored after hashing
- Tokens are passed to Fly machines via secure env vars
- SHA-256 is one-way - stored hashes can't be reversed
- If database is compromised, attacker can't extract working tokens

## Testing
After migration:
1. Create a new agent
2. Verify `gateway_token_hash` contains 64-char hex (SHA-256)
3. Verify agent container receives plaintext token in `OPENCLAW_GATEWAY_TOKEN`
4. Verify agent can connect to OpenClaw gateway

## Rollback
If needed:
```sql
ALTER TABLE agents 
RENAME COLUMN gateway_token_hash TO gateway_token;
```
Then revert code changes.
