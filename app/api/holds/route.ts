// Hold service: reserve a slot for a short time while the player confirms.
import { NextResponse } from "next/server";
import { withTx } from "@/lib/db";
import { readJson, route } from "@/lib/http";
import { parseCourtId, parseIdempotencyKey, parseStart, publicView, takeSlot } from "@/lib/reservations";

export const POST = route("holds", async (req) => {
  const body = await readJson<{ courtId?: unknown; start?: unknown; idempotencyKey?: unknown }>(req);
  const input = {
    kind: "hold" as const,
    courtId: parseCourtId(body.courtId),
    start: parseStart(body.start),
    idempotencyKey: parseIdempotencyKey(body.idempotencyKey ?? req.headers.get("idempotency-key")),
  };
  const { row, replayed } = await withTx((db) => takeSlot(db, input));
  return NextResponse.json({ ...publicView(row), secret: row.secret, replayed }, { status: replayed ? 200 : 201 });
});
