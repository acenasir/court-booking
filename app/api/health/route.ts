// Health service: point uptime checks and dashboards here. 503 when the database is unreachable.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { route } from "@/lib/http";
import { stats } from "@/lib/reservations";

export const dynamic = "force-dynamic";

export const GET = route("health", async () => {
  const started = performance.now();
  try {
    const counts = await stats(pool());
    return NextResponse.json(
      { status: "ok", db: { ok: true, latencyMs: Math.round(performance.now() - started) }, reservations: counts },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { status: "degraded", db: { ok: false, error: (err as Error).message } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
});
