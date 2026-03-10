import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initDb, prisma } from './db';
import { agentRouter } from './routes/agents';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors({
  origin: [
    'https://www.saidprotocol.com',
    'https://saidprotocol.com',
    'https://app.saidprotocol.com',
    'https://agent-creation-new-production.up.railway.app',
    'http://localhost:3000',
    'http://localhost:3001',
  ],
  credentials: true,
}));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.2.0' });
});

app.use('/api/agents', agentRouter);

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
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
