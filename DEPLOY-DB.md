# Make the Builder world permanent with a free database

By default the server saves the shared Builder world + every player's progress to
**local JSON files**. That works, but on hosts like **Render's free tier the disk is
ephemeral** — files can reset on redeploy or when the instance sleeps/recycles.

To make the world **truly permanent across redeploys**, give the server a free
**Postgres** database. The code auto-detects it: if the environment variable
`DATABASE_URL` is set, it stores everything in Postgres instead of files. No code
changes needed.

## Option A — Supabase (free Postgres)
1. Go to https://supabase.com → create a free project.
2. Project → **Settings → Database → Connection string → URI**. Copy it.
   It looks like: `postgresql://postgres:[PASSWORD]@db.xxxx.supabase.co:5432/postgres`
3. In **Render → your service → Environment**, add:
   - **Key:** `DATABASE_URL`
   - **Value:** the connection string from step 2
4. Save → Render redeploys. On boot the logs will show:
   `Storage backend: Postgres (DATABASE_URL) — persists across redeploys`

## Option B — Neon (free Postgres)
1. https://neon.tech → create a free project.
2. Copy the **connection string** (Dashboard → Connection Details).
3. Add it as `DATABASE_URL` in Render (same as above).

## Option C — Railway / any Postgres
Any Postgres works. Just set `DATABASE_URL` to its connection string.

## Notes
- The server creates its own table automatically:
  `kv_store (k TEXT PRIMARY KEY, v JSONB, updated_at TIMESTAMPTZ)`.
- It stores two rows: `world` (all builds + cleared tiles) and `profiles`
  (every player's name/PIN/wallet/inventory/position).
- SSL is enabled automatically for hosted databases.
- If `DATABASE_URL` is missing or the DB is unreachable, it safely **falls back to
  local files** so the game always runs.
- Saves happen on every change (debounced), every 60s, on player disconnect, and on
  server shutdown — so nothing is lost.

That's it — with `DATABASE_URL` set, the Builder world is shared by everyone and
survives restarts, redeploys, and sleeps. 🎉
