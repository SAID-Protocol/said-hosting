import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export async function initDb(): Promise<void> {
  await prisma.$connect();
  console.log('Connected to PostgreSQL via Prisma');
}
