import { config, parse } from "dotenv";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

let phase = "configuration";

async function main() {
  config({ path: ".env.local", quiet: true });
  const production = parse(await readFile(".env.production.local"));
  const sameDatabase = process.env.DATABASE_URL && production.DATABASE_URL
    && new URL(process.env.DATABASE_URL).hostname === new URL(production.DATABASE_URL).hostname
    && new URL(process.env.DATABASE_URL).pathname === new URL(production.DATABASE_URL).pathname;
  if (!process.env.DATABASE_URL || sameDatabase || process.env.VERCEL_ENV === "production") {
    throw new Error("Refusing production verification.");
  }
  const { getDb, closeDb } = await import("../src/server/db");
  const { user, account, authEvent } = await import("../src/server/db/auth-schema");
  const { getAuth, getAuthOrigin, getAdminSession } = await import("../src/server/auth");
  const { hashPassword } = await import("better-auth/crypto");
  const { and, eq, gt, sql } = await import("drizzle-orm");
  const id = randomUUID();
  const email = `auth-test-${id}@example.invalid`;
  const password = randomBytes(24).toString("base64url");
  const replacement = randomBytes(24).toString("base64url");
  const base = getAuthOrigin();
  const start = new Date();
  let address = 1;
  const call = async (path: string, body: unknown, cookie?: string, origin = base) => getAuth().handler(new Request(`${base}/api/auth${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin,
      "x-forwarded-for": `192.0.2.${address++}`, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  }));
  const cookieFrom = (response: Response) => {
    const header = response.headers.get("set-cookie");
    assert.ok(header?.includes("HttpOnly"));
    assert.ok(header?.includes("SameSite=Lax"));
    return header!.split(";")[0];
  };
  try {
    phase = "fixture";
    await getDb().insert(user).values({ id, email, name: "Auth verification", role: "admin", disabled: false });
    await getDb().insert(account).values({ id: randomUUID(), userId: id, accountId: id, providerId: "credential", password: await hashPassword(password) });
    assert.equal(await getAdminSession(new Headers()), null);
    phase = "registration";
    const signup = await call("/sign-up/email", { email: `new-${email}`, password, name: "No public signup" });
    assert.equal(signup.status, 400);
    phase = "incorrect password";
    const denied = await call("/sign-in/email", { email, password: "Wrong secret for verification" });
    assert.equal(denied.status, 401);
    phase = "origin check";
    const crossOrigin = await call("/sign-in/email", { email, password }, undefined, "https://untrusted.invalid");
    assert.equal(crossOrigin.status, 403);
    phase = "sign-in and cookie";
    const signedIn = await call("/sign-in/email", { email, password });
    assert.equal(signedIn.status, 200);
    const cookie = cookieFrom(signedIn);
    assert.equal((await getAdminSession(new Headers({ cookie })))?.user.role, "admin");
    phase = "role spoofing";
    const spoof = await call("/update-user", { name: "Auth verification", role: "owner", disabled: false }, cookie);
    assert.equal(spoof.status, 400, "Server-only authorization fields must be rejected by the user update endpoint.");
    assert.equal((await getAdminSession(new Headers({ cookie })))?.user.role, "admin");
    phase = "disabled account";
    await getDb().update(user).set({ disabled: true }).where(eq(user.id, id));
    assert.equal(await getAdminSession(new Headers({ cookie })), null);
    assert.equal((await call("/sign-in/email", { email, password })).status, 401);
    await getDb().update(user).set({ disabled: false }).where(eq(user.id, id));
    phase = "password change";
    const changed = await call("/change-password", { currentPassword: password, newPassword: replacement, revokeOtherSessions: false }, cookie);
    assert.equal(changed.status, 200);
    assert.equal(await getAdminSession(new Headers({ cookie })), null, "Password change must invalidate the old session even when client says false.");
    const changedCookie = cookieFrom(changed);
    assert.equal((await getAdminSession(new Headers({ cookie: changedCookie })))?.user.id, id);
    assert.equal((await call("/sign-in/email", { email, password })).status, 401);
    phase = "sign-out";
    const signedOut = await call("/sign-out", {}, changedCookie);
    assert.equal(signedOut.status, 200);
    assert.equal(await getAdminSession(new Headers({ cookie: changedCookie })), null);
    phase = "durable rate limit";
    const limitAddress = `198.51.100.${randomBytes(1)[0] % 250 + 1}`;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await getAuth().handler(new Request(`${base}/api/auth/sign-in/email`, {
        method: "POST", headers: { "content-type": "application/json", origin: base, "x-forwarded-for": limitAddress },
        body: JSON.stringify({ email, password: "Invalid password for limit test" }),
      }));
      assert.equal(response.status, attempt === 5 ? 429 : 401);
    }
    const durableCounter = await getDb().execute(sql`SELECT count FROM auth_rate_limit WHERE key LIKE ${`%${limitAddress}%`}`);
    assert.ok(durableCounter.rows.length > 0);
    phase = "audit";
    const events = await getDb().select({ action: authEvent.action, success: authEvent.success })
      .from(authEvent).where(and(eq(authEvent.userId, id), gt(authEvent.createdAt, start)));
    assert.ok(events.some(event => event.action === "sign-in" && event.success));
    assert.ok(events.some(event => event.action === "password-change" && event.success));
    console.log("Auth verification passed: signup blocked, origin checked, sign-in, roles, disabled access, password rotation, logout, durable rate limit and audit.");
  } finally {
    await getDb().delete(user).where(eq(user.id, id));
    await closeDb();
  }
}

main().catch(error => {
  console.error(`Auth verification failed during ${phase}; secrets were withheld.`);
  if (error instanceof Error) {
    console.error(error.name);
    if (error.name === "AssertionError") console.error(error.message);
    else console.error(error.stack?.split("\n").slice(1, 4).join("\n"));
  }
  process.exitCode = 1;
});
