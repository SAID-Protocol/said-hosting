import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { initDb, prisma } from './db';
import { agentRouter } from './routes/agents';
import { billingRouter } from './routes/billing';
import { balanceRouter } from './routes/balance';
import { aiProxyRouter } from './routes/ai-proxy';
import { runBillingCron } from './services/billing';
import { authMiddleware } from './middleware/auth';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const PORT = process.env.PORT || 3002;

// --- Rate limiting ---
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const agentCreateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many agent creation requests, slow down' },
});

const billingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many billing requests, slow down' },
});

const allowedOrigins = process.env.NODE_ENV === 'production'
  ? [
      'https://www.saidprotocol.com',
      'https://saidprotocol.com',
      'https://app.saidprotocol.com',
      'https://agent-creation-new-production.up.railway.app',
      'https://host.saidprotocol.com',
    ]
  : [
      'https://www.saidprotocol.com',
      'https://saidprotocol.com',
      'https://app.saidprotocol.com',
      'https://agent-creation-new-production.up.railway.app',
      'http://localhost:3000',
      'http://localhost:3001',
      'https://host.saidprotocol.com',
      'https://hosting-site-test-production.up.railway.app',
    ];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json());
app.use(generalLimiter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.3.0' });
});

// Admin: manual billing cron trigger
app.post('/api/admin/run-billing', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    await runBillingCron();
    res.json({ success: true, message: 'Billing cron completed' });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Billing cron failed' });
  }
});

// Public stats endpoint
app.get('/api/stats', async (_req, res) => {
  try {
    const totalAgents = await prisma.agent.count();
    const activeAgents = await prisma.agent.count({ where: { status: 'running' } });
    const totalUsers = await prisma.user.count();
    const paidUsers = await prisma.user.count({ where: { billingStatus: { in: ['active', 'trial'] } } });
    const trialsUsed = await prisma.user.count({ where: { billingStatus: 'trial' } });
    const trialsTotal = 40;
    const trialsRemaining = Math.max(0, trialsTotal - trialsUsed);
    res.json({ totalAgents, activeAgents, totalUsers, paidUsers, trialsUsed, trialsTotal, trialsRemaining });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.use('/api/agents', authMiddleware, agentCreateLimiter, agentRouter);
app.use('/api/billing', authMiddleware, billingLimiter, billingRouter);
app.use('/api/balance', balanceRouter); // Public endpoint - no auth needed
app.use('/api/ai-proxy', aiProxyRouter); // AI proxy for trial agents - auth via x-agent-id header

async function start() {
  await initDb();

  // Create default admin user if not exists (dev only)
  const defaultUser = await prisma.user.findUnique({ where: { id: 'default-user' } });
  if (!defaultUser) {
    await prisma.user.create({
      data: { id: 'default-user', email: 'admin@saidprotocol.com', tier: 'power' },
    });
  }

  app.listen(PORT, () => {
    console.log(`SAID Platform API v0.2.0 running on port ${PORT}`);
    
    // Run billing cron daily at midnight UTC
    const scheduleBillingCron = () => {
      const now = new Date();
      const nextMidnight = new Date(now);
      nextMidnight.setUTCHours(24, 0, 0, 0);
      const msUntilMidnight = nextMidnight.getTime() - now.getTime();
      
      setTimeout(() => {
        runBillingCron().catch(err => console.error('[billing cron] Error:', err));
        // Then run every 24 hours
        setInterval(() => {
          runBillingCron().catch(err => console.error('[billing cron] Error:', err));
        }, 24 * 60 * 60 * 1000);
      }, msUntilMidnight);
      
      console.log(`[billing] Cron scheduled — next run in ${Math.round(msUntilMidnight / 60000)} minutes`);
    };
    
    scheduleBillingCron();
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
