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
- `null-inherit-check.js` (after `RLS=1 node seed.js`): NULL-school rows inherit
  the referenced school, and RLS still blocks writes into another school
- `legacy-devlogs.mjs`: older DB without `device_logs.school_id`. Run `prep`,
  restart the shim with `SHIM_NO_AUTOCOL=1` (it then rejects unknown columns
  like PostgREST does), then run `punch <base>` and `SKIP_SEED=1 node regress.mjs …`
- `rls-active.js`: confirms the RLS policies are installed. `regress.mjs`,
  `attack.mjs` and `device-attack.mjs` reseed, so keep `RLS=1` exported.

## Payments / SMS credit (Part 5)

```bash
export RLS=1 NAJIKI_WEBHOOK_SECRET=lab-dedicated-webhook-secret-123
# app must be started with the same NAJIKI_WEBHOOK_SECRET (env.sh raises TOPUP_MAX_PER_10_MIN for the suite)
node payments-attack.mjs http://127.0.0.1:3201 /path/to/schoolmnt2 after   # 14 attacks + 7 legit flows
MIG05=0 node payments-attack.mjs ... code-only                              # same, without migration 05
node pay-rls-check.mjs                                                      # direct REST money attacks (8)
node topup-limit-check.mjs http://127.0.0.1:3201 /path/to/schoolmnt2       # app started WITHOUT TOPUP_MAX_PER_10_MIN
```
The shim also impersonates NaJiki (`/__najiki/payments`) and runs real Postgres functions for `/rest/v1/rpc/*`.

### Checked against the real NaJiki (najiki-finance2)
```bash
node genuine-najiki-check.mjs "now:"     # one genuine NaJiki-signed payment -> must be HTTP 200 + credited
NAJIKI_REPO=/path/to/najiki-finance2 node --experimental-strip-types najiki-own-signer-check.mjs   # signed by NaJiki's own source file
```
The fake NaJiki in shim.js enforces NaJiki's CreatePaymentRequestSchema and replies `{paymentId, reference, status}`.

## Round 3: rogue money pentest (Part 6)

```
RLS=1 HARDEN=0 MIG06=0 node rogue-attack.mjs http://127.0.0.1:3201 /path/to/schoolmnt2 before   # 17/23 (04 optional step skipped)
RLS=1 MIG06=0          node rogue-attack.mjs ... before-with-optional                          # 11/23
RLS=1 HARDEN=0         node rogue-attack.mjs ... after                                         # 0/23, 9 legit OK
```
- K1/K2 (kiosk / register races) only run between 16:00 and 22:00 EAT (check-out SMS window).
- `prod-like-functions.sql` creates a production-style `public.credit_wallet` (SECURITY DEFINER, executable by PUBLIC). `PRODFN=0` skips it.
- seed.js env: `HARDEN=0` (skip 04's optional public step), `MIG05=0`, `MIG06=0`. It also creates a teacher login (`teacherA@lab.io`).
