// Inventory service: read-only view of courts and slot availability.
import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { route } from "@/lib/http";
import { availability } from "@/lib/reservations";
import { CLUB } from "@/lib/club";

export const dynamic = "force-dynamic";

function todayInClub(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CLUB.timezone }).format(new Date());
}

export const GET = route("inventory", async (req) => {
  const date = new URL(req.url).searchParams.get("date") ?? todayInClub();
  const data = await availability(pool(), date);
  return NextResponse.json(
    { club: { name: CLUB.name, bookingWindowDays: CLUB.bookingWindowDays, holdSeconds: CLUB.holdSeconds }, ...data },
    // Availability is read far more than it is written. A 1s edge cache absorbs the
    // refresh storm when booking opens; the DB constraint still guards every write.
    { headers: { "Cache-Control": "public, s-maxage=1, stale-while-revalidate=2" } },
  );
});
