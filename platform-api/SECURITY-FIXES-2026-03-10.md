# Security Fixes - March 10, 2026

## Summary
Fixed critical security vulnerabilities in SAID Platform API before launching hosted agents.

## Issues Fixed

### 1. Gateway Token Storage (CRITICAL)
**Problem:** Plaintext gateway tokens were stored in the database alongside hashes
- `agent.gatewayToken` field was populated with plaintext
- Created unnecessary attack surface for credential theft

**Fix:**
- Removed `gatewayToken` from database writes in `createAgent()`
- Gateway token now only returned to caller on agent creation (one-time exposure)
- Clients must store token securely and provide via `x-gateway-token` header
- Database only stores `gatewayTokenHash` for verification
- Field remains in schema as nullable for backwards compatibility

**Files changed:**
- `src/services/agent.ts` - removed `gatewayToken` from DB create operation
- `src/routes/agents.ts` - updated `/chat` endpoint to verify provided token

### 2. Chat Proxy Authentication (HIGH)
**Problem:** `/agents/:id/chat` endpoint used stored plaintext token from DB
- No verification of caller's authorization
- Relied on insecure stored credential

**Fix:**
- Endpoint now requires `x-gateway-token` header
- Token verified against stored hash using `verifyGatewayToken()`
- Returns 401 if missing, 403 if invalid
- Only verified token is used to authenticate to agent's OpenClaw gateway

**Files changed:**
- `src/routes/agents.ts` - added token verification to chat proxy

### 3. CORS Configuration (MEDIUM)
**Problem:** Development origins (localhost) exposed in production
- Wider attack surface than necessary
- No environment-based restrictions

**Fix:**
- Made CORS origin list conditional on `NODE_ENV`
- Production: Only production domains allowed
- Development: localhost + production domains
- Maintains `credentials: true` for secure cookie handling

**Files changed:**
- `src/index.ts` - conditional CORS origins

## OpenRouter Key Storage
**Status:** ✅ ALREADY SECURE
- Only hash stored in database (`openrouterKeyHash`)
- Plaintext key passed to container once at creation
- Never stored in database

## Migration Notes

### For Existing Agents
- Agents created before this fix have `gatewayToken` populated
- These will continue working (hash verification still works)
- Field is nullable, no breaking schema change
- Consider: migration script to clear old plaintext tokens

### For New Agents
- `gatewayToken` returned in API response on creation
- Dashboard/CLI must save token securely (client-side storage)
- All future requests must include `x-gateway-token` header

### For Chat Proxy Clients
**Breaking change:** `/agents/:id/chat` now requires `x-gateway-token` header

Example request:
```bash
curl -X POST https://said-platform-api.fly.dev/api/agents/{id}/chat \
  -H "Content-Type: application/json" \
  -H "x-api-key: {platform_key}" \
  -H "x-gateway-token: {agent_gateway_token}" \
  -d '{"message": "Hello"}'
```

## Testing

### Before Deploy
- [x] Code compiles without errors
- [ ] Test agent creation returns gateway token
- [ ] Test chat proxy rejects requests without token
- [ ] Test chat proxy rejects requests with invalid token
- [ ] Test chat proxy succeeds with valid token
- [ ] Verify CORS blocks unauthorized origins in production

### After Deploy
- [ ] Create test agent, verify token returned
- [ ] Test chat endpoint with valid/invalid tokens
- [ ] Monitor logs for authentication errors
- [ ] Confirm no plaintext tokens in new DB records

## Deployment Checklist

1. **Backup production database**
2. **Deploy to staging first** (if available)
3. **Update dashboard to:**
   - Save `gatewayToken` from create response
   - Send `x-gateway-token` header in chat requests
4. **Deploy platform API**
5. **Monitor for authentication errors**
6. **Update documentation** (API reference, dashboard guide)

## Future Improvements

### High Priority
- [ ] Add gateway token rotation endpoint
- [ ] Implement token expiration/refresh mechanism
- [ ] Add rate limiting per agent (prevent token abuse)
- [ ] Migrate old agents to clear stored plaintext tokens

### Medium Priority
- [ ] Add audit logging for all authentication events
- [ ] Implement IP allowlisting for high-value agents
- [ ] Add webhook for suspicious authentication patterns

### Low Priority
- [ ] Remove `gatewayToken` field from schema entirely (breaking change)
- [ ] Add support for multiple gateway tokens per agent

## References
- Gateway token generation: `src/utils/auth.ts`
- Agent service: `src/services/agent.ts`
- Routes: `src/routes/agents.ts`
- CORS config: `src/index.ts`
