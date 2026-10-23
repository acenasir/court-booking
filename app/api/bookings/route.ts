// Booking service: confirm a hold, or book a slot in one step (used by the load test).
import { NextResponse } from "next/server";
import { withTx } from "@/lib/db";
import { readJson, requireUuid, route } from "@/lib/http";
import {
  confirmHold,
  parseCourtId,
  parseIdempotencyKey,
  parseName,
  parseStart,
  publicView,
  takeSlot,
} from "@/lib/reservations";

type Body = {
  holdId?: unknown;
  secret?: unknown;
  name?: unknown;
  courtId?: unknown;
  start?: unknown;
  idempotencyKey?: unknown;
};

export const POST = route("bookings", async (req) => {
  const body = await readJson<Body>(req);
  const name = parseName(body.name);

  if (body.holdId !== undefined) {
    const holdId = requireUuid(body.holdId, "holdId");
    const secret = requireUuid(body.secret, "secret");
    const row = await withTx((db) => confirmHold(db, holdId, secret, name));
    return NextResponse.json({ ...publicView(row), secret: row.secret }, { status: 200 });
  }

  const input = {
    kind: "book" as const,
    name,
    courtId: parseCourtId(body.courtId),
    start: parseStart(body.start),
    idempotencyKey: parseIdempotencyKey(body.idempotencyKey ?? req.headers.get("idempotency-key")),
  };
  const { row, replayed } = await withTx((db) => takeSlot(db, input));
  return NextResponse.json({ ...publicView(row), secret: row.secret, replayed }, { status: replayed ? 200 : 201 });
});
