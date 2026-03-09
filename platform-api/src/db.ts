import initSqlJs, { Database as SqlJsDb } from 'sql.js';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'platform.db');

let db: SqlJsDb | null = null;
let initPromise: Promise<SqlJsDb> | null = null;

export async function initDb(): Promise<SqlJsDb> {
  if (db) return db;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const SQL = await initSqlJs();
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    if (fs.existsSync(DB_PATH)) {
      db = new SQL.Database(fs.readFileSync(DB_PATH));
    } else {
      db = new SQL.Database();
    }

    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, privy_id TEXT UNIQUE, email TEXT,
      tier TEXT DEFAULT 'starter', said_pubkey TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id),
      name TEXT NOT NULL, fly_machine_id TEXT, fly_app_name TEXT,
      status TEXT DEFAULT 'creating', tier TEXT DEFAULT 'starter',
      said_identity TEXT, program_md TEXT, config TEXT, gateway_token TEXT,
      ai_credits_used REAL DEFAULT 0, ai_credits_limit REAL DEFAULT 5,
      openrouter_key_hash TEXT, openrouter_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT REFERENCES agents(id),
      type TEXT, data TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    save();
    return db;
  })();

  return initPromise;
}

/** Get db synchronously — must call initDb() first at startup */
export function getDb(): SqlJsDb {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function save() {
  if (!db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

// Helper to mimic better-sqlite3's prepare().run/get/all pattern
export function run(sql: string, params: any[] = []) {
  getDb().run(sql, params);
  save();
}

export function get(sql: string, params: any[] = []): any {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  const result = stmt.step() ? stmt.getAsObject() : undefined;
  stmt.free();
  return result;
}

export function all(sql: string, params: any[] = []): any[] {
  const results: any[] = [];
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}
