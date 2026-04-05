# Privy Agent Wallets - Completion Checklist

## ✅ Built Tonight

1. **Database Schema**
   - Added `privyWalletId` field to Agent model
   - Stores Privy wallet ID for server-side signing

2. **Privy Wallets Service** (`src/services/privy-wallets.ts`)
   - `createAgentWallet()` - Creates Solana wallet via Privy
   - `signTransaction()` - Signs and sends transaction
   - `signTransactionOnly()` - Signs without sending

3. **Agent Creation Flow** (`src/services/agent.ts`)
   - Now creates Privy wallet before DB record
   - Stores `privyWalletId` and `walletAddress`
   - Agents get wallets automatically

4. **Signing API** (`src/routes/wallet.ts`)
   - `POST /api/wallet/agents/:id/sign` - Sign transactions
   - `GET /api/wallet/agents/:id/wallet` - Get wallet address
   - Auth via `X-Gateway-Token` header

5. **Server Integration** (`src/index.ts`)
   - Wallet routes registered

---

## 🔨 To Complete (15-30 min)

### 1. Run Database Migration
```bash
cd /Users/callum/said-hosting/platform-api
npx prisma db push
```

### 2. Environment Variables
Make sure these exist in `.env`:
```bash
PRIVY_APP_SECRET=<your-privy-app-secret>
PRIVY_AUTHORIZATION_KEY=<your-authorization-key>
PRIVY_AUTHORIZATION_KEY_ID=<your-key-id>
```

### 3. Build & Deploy
```bash
npm run build
# Then deploy to Railway
```

### 4. Test with New Agent

Create a new agent via the platform. It should:
- ✅ Create a Privy wallet automatically
- ✅ Store `privyWalletId` in database
- ✅ Agent container gets `walletAddress` but NOT private key

### 5. Test Signing Endpoint

From inside an agent container:
```bash
# Get wallet address
curl -H "X-Gateway-Token: <agent-token>" \\
  https://app.saidprotocol.com/api/wallet/agents/<agent-id>/wallet

# Sign a transaction
curl -X POST -H "X-Gateway-Token: <agent-token>" \\
  -H "Content-Type: application/json" \\
  -d '{"transaction": "<base64-tx>", "sendImmediately": true}' \\
  https://app.saidprotocol.com/api/wallet/agents/<agent-id>/sign
```

---

## 🚀 Next Phase: Container Config

Update agent containers to use signing API instead of raw keypairs:

### Option A: Update workspace generation
In `src/services/workspace.ts`, add to agent's `.env`:
```typescript
SAID_SIGNING_URL=https://app.saidprotocol.com/api/wallet/agents/${agentId}/sign
SAID_WALLET_URL=https://app.saidprotocol.com/api/wallet/agents/${agentId}/wallet
SAID_API_TOKEN=${gatewayToken}
SOLANA_WALLET_ADDRESS=${walletAddress}
```

### Option B: Agent SDK/Library
Create a simple SDK agents can import:
```typescript
import { SaidWallet } from '@said/agent-wallet';

const wallet = new SaidWallet({
  apiUrl: process.env.SAID_SIGNING_URL,
  apiToken: process.env.SAID_API_TOKEN,
});

// Agent uses this instead of raw Keypair
const signature = await wallet.signTransaction(tx);
```

---

## 🐛 Known Issues to Watch

1. **Privy Rate Limits** - May hit Privy API limits with many agents
2. **Authorization Key Rotation** - Need process for rotating auth keys
3. **Legacy Agents** - Existing agents don't have Privy wallets yet
   - Options: migrate them, or keep dual system (Privy + self-custody)

---

## 📊 Success Metrics

**Phase 1 (Tonight):**
- [ ] 1 new agent created successfully with Privy wallet
- [ ] Agent can sign SAID registration via API
- [ ] No private key in agent container/config

**Phase 2 (Next Week):**
- [ ] All new agents use Privy wallets
- [ ] SeekerClaw integration partner onboarded
- [ ] Document for external platforms to self-host

**Phase 3 (Future):**
- [ ] Extract as standalone repo (`said-wallet-service`)
- [ ] Support OWS as alternative backend
- [ ] Multi-chain expansion (if needed)
