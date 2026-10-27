import { config, parse } from "dotenv";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

async function main() {
  config({ path: ".env.local", quiet: true });
  const production = parse(await readFile(".env.production.local"));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !production.DATABASE_URL || process.env.VERCEL_ENV === "production") throw new Error("Development database required.");
  const dev = new URL(connectionString);
  const prod = new URL(production.DATABASE_URL);
  if (dev.hostname === prod.hostname && dev.pathname === prod.pathname) throw new Error("Refusing production recovery test.");
  const credentials = JSON.parse(await readFile(".env.admin-test.json", "utf8")) as { email: string; password: string };
  assert.equal(credentials.email, "bartek@dajer.pl");
  const base = process.env.BETTER_AUTH_URL || "http://127.0.0.1:3000";
  assert.ok(base.startsWith("http://127.0.0.1:") || base.startsWith("http://localhost:"));
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000 });
  const client = await pool.connect();
  let ownerId: string | undefined;
  let originalHash: string | undefined;
  const call = async (path: string, body: unknown, cookie?: string) => fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin: base,
      "x-forwarded-for": "192.0.2.200", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const cookieFrom = (response: Response) => response.headers.get("set-cookie")?.split(";")[0] || "";
  try {
    const existing = await client.query<{ id: string; password: string }>(`
      SELECT u.id,a.password FROM auth_user u JOIN auth_account a ON a.user_id=u.id
      WHERE u.role='owner' AND u.email=$1 AND u.disabled=false AND a.provider_id='credential'
    `, [credentials.email]);
    assert.equal(existing.rowCount, 1);
    ownerId = existing.rows[0].id;
    originalHash = existing.rows[0].password;
    const originalSession = await call("/api/auth/sign-in/email", credentials);
    assert.equal(originalSession.status, 200);
    const originalCookie = cookieFrom(originalSession);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await client.query(`
      INSERT INTO owner_activation(id,email,token_hash,purpose,expires_at,consumed_at)
      VALUES('owner',$1,$2,'recovery',now()+interval '1 hour',NULL)
      ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,purpose='recovery',
        expires_at=excluded.expires_at,consumed_at=NULL
    `, [credentials.email, tokenHash]);
    const replacement = randomBytes(24).toString("base64url");
    const recovered = await call("/api/admin/setup", { token, email: credentials.email, password: replacement, name: "Recovery test" });
    assert.equal(recovered.status, 200);
    const oldSession = await fetch(`${base}/api/auth/get-session`, { headers: { cookie: originalCookie }, signal: AbortSignal.timeout(60000) });
    assert.equal(await oldSession.json(), null);
    assert.equal((await call("/api/auth/sign-in/email", credentials)).status, 401);
    assert.equal((await call("/api/auth/sign-in/email", { email: credentials.email, password: replacement })).status, 200);
    const reused = await call("/api/admin/setup", { token, email: credentials.email, password: replacement, name: "Recovery test" });
    assert.equal(reused.status, 410);
    const audit = await client.query("SELECT id FROM auth_event WHERE user_id=$1 AND action='owner-recovery' AND success=true", [ownerId]);
    assert.ok(audit.rowCount && audit.rowCount > 0);
    console.log("Owner recovery verified: replacement password, prior sessions revoked, one-time token and audit. Development password restored during cleanup.");
  } finally {
    if (ownerId && originalHash) {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(873146210)");
      await client.query("UPDATE owner_activation SET consumed_at=now() WHERE id='owner'");
      await client.query("UPDATE auth_account SET password=$1,updated_at=now() WHERE user_id=$2 AND provider_id='credential'", [originalHash, ownerId]);
      await client.query("DELETE FROM auth_session WHERE user_id=$1", [ownerId]);
      await client.query("COMMIT");
    }
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error("Owner recovery verification failed; secrets were withheld.");
  if (error instanceof Error && error.name === "AssertionError") console.error(error.message);
  process.exitCode = 1;
});
