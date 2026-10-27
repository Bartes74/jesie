import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { authSchema, user } from "@/server/db/auth-schema";
import { recordAuthEvent } from "./audit";

export function getAuthOrigin() {
  const configured = process.env.BETTER_AUTH_URL;
  if (configured) return new URL(configured).origin;
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET is not configured.");
  const baseURL = getAuthOrigin();
  return betterAuth({
    appName: "jesie.pl",
    baseURL,
    secret,
    database: drizzleAdapter(getDb(), { provider: "pg", schema: authSchema }),
    trustedOrigins: [baseURL],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      // Recovery email is deliberately disabled until Resend and a verified sender are configured.
    },
    user: {
      additionalFields: {
        role: { type: "string", input: false, defaultValue: "admin", required: true },
        disabled: { type: "boolean", input: false, defaultValue: false, required: true },
      },
    },
    session: {
      expiresIn: 60 * 60 * 12,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 300, max: 3 },
        "/reset-password": { window: 300, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: baseURL.startsWith("https://"),
      cookiePrefix: "jesie",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      database: { generateId: "uuid" },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (candidate) => {
            const [currentUser] = await getDb().select({ role: user.role, disabled: user.disabled })
              .from(user).where(eq(user.id, candidate.userId)).limit(1);
            if (!currentUser || currentUser.disabled || !["owner", "admin"].includes(currentUser.role)) {
              throw new APIError("UNAUTHORIZED", { message: "Invalid email or password" });
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/change-password" && ctx.body) ctx.body.revokeOtherSessions = true;
        if (ctx.path === "/sign-out") {
          const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
          if (token) {
            const existing = await ctx.context.internalAdapter.findSession(token);
            (ctx.context as typeof ctx.context & { auditUserId?: string }).auditUserId = existing?.user.id;
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const action = ctx.path === "/sign-in/email" ? "sign-in"
          : ctx.path === "/sign-out" ? "sign-out"
          : ctx.path === "/change-password" ? "password-change" : null;
        if (!action) return;
        const success = !(ctx.context.returned instanceof APIError)
          && (!(ctx.context.returned instanceof Response) || ctx.context.returned.status < 400);
        await recordAuthEvent(action, success, ctx.context.newSession?.user.id || ctx.context.session?.user.id
          || (ctx.context as typeof ctx.context & { auditUserId?: string }).auditUserId);
      }),
    },
    logger: { disabled: true },
    onAPIError: { onError: () => { console.error("Authentication request failed; sensitive details were withheld."); } },
  });
}

let authInstance: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  return authInstance ??= createAuth();
}
