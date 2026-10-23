-- Idempotent schema. Safe to run on every deploy (scripts/migrate.mjs runs it during `npm run build`).

-- btree_gist lets one EXCLUDE constraint combine equality (court_id) with range overlap (during).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS courts (
  id      smallint PRIMARY KEY,
  name    text NOT NULL,
  surface text NOT NULL
);

INSERT INTO courts (id, name, surface) VALUES
  (1, 'Court 1', 'Hard'),
  (2, 'Court 2', 'Hard'),
  (3, 'Court 3', 'Clay'),
  (4, 'Padel A', 'Padel')
ON CONFLICT (id) DO NOTHING;

-- One table for holds and confirmed bookings so a single constraint guards both.
-- A row blocks its time range on its court unless it is cancelled. Expired holds are
-- flipped to 'cancelled' inside the same transaction that tries to take the slot.
CREATE TABLE IF NOT EXISTS reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  court_id        smallint NOT NULL REFERENCES courts (id),
  during          tstzrange NOT NULL,
  status          text NOT NULL CHECK (status IN ('held', 'confirmed', 'cancelled')),
  holder_name     text,
  secret          uuid NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key text UNIQUE,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  cancelled_at    timestamptz,
  CHECK (status <> 'held' OR expires_at IS NOT NULL),
  CHECK (status <> 'confirmed' OR holder_name IS NOT NULL),
  -- The invariant: no two live reservations on the same court overlap in time.
  CONSTRAINT reservations_no_overlap
    EXCLUDE USING gist (court_id WITH =, during WITH &&) WHERE (status <> 'cancelled')
);

CREATE INDEX IF NOT EXISTS reservations_live_holds ON reservations (expires_at) WHERE status = 'held';
