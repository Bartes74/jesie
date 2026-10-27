import 'server-only';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { editorialSchema } from './schema';
import { authSchema } from './auth-schema';
import { aiSchema } from '../ai/schema';
import { trendSchema } from '../trends/schema';
import { collectionSchema } from '../collections/schema';
import { collectionThemeSchema } from '../collections/theme-schema';

let database: ReturnType<typeof createDatabase> | undefined;

function createDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_NOT_CONFIGURED');
  const pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
  // pg emits idle connection failures; handle them without logging credentials.
  pool.on('error', () => { console.error('An idle database connection was closed.'); });
  return { pool, db: drizzle(pool, { schema: { ...editorialSchema, ...authSchema, ...aiSchema, ...trendSchema, ...collectionSchema, ...collectionThemeSchema } }) };
}

/** No connection is created or requested during module evaluation/build. */
export function getDb() {
  database ??= createDatabase();
  return database.db;
}

export async function closeDb() {
  if (database) await database.pool.end();
  database = undefined;
}
