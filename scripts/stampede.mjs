// Fires N simultaneous booking requests at ONE slot and checks that exactly one wins.
//
//   node scripts/stampede.mjs --url https://your-app.vercel.app [--n 200] [--court 1] [--start ISO] [--keep]
//
// Without --start it picks the first free slot tomorrow on the chosen court. Unless --keep is
// passed, the winning booking is cancelled afterwards so the demo grid stays clean.
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:3000" },
    n: { type: "string", default: "200" },
    court: { type: "string", default: "1" },
    start: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

const base = values.url.replace(/\/$/, "");
const n = Number(values.n);
const courtId = Number(values.court);

async function pickSlot() {
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(Date.now() + 86_400_000));
  const res = await fetch(`${base}/api/inventory?date=${tomorrow}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`inventory ${res.status}: ${await res.text()}`);
  const inv = await res.json();
  const court = inv.courts.find((c) => c.id === courtId);
  const slot = court?.slots.find((s) => s.state === "free");
  if (!slot) throw new Error(`no free slot tomorrow on court ${courtId}`);
  return slot.start;
}

const start = values.start ?? (await pickSlot());
console.log(`Stampede: ${n} concurrent bookings for court ${courtId} at ${start} against ${base}`);

const t0 = performance.now();
const results = await Promise.all(
  Array.from({ length: n }, async (_, i) => {
    const started = performance.now();
    try {
      const res = await fetch(`${base}/api/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courtId, start, name: `Load test #${i}` }),
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body, ms: performance.now() - started };
    } catch (err) {
      return { status: "network_error", body: { message: String(err) }, ms: performance.now() - started };
    }
  }),
);
const wall = performance.now() - t0;

const byStatus = {};
for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]);

console.log("Responses by status:", byStatus);
console.log(`Latency ms  p50=${pct(50)}  p95=${pct(95)}  max=${pct(100)}  wall=${Math.round(wall)}`);

const winners = results.filter((r) => r.status === 201);
const other = results.filter((r) => r.status !== 201 && r.status !== 409);
if (other.length) console.log("Sample non-409 failure:", other[0]);

if (!values.keep) {
  for (const w of winners) {
    await fetch(`${base}/api/bookings/${w.body.id}`, { method: "DELETE", headers: { "x-reservation-secret": w.body.secret } });
  }
  if (winners.length) console.log(`Cancelled ${winners.length} winning booking(s) to clean up.`);
}

if (winners.length === 1) {
  console.log("PASS: exactly one booking succeeded.");
} else {
  console.error(`FAIL: ${winners.length} bookings succeeded for one slot.`);
  process.exit(1);
}
