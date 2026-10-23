# Court Booking

A booking system for a small sports club: four courts, one-hour slots,
bookable up to seven days ahead. It is deliberately small, but it has the
problems real booking systems have:

- **Correctness.** Two people must never get the same court at the same time.
- **Spiky traffic.** Everyone refreshes at once when a popular day opens.
- **Separate services.** Inventory, holds, bookings and health have different
  load and failure profiles, so they are deployed as separate serverless
  functions.

## How double-booking is prevented

The guarantee lives in Postgres, not in application code. Holds and bookings
share one `reservations` table with this constraint:

```sql
CONSTRAINT reservations_no_overlap
  EXCLUDE USING gist (court_id WITH =, during WITH &&)
  WHERE (status <> 'cancelled')
```

No two live reservations on the same court can have overlapping time ranges.
That holds no matter how many function instances race, whether requests are
retried, or whether someone writes to the database by hand. The app catches
the violation (`23P01`) and returns `409 slot_taken`.

Supporting pieces:

- **Holds.** Clicking a slot creates a 120-second hold, so the player can type
  a name without losing the slot. An expired hold is released inside the same
  transaction that takes the slot next, so there is no background job to fail.
- **Idempotency keys.** `POST /api/holds` and `POST /api/bookings` accept an
  `idempotencyKey` (or an `Idempotency-Key` header). A retried request returns
  the original reservation with `200` instead of creating a duplicate.
- **Edge cache on reads.** `GET /api/inventory` is cached for one second at
  the edge (`s-maxage=1, stale-while-revalidate=2`) to absorb refresh storms.
  Writes are never cached, and the constraint guards every write.

## Services

Inventory:

- `GET /api/inventory?date=YYYY-MM-DD` returns courts and slot states
  (`free`, `held`, `booked`).

Holds:

- `POST /api/holds` with `{courtId, start}` holds a slot for 120 seconds and
  returns its `id` and `secret`.
- `DELETE /api/holds/:id` with header `x-reservation-secret` releases a hold
  early.

Bookings:

- `POST /api/bookings` with `{holdId, secret, name}` confirms a hold.
- `POST /api/bookings` with `{courtId, start, name}` books in one step. The
  load test uses this.
- `POST /api/bookings/lookup` with `{items: [{id, secret}]}` fetches your own
  reservations.
- `DELETE /api/bookings/:id` with header `x-reservation-secret` cancels.

Health:

- `GET /api/health` reports DB latency and reservation counts, and returns
  `503` if the database is down.

There are no accounts. Each reservation has a random `secret`, and the browser
keeps it in `localStorage`. Every request writes one JSON log line (`service`,
`status`, `ms`, `requestId`), so you can filter Vercel logs by service.

## Running locally

Requires Node 22.18 or newer.

```bash
npm install
npm test
```

`npm test` runs the real schema and booking logic against PGlite, an embedded
Postgres, so it needs no database server.

To run the app you need a Postgres database (Neon's free tier works). Copy
`.env.example` to `.env.local`, set `DATABASE_URL`, then:

```bash
npm run db:migrate
npm run dev
```

`npm run build` runs the migration first, so every Vercel deploy applies
`db/schema.sql`. The schema is idempotent.

## Breaking it on purpose

Send 200 simultaneous bookings at one slot:

```bash
npm run stampede -- --url https://your-deployment.vercel.app --n 200
```

The expected result is exactly one `201` and the rest `409`. The script then
cancels the winning booking. Things to try:

- Raise `--n` until you see 5xx errors or timeouts, then watch `/api/health`
  and the function logs.
- Drop `reservations_no_overlap` in a scratch database and rerun the stampede
  to see double-bookings appear.
- Point `DATABASE_URL` at a dead host and watch `/api/health` return `503`
  while the UI shows "degraded".
- Change `max` in `lib/db.ts`, or use an unpooled connection string, to
  exhaust Postgres connections under load.

## Configuration

Venue rules are in `lib/club.ts`: time zone, opening hours, slot length,
booking window and hold duration.
