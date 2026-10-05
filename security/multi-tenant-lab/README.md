# Multi-tenant attack lab

This lab runs the real app against **real Postgres with no RLS**, so only the
application code keeps schools apart. That is a deliberately harsher setup than
production, where RLS is a second layer.

| File | Purpose |
|---|---|
| `schema.sql` / `seed.js` | Two schools: A (attacker) and B (victim). B's rows are tagged `B-SECRETNAME` / `B-SECRETCMD`. |
| `shim.js` | Minimal PostgREST + GoTrue on port 54321, backed by Postgres on 54329. Unknown RPCs return 404, so the app takes its direct-table fallbacks. |
| `attack.mjs` | 42 checks run as school A's admin against school B. |
| `regress.mjs` | 17 legitimate same-school flows that must keep working. |
| `test-triggers.js` | Tests `supabase_migrations/03_tenant_integrity.sql` (16 cases). |

## Run

The paths are written for the sandbox layout (`/home/user/...`). Adjust them if
your layout differs.

1. `npm install`, then start Postgres on port 54329. The embedded-postgres
   binaries work: run `initdb`, then `pg_ctl -o "-p 54329"`.
2. `node seed.js && node shim.js`
3. `. ./env.sh && npx next dev -p 3201` (from the repo root)
4. `node warm.mjs http://127.0.0.1:3201`
5. `node attack.mjs http://127.0.0.1:3201 <repoDir> fixed`

## Results (2026-10-05)

| Build | Vulnerable checks |
|---|---|
| Before (commit 6e345fe) | **15 / 42** |
| After, transition mode | 1 / 42 (the intentional shared-secret fallback) |
| After, `ZKTECO_GLOBAL_SECRET_FALLBACK=false` | **0 / 42** |
| Legitimate flows (`regress.mjs`) | 17 / 17 OK |
| DB triggers (`test-triggers.js`) | 16 / 16 OK |

The raw output is in `results-*.json`.

## Device endpoint pentest (`device-attack.mjs`)

`node device-attack.mjs http://127.0.0.1:3201 <label>` (re-seeds the DB first)

| Build | Vulnerable checks |
|---|---|
| Before (commit ac010ba) | **11 / 14** |
| After | **0 / 15** (legitimate ZKTeco, webhook, ack and handshake flows still pass) |

## RLS round (Part 4)

`seed.js` always loads `supabase-base.sql` (Supabase roles, `auth.uid()`, default
grants). `shim.js` runs each REST call as `anon` / `authenticated` (with JWT
claims) / `service_role`, so RLS is really enforced.

- Baseline: `node seed.js && node rls-attack.mjs before` → 32/32 vulnerable
- After: `RLS=1 node seed.js && node rls-attack.mjs after` → 0/32
  (`RLS=1` adds a legacy `USING(true)` policy, then applies `03` + `04`)
- App under RLS: `regress.mjs` 17/17, `render-check.mjs`, `attack.mjs` 1/42,
  `RLS=1 node device-attack.mjs … rls` 0/15
- `orphan-check.mjs`: a user with no school opening `/dashboard/people`
