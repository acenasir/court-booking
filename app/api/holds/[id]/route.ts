// Hold service: release a hold early.
import { NextResponse } from "next/server";
import { withTx } from "@/lib/db";
import { lastPathSegment, requireSecret, requireUuid, route } from "@/lib/http";
import { cancelReservation, publicView } from "@/lib/reservations";

export const DELETE = route("holds", async (req) => {
  const id = requireUuid(lastPathSegment(req), "id");
  const secret = requireSecret(req);
  const row = await withTx((db) => cancelReservation(db, id, secret));
  return NextResponse.json(publicView(row));
});
