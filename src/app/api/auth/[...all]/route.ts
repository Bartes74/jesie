import { getAuth } from "@/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request) {
  try {
    return await getAuth().handler(request);
  } catch {
    console.error("Authentication service unavailable; sensitive details were withheld.");
    return Response.json({ code: "AUTH_UNAVAILABLE", message: "Logowanie jest chwilowo niedostępne. Spróbuj ponownie za chwilę." }, {
      status: 503, headers: { "Cache-Control": "private, no-store" },
    });
  }
}

export const GET = handle;
export const POST = handle;
