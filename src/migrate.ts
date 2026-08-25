// ============================================================================
//  MIGRATE — creates all tables by running db/schema.sql.
//  Run with:  npm run db:migrate
// ============================================================================
import { readFileSync } from 'fs';
import { join } from 'path';
import { pool } from './db';

async function main() {
  const sql = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('✓ Schema applied — all tables created.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
