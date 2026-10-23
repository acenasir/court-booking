// Core booking logic. Every function takes a Db so it runs the same against pg (prod) and
// PGlite (tests). Callers that write must run inside a transaction (see withTx).
//
// Correctness does not depend on this code being race-free: the reservations_no_overlap
// EXCLUDE constraint in db/schema.sql is the single source of truth. This module only
// turns constraint violations into friendly HTTP errors.
import { CLUB } from "./club.ts";
import { HttpError, PG, pgCode, type Db } from "./db.ts";

export type ReservationRow = {
  id: string;
  court_id: number;
  start: string;
  end: string;
  status: "held" | "confirmed" | "cancelled";
  holder_name: string | null;
  secret: string;
  expires_at: string | null;
};

const RETURNING = `id, court_id, lower(during) AS start, upper(during) AS "end", status, holder_name, secret, expires_at`;

export function publicView(r: ReservationRow) {
  return {
    id: r.id,
    courtId: r.court_id,
    start: new Date(r.start).toISOString(),
    end: new Date(r.end).toISOString(),
    status: r.status === "held" && r.expires_at && new Date(r.expires_at) <= new Date() ? "expired" : r.status,
    holderName: r.holder_name,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
  };
}

export function parseCourtId(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 32767) throw new HttpError(400, "invalid_input", "courtId must be an integer");
  return n;
}

export function parseStart(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, "invalid_input", "start must be an ISO-8601 timestamp");
  }
  return new Date(value).toISOString();
}

export function parseName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 1 || name.length > 60) throw new HttpError(400, "invalid_input", "name must be 1-60 characters");
  return name;
}

export function parseIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 100) {
    throw new HttpError(400, "invalid_input", "idempotencyKey must be a string of at most 100 characters");
  }
  return value;
}

// Rejects slots that are not on the club's grid, in the past, or beyond the booking window.
async function assertBookableSlot(db: Db, courtId: number, start: string): Promise<void> {
  const { rows } = await db.query<{
    court_ok: boolean;
    h: number;
    m: number;
    s: number;
    future: boolean;
    in_window: boolean;
  }>(
    `SELECT EXISTS (SELECT 1 FROM courts WHERE id = $1) AS court_ok,
            extract(hour FROM l)::int AS h,
            extract(minute FROM l)::int AS m,
            extract(second FROM l)::float8 AS s,
            $2::timestamptz > now() AS future,
            $2::timestamptz <= now() + make_interval(days => $4::int) AS in_window
       FROM (SELECT $2::timestamptz AT TIME ZONE $3 AS l) x`,
    [courtId, start, CLUB.timezone, CLUB.bookingWindowDays],
  );
  const v = rows[0];
  if (!v.court_ok) throw new HttpError(404, "court_not_found", `No court with id ${courtId}`);
  const minuteOfDay = v.h * 60 + v.m;
  const onGrid =
    v.s === 0 &&
    minuteOfDay >= CLUB.openHour * 60 &&
    minuteOfDay + CLUB.slotMinutes <= CLUB.closeHour * 60 &&
    (minuteOfDay - CLUB.openHour * 60) % CLUB.slotMinutes === 0;
  if (!onGrid) throw new HttpError(400, "invalid_slot", "start is not a valid slot start for this club");
  if (!v.future) throw new HttpError(400, "slot_in_past", "That slot has already started");
  if (!v.in_window) {
    throw new HttpError(400, "outside_booking_window", `Bookings open ${CLUB.bookingWindowDays} days in advance`);
  }
}

async function findByIdempotencyKey(db: Db, key: string): Promise<ReservationRow | undefined> {
  const { rows } = await db.query<ReservationRow>(`SELECT ${RETURNING} FROM reservations WHERE idempotency_key = $1`, [key]);
  return rows[0];
}

type TakeSlotInput = {
  courtId: number;
  start: string;
  idempotencyKey: string | null;
} & ({ kind: "hold" } | { kind: "book"; name: string });

// Creates a hold or a confirmed booking. Returns replayed=true when the idempotency key was
// already used, so clients can retry a timed-out request safely.
export async function takeSlot(db: Db, input: TakeSlotInput): Promise<{ row: ReservationRow; replayed: boolean }> {
  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(db, input.idempotencyKey);
    if (existing) return { row: existing, replayed: true };
  }

  await assertBookableSlot(db, input.courtId, input.start);
  const minutes = CLUB.slotMinutes;

  // Release expired holds that overlap this slot. Concurrent takers serialize on these row
  // locks; whoever inserts second hits the exclusion constraint.
  await db.query(
    `UPDATE reservations SET status = 'cancelled', cancelled_at = now()
      WHERE court_id = $1 AND status = 'held' AND expires_at <= now()
        AND during && tstzrange($2::timestamptz, $2::timestamptz + make_interval(mins => $3::int))`,
    [input.courtId, input.start, minutes],
  );

  try {
    const { rows } = await db.query<ReservationRow>(
      `INSERT INTO reservations (court_id, during, status, holder_name, idempotency_key, expires_at, confirmed_at)
       VALUES ($1, tstzrange($2::timestamptz, $2::timestamptz + make_interval(mins => $3::int)), $4, $5, $6,
               CASE WHEN $4 = 'held' THEN now() + make_interval(secs => $7::int) END,
               CASE WHEN $4 = 'confirmed' THEN now() END)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${RETURNING}`,
      [
        input.courtId,
        input.start,
        minutes,
        input.kind === "hold" ? "held" : "confirmed",
        input.kind === "book" ? input.name : null,
        input.idempotencyKey,
        CLUB.holdSeconds,
      ],
    );
    if (rows[0]) return { row: rows[0], replayed: false };
    // A concurrent request with the same idempotency key won the insert.
    const existing = await findByIdempotencyKey(db, input.idempotencyKey!);
    if (!existing) throw new Error("idempotency conflict without a row");
    return { row: existing, replayed: true };
  } catch (err) {
    if (pgCode(err) === PG.exclusionViolation) throw new HttpError(409, "slot_taken", "Someone else has that slot");
    throw err;
  }
}

// Turns a live hold into a confirmed booking. Idempotent: confirming twice returns the booking.
export async function confirmHold(db: Db, id: string, secret: string, name: string): Promise<ReservationRow> {
  const { rows } = await db.query<ReservationRow>(
    `UPDATE reservations
        SET status = 'confirmed', holder_name = $3, confirmed_at = now(), expires_at = NULL
      WHERE id = $1 AND secret = $2 AND status = 'held' AND expires_at > now()
      RETURNING ${RETURNING}`,
    [id, secret, name],
  );
  if (rows[0]) return rows[0];

  const current = await getOwned(db, id, secret);
  if (current.status === "confirmed") return current;
  throw new HttpError(410, "hold_expired", "That hold expired or was released. Try the slot again.");
}

export async function cancelReservation(db: Db, id: string, secret: string): Promise<ReservationRow> {
  const { rows } = await db.query<ReservationRow>(
    `UPDATE reservations SET status = 'cancelled', cancelled_at = now()
      WHERE id = $1 AND secret = $2 AND status <> 'cancelled'
      RETURNING ${RETURNING}`,
    [id, secret],
  );
  return rows[0] ?? (await getOwned(db, id, secret));
}

async function getOwned(db: Db, id: string, secret: string): Promise<ReservationRow> {
  const { rows } = await db.query<ReservationRow>(`SELECT ${RETURNING} FROM reservations WHERE id = $1 AND secret = $2`, [
    id,
    secret,
  ]);
  if (!rows[0]) throw new HttpError(404, "not_found", "No reservation with that id and secret");
  return rows[0];
}

export async function lookupOwned(db: Db, items: { id: string; secret: string }[]): Promise<ReservationRow[]> {
  if (items.length === 0) return [];
  const { rows } = await db.query<ReservationRow>(
    `SELECT ${RETURNING} FROM reservations
      WHERE (id, secret) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))
      ORDER BY lower(during)`,
    [items.map((i) => i.id), items.map((i) => i.secret)],
  );
  return rows;
}

export type SlotState = "free" | "held" | "booked";

export async function availability(db: Db, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "invalid_input", "date must be YYYY-MM-DD");
  const { rows } = await db.query<{
    court_id: number;
    name: string;
    surface: string;
    start: string;
    status: "held" | "confirmed" | null;
  }>(
    `WITH slots AS (
       SELECT (gs AT TIME ZONE $2) AS start
         FROM generate_series($1::date + make_interval(hours => $3::int),
                              $1::date + make_interval(hours => $4::int) - make_interval(mins => $5::int),
                              make_interval(mins => $5::int)) gs
     )
     SELECT c.id AS court_id, c.name, c.surface, s.start, r.status
       FROM courts c
       CROSS JOIN slots s
       LEFT JOIN reservations r
         ON r.court_id = c.id
        AND r.status <> 'cancelled'
        AND NOT (r.status = 'held' AND r.expires_at <= now())
        AND r.during && tstzrange(s.start, s.start + make_interval(mins => $5::int))
      ORDER BY c.id, s.start`,
    [date, CLUB.timezone, CLUB.openHour, CLUB.closeHour, CLUB.slotMinutes],
  );

  const courts = new Map<number, { id: number; name: string; surface: string; slots: { start: string; state: SlotState }[] }>();
  for (const r of rows) {
    let court = courts.get(r.court_id);
    if (!court) {
      court = { id: r.court_id, name: r.name, surface: r.surface, slots: [] };
      courts.set(r.court_id, court);
    }
    court.slots.push({
      start: new Date(r.start).toISOString(),
      state: r.status === "confirmed" ? "booked" : r.status === "held" ? "held" : "free",
    });
  }
  return { date, timezone: CLUB.timezone, slotMinutes: CLUB.slotMinutes, courts: [...courts.values()] };
}

export async function stats(db: Db) {
  const { rows } = await db.query<{ confirmed: number; live_holds: number; cancelled: number }>(
    `SELECT count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
            count(*) FILTER (WHERE status = 'held' AND expires_at > now())::int AS live_holds,
            count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
       FROM reservations`,
  );
  return rows[0];
}
