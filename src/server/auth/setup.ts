import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db";
import { account, authEvent, ownerActivation, rateLimit, session, user } from "@/server/db/auth-schema";

export const OWNER_EMAIL = "bartek@dajer.pl";
export const setupSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  email: z.email().transform((value) => value.trim().toLowerCase()),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(12).max(128),
}).strict();

export class SetupError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "SetupError";
  }
}

export function activationHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function limitSetupAttempts(request: Request) {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip") || "local";
  const key = `owner-setup:${activationHash(address)}`;
  const now = Date.now();
  const cutoff = now - 15 * 60 * 1000;
  const [counter] = await getDb().insert(rateLimit).values({ id: randomUUID(), key, count: 1, lastRequest: now })
    .onConflictDoUpdate({
      target: rateLimit.key,
      set: {
        count: sql`CASE WHEN ${rateLimit.lastRequest} < ${cutoff} THEN 1 ELSE ${rateLimit.count} + 1 END`,
        lastRequest: sql`CASE WHEN ${rateLimit.lastRequest} < ${cutoff} THEN ${now} ELSE ${rateLimit.lastRequest} END`,
      },
    }).returning({ count: rateLimit.count });
  if (counter.count > 5) throw new SetupError(429, "Zbyt wiele prób. Spróbuj ponownie za 15 minut.");
}

export async function activateOwner(input: z.infer<typeof setupSchema>) {
  const invalid = () => new SetupError(410, "Link aktywacyjny jest nieprawidłowy, wygasł lub został już wykorzystany.");
  if (input.email !== OWNER_EMAIL) throw invalid();
  const tokenHash = activationHash(input.token);
  const now = new Date();
  // Reject invalid links before doing expensive password hashing. The transaction repeats this check.
  const [candidate] = await getDb().select({ id: ownerActivation.id }).from(ownerActivation).where(and(
    eq(ownerActivation.id, "owner"), eq(ownerActivation.email, OWNER_EMAIL),
    eq(ownerActivation.tokenHash, tokenHash), gt(ownerActivation.expiresAt, now), isNull(ownerActivation.consumedAt),
  )).limit(1);
  if (!candidate) throw invalid();
  const passwordHash = await hashPassword(input.password);
  await getDb().transaction(async (tx) => {
    // Serialize provisioning with the local activation command, including token replacement.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(873146210)`);
    const [existingOwner] = await tx.select({ id: user.id, email: user.email, disabled: user.disabled }).from(user).where(eq(user.role, "owner")).limit(1);
    const [consumed] = await tx.update(ownerActivation).set({ consumedAt: new Date() }).where(and(
      eq(ownerActivation.id, "owner"), eq(ownerActivation.email, OWNER_EMAIL),
      eq(ownerActivation.tokenHash, tokenHash), gt(ownerActivation.expiresAt, new Date()), isNull(ownerActivation.consumedAt),
    )).returning({ id: ownerActivation.id, purpose: ownerActivation.purpose });
    if (!consumed) throw invalid();
    if (consumed.purpose === "recovery") {
      if (!existingOwner || existingOwner.email !== OWNER_EMAIL || existingOwner.disabled) throw invalid();
      const changed = await tx.update(account).set({ password: passwordHash, updatedAt: new Date() })
        .where(and(eq(account.userId, existingOwner.id), eq(account.providerId, "credential")))
        .returning({ id: account.id });
      if (changed.length !== 1) throw invalid();
      await tx.delete(session).where(eq(session.userId, existingOwner.id));
      await tx.insert(authEvent).values({ id: randomUUID(), userId: existingOwner.id, action: "owner-recovery", success: true });
      return;
    }
    if (consumed.purpose !== "activation" || existingOwner) throw invalid();
    const userId = randomUUID();
    await tx.insert(user).values({
      id: userId, email: OWNER_EMAIL, name: input.name, role: "owner", disabled: false,
      // Identity is established through the private setup capability, without claiming email verification.
      emailVerified: false,
    });
    await tx.insert(account).values({
      id: randomUUID(), userId, accountId: userId, providerId: "credential", password: passwordHash,
    });
    await tx.insert(authEvent).values({ id: randomUUID(), userId, action: "owner-activation", success: true });
  });
}
