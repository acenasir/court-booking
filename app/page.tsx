"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type SlotState = "free" | "held" | "booked";
type Inventory = {
  club: { name: string; bookingWindowDays: number; holdSeconds: number };
  date: string;
  timezone: string;
  courts: { id: number; name: string; surface: string; slots: { start: string; state: SlotState }[] }[];
};
type Reservation = {
  id: string;
  courtId: number;
  start: string;
  end: string;
  status: "held" | "confirmed" | "cancelled" | "expired";
  holderName: string | null;
  expiresAt: string | null;
  secret: string;
};
type Owned = { id: string; secret: string };

const TZ = "America/Toronto";
const STORE_KEY = "court-booking:mine";

function loadOwned(): Owned[] {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as Owned[];
  } catch {
    return [];
  }
}

function saveOwned(items: Owned[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(-50)));
  } catch {
    // Storage unavailable (private mode); bookings still work, just aren't remembered.
  }
}

function clubDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const fmtDay = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" }).format(
    new Date(iso),
  );

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

export default function Home() {
  const days = useMemo(() => Array.from({ length: 8 }, (_, i) => clubDate(i)), []);
  const [date, setDate] = useState(days[0]);
  const [inv, setInv] = useState<Inventory | null>(null);
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [owned, setOwned] = useState<Owned[]>([]);
  const [mine, setMine] = useState<Reservation[]>([]);
  const [hold, setHold] = useState<Reservation | null>(null);
  const [name, setName] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await api<Inventory & { error?: string; message?: string }>(`/api/inventory?date=${date}`);
    if (res.ok) setInv(res.data);
    else setMessage({ text: res.data.message ?? "Could not load availability", error: true });
  }, [date]);

  const refreshMine = useCallback(async (items: Owned[]) => {
    if (items.length === 0) return setMine([]);
    const res = await api<{ reservations: Reservation[] }>("/api/bookings/lookup", {
      method: "POST",
      body: JSON.stringify({ items }),
    });
    if (res.ok) setMine(res.data.reservations);
  }, []);

  useEffect(() => {
    const items = loadOwned();
    setOwned(items);
    void refreshMine(items);
    try {
      setName(localStorage.getItem("court-booking:name") ?? "");
    } catch {}
  }, [refreshMine]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5_000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  useEffect(() => {
    const check = () =>
      fetch("/api/health")
        .then((r) => setHealthy(r.ok))
        .catch(() => setHealthy(false));
    void check();
    const t = setInterval(check, 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!hold) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [hold]);

  const remember = (r: Reservation) => {
    const next = [...owned.filter((o) => o.id !== r.id), { id: r.id, secret: r.secret }];
    setOwned(next);
    saveOwned(next);
    return next;
  };

  const mineBySlot = useMemo(() => {
    const m = new Map<string, Reservation>();
    for (const r of mine) if (r.status === "confirmed") m.set(`${r.courtId}|${r.start}`, r);
    return m;
  }, [mine]);

  async function takeHold(courtId: number, start: string) {
    setBusy(true);
    setMessage(null);
    const res = await api<Reservation & { message?: string; error?: string }>("/api/holds", {
      method: "POST",
      body: JSON.stringify({ courtId, start, idempotencyKey: crypto.randomUUID() }),
    });
    setBusy(false);
    if (res.ok) {
      setHold(res.data);
      setNow(Date.now());
    } else {
      setMessage({ text: res.data.message ?? "Could not hold that slot", error: true });
    }
    void refresh();
  }

  async function confirm() {
    if (!hold) return;
    setBusy(true);
    try {
      localStorage.setItem("court-booking:name", name);
    } catch {}
    const res = await api<Reservation & { message?: string }>("/api/bookings", {
      method: "POST",
      body: JSON.stringify({ holdId: hold.id, secret: hold.secret, name }),
    });
    setBusy(false);
    if (res.ok) {
      const next = remember(res.data);
      setHold(null);
      setMessage({ text: `Booked ${courtName(res.data.courtId)} at ${fmtTime(res.data.start)} on ${fmtDay(res.data.start)}.` });
      void refreshMine(next);
    } else {
      setMessage({ text: res.data.message ?? "Could not confirm", error: true });
      if (res.status === 410) setHold(null);
    }
    void refresh();
  }

  async function release() {
    if (!hold) return;
    await api(`/api/holds/${hold.id}`, { method: "DELETE", headers: { "x-reservation-secret": hold.secret } });
    setHold(null);
    void refresh();
  }

  async function cancel(r: Reservation) {
    const res = await api<{ message?: string }>(`/api/bookings/${r.id}`, {
      method: "DELETE",
      headers: { "x-reservation-secret": r.secret },
    });
    if (!res.ok) setMessage({ text: res.data.message ?? "Could not cancel", error: true });
    void refreshMine(owned);
    void refresh();
  }

  const courtName = (id: number) => inv?.courts.find((c) => c.id === id)?.name ?? `Court ${id}`;
  const holdLeft = hold?.expiresAt ? Math.max(0, Math.ceil((Date.parse(hold.expiresAt) - now) / 1000)) : 0;
  useEffect(() => {
    if (hold && holdLeft === 0) {
      setHold(null);
      setMessage({ text: "Your hold expired, so the slot was released.", error: true });
      void refresh();
    }
  }, [hold, holdLeft, refresh]);

  const times = inv?.courts[0]?.slots.map((s) => s.start) ?? [];
  const upcoming = mine.filter((r) => r.status === "confirmed" && Date.parse(r.end) > Date.now());

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>{inv?.club.name ?? "Court booking"}</h1>
          <p>Book one-hour slots up to {inv?.club.bookingWindowDays ?? 7} days ahead. Times are club time ({TZ}).</p>
        </div>
        <span className="health" title="GET /api/health">
          <span className={`dot ${healthy === null ? "" : healthy ? "ok" : "down"}`} />
          {healthy === null ? "Checking…" : healthy ? "All systems normal" : "Booking service degraded"}
        </span>
      </header>

      <nav className="days" aria-label="Choose a day">
        {days.map((d, i) => {
          const noon = `${d}T17:00:00Z`;
          return (
            <button key={d} className="day" aria-pressed={d === date} onClick={() => setDate(d)}>
              {i === 0 ? "Today" : new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date(noon))}
              <small>{new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(new Date(noon))}</small>
            </button>
          );
        })}
      </nav>

      {message && <div className={`toast ${message.error ? "error" : ""}`}>{message.text}</div>}

      <div className="legend">
        <span className="l-free">Free</span>
        <span className="l-held">Being booked</span>
        <span className="l-booked">Taken</span>
        <span className="l-mine">Yours</span>
      </div>

      <div className="grid-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th />
              {inv?.courts.map((c) => (
                <th key={c.id}>
                  {c.name}
                  <small>{c.surface}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!inv && (
              <tr>
                <td className="empty" colSpan={5}>
                  Loading availability…
                </td>
              </tr>
            )}
            {times.map((t, row) => {
              const past = Date.parse(t) <= Date.now();
              return (
                <tr key={t}>
                  <th scope="row">{fmtTime(t)}</th>
                  {inv!.courts.map((c) => {
                    const slot = c.slots[row];
                    const isMine = mineBySlot.has(`${c.id}|${slot.start}`);
                    const isMyHold = hold?.courtId === c.id && hold.start === slot.start;
                    const cls = isMine ? "mine" : isMyHold ? "held" : slot.state === "free" ? "" : slot.state;
                    const label = isMine ? "Yours" : isMyHold ? "Your hold" : slot.state === "free" ? (past ? "—" : "Book") : slot.state === "held" ? "Held" : "Taken";
                    return (
                      <td key={c.id}>
                        <button
                          className={`slot ${cls} ${past ? "past" : ""}`}
                          disabled={past || busy || slot.state !== "free" || !!hold}
                          onClick={() => takeHold(c.id, slot.start)}
                          aria-label={`${c.name} ${fmtTime(slot.start)}: ${label}`}
                        >
                          {label}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <section className="mine-list">
        <h2>Your bookings</h2>
        {upcoming.length === 0 ? (
          <p className="empty">No upcoming bookings on this device.</p>
        ) : (
          <ul>
            {upcoming.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>
                    {courtName(r.courtId)} · {fmtDay(r.start)} · {fmtTime(r.start)}–{fmtTime(r.end)}
                  </strong>
                  <div className="meta">Booked for {r.holderName}</div>
                </div>
                <button className="btn danger" onClick={() => cancel(r)}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer>
        Services: <code>/api/inventory</code> · <code>/api/holds</code> · <code>/api/bookings</code> ·{" "}
        <code>/api/health</code>. Double-booking is prevented by a Postgres exclusion constraint, not by app code.
      </footer>

      {hold && (
        <div className="panel" role="dialog" aria-label="Confirm booking">
          <h2>
            {courtName(hold.courtId)} · {fmtTime(hold.start)}
          </h2>
          <p>
            {fmtDay(hold.start)}. Held for you for <span className="timer">{holdLeft}s</span>.
          </p>
          <input
            autoFocus
            placeholder="Your name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && name.trim() && confirm()}
          />
          <div className="row">
            <button className="btn primary" disabled={busy || !name.trim()} onClick={confirm}>
              Confirm booking
            </button>
            <button className="btn" disabled={busy} onClick={release}>
              Release
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
