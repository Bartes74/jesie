import "server-only";
import { randomUUID } from "node:crypto";
import { getDb } from "@/server/db";
import { authEvent } from "@/server/db/auth-schema";

export async function recordAuthEvent(action: string, success: boolean, userId?: string | null) {
  await getDb().insert(authEvent).values({ id: randomUUID(), action, success, userId: userId || null });
}
