// ============================================================================
//  DATABASE CONNECTION
//  One shared connection Pool for the whole app. A Pool reuses a set of open
//  connections instead of opening a new one per query — that's how you handle
//  many concurrent requests efficiently (relevant to their scaling question).
// ============================================================================
import { Pool } from 'pg';
import 'dotenv/config';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon (and most hosted Postgres) require SSL. Local Postgres does not.
  ssl: process.env.DATABASE_URL?.includes('localhost') ||
       process.env.DATABASE_URL?.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false },
});

// Small helper so callers write `await query('SELECT ...', [params])`.
// Parameterised queries ($1, $2) — never string-concatenate user input.
// This is how you prevent SQL injection.
export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

// A tiny unique-id generator so we don't need an ORM. Good enough for a demo;
// in production you'd use uuid or cuid. Sortable-ish (time prefix) which helps.
export function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
