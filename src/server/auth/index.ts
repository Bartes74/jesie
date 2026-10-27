import "server-only";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { user } from "@/server/db/auth-schema";
import { getAuth } from "./config";

export { getAuth, getAuthOrigin } from "./config";
export type AdminRole = "owner" | "admin";

export class AdminAccessError extends Error {
  constructor(message = "Brak dostępu do redakcji.", public readonly status: number = 401) {
    super(message);
    this.name = "AdminAccessError";
  }
}

export async function getAdminSession(requestHeaders?: Headers) {
  const resolvedHeaders = requestHeaders ?? await headers();
  let current;
  try {
    current = await getAuth().api.getSession({ headers: resolvedHeaders });
  } catch {
    throw new AdminAccessError("Logowanie jest chwilowo niedostępne. Spróbuj ponownie za chwilę.", 503);
  }
  if (!current) return null;
  const [liveUser] = await getDb().select({
    id: user.id, email: user.email, name: user.name, role: user.role, disabled: user.disabled,
  }).from(user).where(eq(user.id, current.user.id)).limit(1);
  if (!liveUser || liveUser.disabled || (liveUser.role !== "owner" && liveUser.role !== "admin")) return null;
  return {
    session: current.session,
    user: { id: liveUser.id, email: liveUser.email, name: liveUser.name, role: liveUser.role as AdminRole },
  };
}

export async function requireAdmin(requestHeaders?: Headers) {
  const current = await getAdminSession(requestHeaders);
  if (!current) throw new AdminAccessError();
  return current;
}

export async function requireOwner(requestHeaders?: Headers) {
  const current = await requireAdmin(requestHeaders);
  if (current.user.role !== "owner") throw new AdminAccessError("Dostęp wymaga konta właściciela.", 403);
  return current;
}
