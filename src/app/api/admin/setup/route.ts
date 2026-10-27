import { getAuthOrigin } from "@/server/auth";
import { activateOwner, limitSetupAttempts, setupSchema, SetupError } from "@/server/auth/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== getAuthOrigin() || request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "Żądanie musi pochodzić z formularza jesie.pl." }, { status: 403 });
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "Nieprawidłowy format danych." }, { status: 415 });
  }
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > 4096) return Response.json({ error: "Formularz jest zbyt duży." }, { status: 413 });
  try {
    await limitSetupAttempts(request);
    const text = await request.text();
    if (text.length > 4096) return Response.json({ error: "Formularz jest zbyt duży." }, { status: 413 });
    const parsed = setupSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return Response.json({ error: "Sprawdź adres e-mail, nazwę oraz hasło (12–128 znaków)." }, { status: 400 });
    await activateOwner(parsed.data);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SetupError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: "Nieprawidłowy format danych." }, { status: 400 });
    // Never log the body, activation capability, submitted password, or database connection details.
    return Response.json({ error: "Nie udało się aktywować konta. Spróbuj ponownie później." }, { status: 503 });
  }
}
