// Pluggable persistence for the Builder world + player profiles.
//
//  - If DATABASE_URL (Postgres) is set  -> store in Postgres  (survives redeploys
//    on Render/anywhere; free tiers: Supabase, Neon, Railway, etc.)
//  - Otherwise                          -> store in local JSON files (dev / ephemeral)
//
// Two logical "documents" are stored: key="world" and key="profiles".
// Each is a JSON blob. We keep the API tiny: loadDoc(key) / saveDoc(key, obj).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL || "";

let backend = "files";
let pgPool = null;
let pgReady = null;

/* ---------------- File backend ---------------- */
const FILES = {
  world: path.join(__dirname, "builder-world.json"),
  profiles: path.join(__dirname, "builder-profiles.json"),
};
function fileLoad(key) {
  try { return JSON.parse(fs.readFileSync(FILES[key], "utf8")); }
  catch { return null; }
}
function fileSave(key, obj) {
  try { fs.writeFileSync(FILES[key], JSON.stringify(obj)); return true; }
  catch (e) { console.warn("File save failed (" + key + "):", e.message); return false; }
}

/* ---------------- Postgres backend ---------------- */
async function pgInit() {
  // dynamic import so 'pg' is only needed when a DATABASE_URL is provided
  const pg = globalThis.__FAKE_PG__ || await import("pg");
  const { Pool } = pg.default || pg;
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    // most hosted free Postgres require SSL
    ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
    max: 4,
  });
  await pgPool.query(
    "CREATE TABLE IF NOT EXISTS kv_store (k TEXT PRIMARY KEY, v JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())"
  );
  console.log("Storage backend: Postgres (DATABASE_URL) — persists across redeploys");
}
async function pgLoad(key) {
  const r = await pgPool.query("SELECT v FROM kv_store WHERE k=$1", [key]);
  return r.rows[0] ? r.rows[0].v : null;
}
async function pgSave(key, obj) {
  await pgPool.query(
    "INSERT INTO kv_store (k, v, updated_at) VALUES ($1, $2, now()) " +
    "ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v, updated_at=now()",
    [key, obj]
  );
  return true;
}

/* ---------------- Public API ---------------- */
export async function initStorage() {
  if (DATABASE_URL) {
    try {
      pgReady = pgInit();
      await pgReady;
      backend = "pg";
      return;
    } catch (e) {
      console.warn("Postgres init failed, falling back to files:", e.message);
      backend = "files";
    }
  } else {
    console.log("Storage backend: local files (set DATABASE_URL for permanent DB persistence)");
  }
}

export async function loadDoc(key) {
  if (backend === "pg") {
    try { return await pgLoad(key); }
    catch (e) { console.warn("pg load failed (" + key + "):", e.message); return null; }
  }
  return fileLoad(key);
}

// Returns a promise; callers can fire-and-forget for autosave.
export async function saveDoc(key, obj) {
  if (backend === "pg") {
    try { return await pgSave(key, obj); }
    catch (e) { console.warn("pg save failed (" + key + "):", e.message); return false; }
  }
  return fileSave(key, obj);
}

export function storageBackend() { return backend; }
