// Runs the real schema and booking logic against an in-process Postgres (PGlite).
// `npm test` -> node --test (Node 22.18+/24 strips TypeScript natively).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import type { Db } from "../lib/db.ts";
import { HttpError } from "../lib/db.ts";
import { availability, cancelReservation, confirmHold, takeSlot } from "../lib/reservations.ts";
import { CLUB } from "../lib/club.ts";

const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
let pg: PGlite;
let db: Db;

beforeEach(async () => {
  pg = new PGlite({ extensions: { btree_gist } });
  await pg.exec(schema);
  db = { query: (text, params) => pg.query(text, params) } as Db;
});

// A slot start at 10:00 club time, two days from now (inside the booking window).
async function slot(hour = 10, daysAhead = 2): Promise<string> {
  const { rows } = await pg.query<{ s: Date }>(
    `SELECT ((now() AT TIME ZONE $1)::date + $2::int + make_interval(hours => $3::int)) AT TIME ZONE $1 AS s`,
    [CLUB.timezone, daysAhead, hour],
  );
  return rows[0].s.toISOString();
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => err instanceof HttpError && err.code === code);
}

test("second booking for the same slot is rejected by the database", async () => {
  const start = await slot();
  await takeSlot(db, { kind: "book", name: "A", courtId: 1, start, idempotencyKey: null });
  await rejects(takeSlot(db, { kind: "book", name: "B", courtId: 1, start, idempotencyKey: null }), "slot_taken");
});

test("constraint holds even if application checks are bypassed", async () => {
  const start = await slot();
  const range = `[${start}, ${new Date(Date.parse(start) + 3_600_000).toISOString()})`;
  await pg.query(`INSERT INTO reservations (court_id, during, status, holder_name) VALUES (1, $1, 'confirmed', 'A')`, [range]);
  await assert.rejects(
    pg.query(`INSERT INTO reservations (court_id, during, status, holder_name) VALUES (1, $1, 'confirmed', 'B')`, [range]),
    /reservations_no_overlap/,
  );
});

test("same slot on a different court is fine", async () => {
  const start = await slot();
  await takeSlot(db, { kind: "book", name: "A", courtId: 1, start, idempotencyKey: null });
  await takeSlot(db, { kind: "book", name: "B", courtId: 2, start, idempotencyKey: null });
});

test("a live hold blocks others; confirming it makes a booking", async () => {
  const start = await slot();
  const { row: hold } = await takeSlot(db, { kind: "hold", courtId: 1, start, idempotencyKey: null });
  await rejects(takeSlot(db, { kind: "book", name: "B", courtId: 1, start, idempotencyKey: null }), "slot_taken");
  const booked = await confirmHold(db, hold.id, hold.secret, "A");
  assert.equal(booked.status, "confirmed");
  // Confirming twice is idempotent.
  assert.equal((await confirmHold(db, hold.id, hold.secret, "A")).status, "confirmed");
});

test("an expired hold is released when someone else takes the slot", async () => {
  const start = await slot();
  const { row: hold } = await takeSlot(db, { kind: "hold", courtId: 1, start, idempotencyKey: null });
  await pg.query(`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = $1`, [hold.id]);
  const { row } = await takeSlot(db, { kind: "book", name: "B", courtId: 1, start, idempotencyKey: null });
  assert.equal(row.status, "confirmed");
  await rejects(confirmHold(db, hold.id, hold.secret, "A"), "hold_expired");
});

test("cancelling frees the slot", async () => {
  const start = await slot();
  const { row } = await takeSlot(db, { kind: "book", name: "A", courtId: 1, start, idempotencyKey: null });
  await cancelReservation(db, row.id, row.secret);
  await takeSlot(db, { kind: "book", name: "B", courtId: 1, start, idempotencyKey: null });
});

test("retrying with the same idempotency key returns the original booking", async () => {
  const start = await slot();
  const first = await takeSlot(db, { kind: "book", name: "A", courtId: 1, start, idempotencyKey: "k1" });
  const again = await takeSlot(db, { kind: "book", name: "A", courtId: 1, start, idempotencyKey: "k1" });
  assert.equal(again.replayed, true);
  assert.equal(again.row.id, first.row.id);
});

test("slots off the grid, in the past or too far ahead are rejected", async () => {
  await rejects(takeSlot(db, { kind: "hold", courtId: 1, start: await slot(23), idempotencyKey: null }), "invalid_slot");
  await rejects(takeSlot(db, { kind: "hold", courtId: 1, start: await slot(10, -1), idempotencyKey: null }), "slot_in_past");
  await rejects(
    takeSlot(db, { kind: "hold", courtId: 1, start: await slot(10, CLUB.bookingWindowDays + 1), idempotencyKey: null }),
    "outside_booking_window",
  );
  await rejects(takeSlot(db, { kind: "hold", courtId: 99, start: await slot(), idempotencyKey: null }), "court_not_found");
});

test("availability reflects bookings", async () => {
  const start = await slot();
  await takeSlot(db, { kind: "book", name: "A", courtId: 3, start, idempotencyKey: null });
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: CLUB.timezone }).format(new Date(start));
  const inv = await availability(db, date);
  assert.equal(inv.courts.length, 4);
  assert.equal(inv.courts[0].slots.length, CLUB.closeHour - CLUB.openHour);
  const s = inv.courts.find((c) => c.id === 3)!.slots.find((x) => x.start === start)!;
  assert.equal(s.state, "booked");
});
