// Applies db/schema.sql. Runs as part of `npm run build`, so every Vercel deploy migrates first.
import { readFile } from "node:fs/promises";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn("[migrate] DATABASE_URL is not set; skipping migration. The API will report the database as down.");
  process.exit(0);
}

const sql = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(sql);
  console.log("[migrate] schema applied");
} finally {
  await client.end();
}
