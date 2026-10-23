import { NextResponse } from "next/server";
import { HttpError } from "./db.ts";

type Handler = (req: Request) => Promise<Response>;

// Wraps a route handler: maps HttpError to JSON, and emits one structured log line per
// request so Vercel logs can be filtered by service, status and latency.
export function route(service: string, handler: Handler): Handler {
  return async (req) => {
    const started = performance.now();
    const requestId = req.headers.get("x-vercel-id") ?? crypto.randomUUID();
    let res: Response;
    try {
      res = await handler(req);
    } catch (err) {
      if (err instanceof HttpError) {
        res = NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
      } else {
        console.error(JSON.stringify({ service, requestId, error: String(err), stack: (err as Error)?.stack }));
        res = NextResponse.json({ error: "internal", message: "Unexpected error" }, { status: 500 });
      }
    }
    console.log(
      JSON.stringify({
        service,
        requestId,
        method: req.method,
        path: new URL(req.url).pathname,
        status: res.status,
        ms: Math.round(performance.now() - started),
      }),
    );
    return res;
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be JSON");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new HttpError(400, "invalid_input", `${field} must be a UUID`);
  return value;
}

// Dynamic segment of /api/<service>/<id>.
export function lastPathSegment(req: Request): string {
  return decodeURIComponent(new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "");
}

export function requireSecret(req: Request): string {
  return requireUuid(req.headers.get("x-reservation-secret"), "x-reservation-secret header");
}
