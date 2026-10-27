import { config } from "dotenv";
import { Pool } from "pg";

config({ path: process.argv[2] || ".env.local", quiet: true });
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) throw new Error("DATABASE_URL is missing.");
async function main() {
 const pool = new Pool({ connectionString, max: 1 });
 const client = await pool.connect();
 try {
  await client.query("BEGIN");
  await client.query(`
    CREATE TABLE IF NOT EXISTS auth_user (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text, name text NOT NULL, email text NOT NULL UNIQUE,
      email_verified boolean NOT NULL DEFAULT false, image text,
      role text NOT NULL DEFAULT 'admin' CHECK (role IN ('owner','admin')),
      disabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE auth_user ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
    CREATE UNIQUE INDEX IF NOT EXISTS auth_one_owner_idx ON auth_user(role) WHERE role = 'owner';
    CREATE TABLE IF NOT EXISTS auth_session (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text, expires_at timestamptz NOT NULL, token text NOT NULL UNIQUE,
      user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
      ip_address text, user_agent text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE auth_session ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
    CREATE INDEX IF NOT EXISTS auth_session_user_idx ON auth_session(user_id);
    CREATE TABLE IF NOT EXISTS auth_account (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text, account_id text NOT NULL, provider_id text NOT NULL,
      user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
      access_token text, refresh_token text, id_token text,
      access_token_expires_at timestamptz, refresh_token_expires_at timestamptz,
      scope text, password text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(provider_id,account_id)
    );
    ALTER TABLE auth_account ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
    CREATE INDEX IF NOT EXISTS auth_account_user_idx ON auth_account(user_id);
    CREATE TABLE IF NOT EXISTS auth_verification (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text, identifier text NOT NULL, value text NOT NULL, expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE auth_verification ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
    CREATE INDEX IF NOT EXISTS auth_verification_identifier_idx ON auth_verification(identifier);
    CREATE TABLE IF NOT EXISTS auth_rate_limit (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text, key text NOT NULL UNIQUE, count integer NOT NULL, last_request bigint NOT NULL
    );
    ALTER TABLE auth_rate_limit ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
    CREATE TABLE IF NOT EXISTS owner_activation (
      id text PRIMARY KEY CHECK (id = 'owner'), email text NOT NULL, token_hash text NOT NULL UNIQUE,
      purpose text NOT NULL DEFAULT 'activation' CHECK (purpose IN ('activation','recovery')),
      expires_at timestamptz NOT NULL, consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE owner_activation ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'activation';
    CREATE TABLE IF NOT EXISTS auth_event (
      id text PRIMARY KEY, user_id text REFERENCES auth_user(id) ON DELETE SET NULL,
      action text NOT NULL, success boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS auth_event_created_idx ON auth_event(created_at);
  `);
  await client.query("COMMIT");
  console.log("Auth migration applied.");
} catch {
  await client.query("ROLLBACK");
  throw new Error("Auth migration failed; connection details were withheld.");
} finally {
  client.release();
  await pool.end();
 }
}
main().catch(() => { console.error("Auth migration failed; connection details were withheld."); process.exitCode = 1; });
