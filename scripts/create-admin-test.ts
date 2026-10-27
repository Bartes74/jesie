import { config, parse } from "dotenv";
import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";

async function main() {
  config({ path: ".env.local", quiet: true });
  const production = parse(await readFile(".env.production.local"));
  const sameDatabase = process.env.DATABASE_URL && production.DATABASE_URL
    && new URL(process.env.DATABASE_URL).hostname === new URL(production.DATABASE_URL).hostname
    && new URL(process.env.DATABASE_URL).pathname === new URL(production.DATABASE_URL).pathname;
  if (!process.env.DATABASE_URL || sameDatabase || process.env.VERCEL_ENV === "production") {
    throw new Error("Refusing production test setup.");
  }
  const { getDb, closeDb } = await import("../src/server/db");
  const { ownerActivation, user } = await import("../src/server/db/auth-schema");
  const { activateOwner, activationHash, OWNER_EMAIL } = await import("../src/server/auth/setup");
  const { eq } = await import("drizzle-orm");
  try {
    const [existing] = await getDb().select({ id: user.id }).from(user).where(eq(user.role, "owner")).limit(1);
    if (existing) throw new Error("Development owner exists; use its existing test credential file.");
    const token = randomBytes(32).toString("base64url");
    const password = randomBytes(24).toString("base64url");
    await getDb().insert(ownerActivation).values({
      id: "owner", email: OWNER_EMAIL, tokenHash: activationHash(token), purpose: "activation", expiresAt: new Date(Date.now() + 60000),
    }).onConflictDoUpdate({ target: ownerActivation.id, set: {
      tokenHash: activationHash(token), purpose: "activation", expiresAt: new Date(Date.now() + 60000), consumedAt: null,
    } });
    await activateOwner({ token, email: OWNER_EMAIL, password, name: "Test redakcji" });
    await writeFile(".env.admin-test.json", JSON.stringify({ email: OWNER_EMAIL, password }), { mode: 0o600 });
    await chmod(".env.admin-test.json", 0o600);
    console.log("Development test owner created. Credentials saved to restricted ignored file.");
  } finally {
    await closeDb();
  }
}

main().catch(() => { console.error("Test setup failed; secrets were withheld."); process.exitCode = 1; });
