// Booking service: fetch the caller's own reservations by id + secret (no accounts).
import { NextResponse } from "next/server";
import { HttpError, pool } from "@/lib/db";
import { readJson, requireUuid, route } from "@/lib/http";
import { lookupOwned, publicView } from "@/lib/reservations";

export const POST = route("bookings", async (req) => {
  const body = await readJson<{ items?: unknown }>(req);
  if (!Array.isArray(body.items) || body.items.length > 50) {
    throw new HttpError(400, "invalid_input", "items must be an array of at most 50 {id, secret}");
  }
  const items = body.items.map((i: { id?: unknown; secret?: unknown }) => ({
    id: requireUuid(i?.id, "id"),
    secret: requireUuid(i?.secret, "secret"),
  }));
  const rows = await lookupOwned(pool(), items);
  return NextResponse.json({ reservations: rows.map((r) => ({ ...publicView(r), secret: r.secret })) });
});
