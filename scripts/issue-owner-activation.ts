import { config } from "dotenv";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";

// Usage: tsx scripts/issue-owner-activation.ts .env.production.local https://zgotujsobie.vercel.app
// The secret is written only to .env.owner-activation-link (ignored by existing .env* rules).
const recovery = process.argv.includes("--recover");
const args = process.argv.slice(2).filter(arg => arg !== "--recover");
config({ path: args[0] || ".env.local", quiet: true });
const origin = new URL(args[1] || process.env.BETTER_AUTH_URL || "http://localhost:3000").origin;
if (!origin.startsWith("https://") && !["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin)) {
  throw new Error("Use an HTTPS origin for owner activation.");
}
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) throw new Error("DATABASE_URL is missing.");
async function main() {
 const pool = new Pool({ connectionString, max: 1 });
 const client = await pool.connect();
 const outputPath = resolve(args[2] || (recovery ? ".env.owner-recovery-link" : ".env.owner-activation-link"));
 try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(873146210)");
  const existing = await client.query("SELECT id FROM auth_user WHERE role = 'owner' LIMIT 1");
  if (recovery ? !existing.rowCount : existing.rowCount) throw new Error("Owner state does not match requested operation.");
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await client.query(`
    INSERT INTO owner_activation(id,email,token_hash,purpose,expires_at,consumed_at,created_at)
    VALUES('owner',$1,$2,$3,now()+($4::text || ' hours')::interval,NULL,now())
    ON CONFLICT(id) DO UPDATE SET email=excluded.email,token_hash=excluded.token_hash,
      purpose=excluded.purpose,expires_at=excluded.expires_at,consumed_at=NULL,created_at=excluded.created_at
  `, ["bartek@dajer.pl", tokenHash, recovery ? "recovery" : "activation", recovery ? 1 : 24]);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${origin}/admin/setup#token=${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(outputPath, 0o600);
  await client.query("COMMIT");
  console.log(`Owner ${recovery ? "recovery" : "activation"} link saved to a restricted local file; it expires in ${recovery ? "1 hour" : "24 hours"}.`);
} catch {
  await client.query("ROLLBACK");
  throw new Error("Activation was not issued; connection details and token were withheld.");
} finally {
  client.release();
  await pool.end();
 }
}
main().catch(() => { console.error("Activation was not issued; connection details and token were withheld."); process.exitCode = 1; });
