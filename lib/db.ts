import { Pool, type PoolClient } from "pg";

// One small pool per serverless instance. Use a pooled connection string (Neon's default
// DATABASE_URL is pooled) so a burst of instances doesn't exhaust Postgres connections.
const globalForPool = globalThis as unknown as { pgPool?: Pool };

export function pool(): Pool {
  if (!process.env.DATABASE_URL) throw new HttpError(503, "database_not_configured", "DATABASE_URL is not set");
  globalForPool.pgPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  return globalForPool.pgPool;
}

export async function withTx<T>(fn: (client: Db) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client as PoolClient & Db);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Minimal query surface shared by pg's PoolClient and PGlite (used in tests).
export interface Db {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Postgres SQLSTATE codes we translate into HTTP responses.
export const PG = {
  exclusionViolation: "23P01", // overlapping reservation -> slot taken
  uniqueViolation: "23505", // duplicate idempotency key
} as const;

export function pgCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

export function pgConstraint(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "constraint" in err
    ? String((err as { constraint: unknown }).constraint)
    : undefined;
}
