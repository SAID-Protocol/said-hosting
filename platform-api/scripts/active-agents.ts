/**
 * Show active hosted agents by day, based on the Activity table.
 * Each row in Activity represents a real action (prompt, tool call, etc.).
 *
 * Usage:
 *   node -r ts-node/register scripts/active-agents.ts            # last 7 days
 *   node -r ts-node/register scripts/active-agents.ts --days 30  # last 30 days
 *
 * Optional:
 *   DB_URL=mysql://user:pass@host:3306/db node -r ts-node/register scripts/active-agents.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: process.env.DB_URL
    ? {
        db: {
          url: process.env.DB_URL,
        },
      }
    : undefined,
});

const args = process.argv.slice(2);
const daysArg = args.indexOf('--days');
const days = daysArg !== -1 ? parseInt(args[daysArg + 1], 10) : 7;

function toDateKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.activity.findMany({
    where: { createdAt: { gte: since } },
    select: {
      agentId: true,
      type: true,
      createdAt: true,
      agent: {
        select: { name: true, status: true, platform: true, partnerId: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (rows.length === 0) {
    console.log(`No activity in the last ${days} days.`);
    return;
  }

  // Build: day → agentId → { name, platform, types, count }
  type AgentDay = { name: string; platform: string | null; types: Set<string>; count: number };
  const byDay: Record<string, Record<string, AgentDay>> = {};

  for (const row of rows) {
    const day = toDateKey(row.createdAt);
    (byDay[day] ??= {});
    const bucket = (byDay[day][row.agentId] ??= {
      name: row.agent.name,
      platform: row.agent.platform,
      types: new Set(),
      count: 0,
    });
    bucket.types.add(row.type);
    bucket.count++;
  }

  // Total unique agents across window
  const allAgents = new Set(rows.map((r) => r.agentId));

  console.log(`\n=== SAID Hosting — Active Agents (last ${days} days) ===\n`);
  console.log(`Total unique active agents: ${allAgents.size}`);
  console.log(`Total activity rows: ${rows.length}\n`);

  for (const day of Object.keys(byDay).sort().reverse()) {
    const agentMap = byDay[day];
    const agentList = Object.entries(agentMap);
    console.log(`${day}  (${agentList.length} agent${agentList.length === 1 ? '' : 's'}, ${agentList.reduce((s, [, v]) => s + v.count, 0)} events)`);
    for (const [, a] of agentList.sort((x, y) => y[1].count - x[1].count)) {
      const src = a.platform ?? 'direct';
      console.log(
        `  ${a.name.padEnd(32)} [${src}]  events=${a.count}  types=${[...a.types].join(',')}`
      );
    }
    console.log();
  }
}

main()
  .catch((error) => {
    console.error(error);
    if (
      String(error).includes('User was denied access on the database') ||
      String(error).includes('Access denied')
    ) {
      console.error('\nTip: set DB_URL to a user with read access, for example:');
      console.error('  DB_URL=mysql://USER:PASS@HOST:3306/DB node -r ts-node/register scripts/active-agents.ts --days 7');
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
