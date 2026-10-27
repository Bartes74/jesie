import { config, parse } from "dotenv";
import { readFile, unlink } from "node:fs/promises";
import { Pool } from "pg";

async function main() {
  if (!process.argv.includes("--confirm-development-cleanup")) throw new Error("Explicit development cleanup confirmation is required.");
  config({ path: ".env.local", quiet: true });
  const production = parse(await readFile(".env.production.local"));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !production.DATABASE_URL || process.env.VERCEL_ENV === "production") throw new Error("Development database required.");
  const dev = new URL(connectionString);
  const prod = new URL(production.DATABASE_URL);
  if (dev.hostname === prod.hostname && dev.pathname === prod.pathname) throw new Error("Refusing production cleanup.");
  const credentials = JSON.parse(await readFile(".env.admin-test.json", "utf8")) as { email: string };
  if (credentials.email !== "bartek@dajer.pl") throw new Error("Unexpected test identity.");
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(873146210)");
    const sessions = await client.query("SELECT count(*)::int AS count FROM auth_session WHERE user_id IN (SELECT id FROM auth_user WHERE email=$1 AND role='owner')", [credentials.email]);
    const deleted = await client.query("DELETE FROM auth_user WHERE email=$1 AND role='owner' RETURNING id", [credentials.email]);
    const activation = await client.query("DELETE FROM owner_activation WHERE email=$1", [credentials.email]);
    await client.query("COMMIT");
    await unlink(".env.admin-test.json");
    console.log(JSON.stringify({ developmentOwnerDeleted: deleted.rowCount, sessionsRemoved: sessions.rows[0].count, activationRemoved: activation.rowCount, credentialFileRemoved: true }));
  } catch {
    await client.query("ROLLBACK");
    throw new Error("Test cleanup failed; secrets were withheld.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(() => { console.error("Test cleanup was not completed; production was not targeted."); process.exitCode = 1; });
