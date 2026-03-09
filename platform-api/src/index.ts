import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initDb, run, get } from './db';
import { agentRouter } from './routes/agents';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors({
  origin: [
    'https://www.saidprotocol.com',
    'https://saidprotocol.com',
    'http://localhost:3000',  // local dev
    'http://localhost:3001',
  ],
  credentials: true,
}));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' });
});

app.use('/api/agents', agentRouter);

async function start() {
  await initDb();

  // Create default user if not exists
  const defaultUser = get('SELECT id FROM users WHERE id = ?', ['default-user']);
  if (!defaultUser) {
    run('INSERT INTO users (id, email, tier) VALUES (?, ?, ?)', ['default-user', 'admin@saidprotocol.com', 'power']);
  }

  app.listen(PORT, () => {
    console.log(`SAID Platform API running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
