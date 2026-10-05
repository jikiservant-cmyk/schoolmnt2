# Login / auth security audit (2026-10-05)

Covers the login, signup, session, logout and teacher-PIN flows, plus the
endpoints next to them. The dynamic tests live in `security/pentest/`.

## Dynamic test results

| # | Attack | Before | After |
|---|--------|--------|-------|
| 1 | **Forged session cookie:** a non-admin gets tokens directly from GoTrue with the public anon key and opens `/dashboard` | **VULNERABLE** (200) | Blocked (307 → `/login?error=access_denied`) |
| 2 | Same, against the `/mark-attendance` kiosk | **VULNERABLE** (200) | Blocked |
| 3 | Admin of another app in a shared Supabase project (`app_type=clinic`) logs in | **VULNERABLE** | Blocked |
| 4 | Brute force: 12 rapid password guesses | **VULNERABLE** (all processed) | Blocked at attempt 6 |
| 5 | Role enumeration: different error for "valid password but not admin" | **VULNERABLE** | One generic message |
| 6 | Cross-site `POST /api/logout` (CSRF) | **VULNERABLE** (303) | 403 |
| 7 | Session cookie `SameSite=None` | **VULNERABLE** | `SameSite=Lax` |
| 8 | Session cookie readable by JS (no HttpOnly) | **VULNERABLE** | `HttpOnly` |
| 9 | Login page can be framed (clickjacking) | **VULNERABLE** | `X-Frame-Options: DENY` + `frame-ancestors 'none'` |
| 10 | `X-Powered-By: Next.js` | **VULNERABLE** | Removed |
| 11 | Admin gate when the profile lookup returns 500 / malformed JSON / drops the connection | Held (denied) | Held (denied) |
| 12 | Non-admin through the login form | Held | Held |

Regression checks after the fix all pass:
- an admin can log in from a clean IP while another IP is throttled;
- email case and whitespace are normalised;
- every dashboard page renders for an admin;
- same-origin logout works and revokes the token;
- `GET /api/logout` returns 405;
- anonymous requests go to `/login`;
- oversized input is rejected.

Note on #11: the original `try/catch` around the role check *would* fail open
if an exception were thrown. supabase-js returns errors instead of throwing, so
this couldn't be exploited in testing. It is still fixed: every failure now
denies access, and the admin client no longer falls back to the anon key.

## Fixes found by code review (not all covered by dynamic tests)

- **Teacher PIN check:**
  - The staff record was loaded before the tenant check, so one school's
    admin could lock out another school's teachers. The tenant check now runs
    first.
  - The failure counter was read-modify-write, so parallel guesses got around
    the 5-try lockout. An in-process limiter now runs before bcrypt.
  - The reset action wrote `pin_*` column names that the check never reads,
    so a reset never cleared a lockout. Both now use the same columns.
  - `marked_by` is now taken from the verified staff record, not from client
    input.
  - `attendanceType` and the student ID arrays are validated.
- **PIN generation:**
  - PINs came from `Math.random()`; they now use `crypto.randomInt`.
  - "Uniqueness" was checked by bcrypt-comparing every staff PIN across every
    tenant synchronously, which blocked the event loop (DoS). That check is
    removed.
  - bcrypt cost raised from 6 to 10.
- **Signup:**
  - Re-registering an existing email could overwrite that profile and re-run
    school setup. It now checks `identities.length` first.
  - `role` is no longer written to user-editable `user_metadata`.
  - Password policy: at least 8 characters and at most 72 bytes, with a
    letter and a number.
  - Responses are neutral, so they don't reveal whether an account exists.
  - Signup is rate limited.
- **Search:** `searchPeopleAction` built a PostgREST `.or()` filter from raw
  input, which allowed filter injection. Input is now sanitised and the page
  size is capped.
- **Najiki webhook:** the bearer secret was compared with `===`, which leaks
  timing. It now uses a constant-time comparison.
- **`/api/devices/push`:** `.ilike()` let `%` act as a wildcard to probe
  serial numbers. It now uses `.eq()` with validation, and the error doesn't
  say whether a serial is registered.
- **Error messages:** database errors are no longer shown to users.

## Deployment notes

1. Run `supabase_migrations/02_auth_hardening.sql`.
2. If the app is embedded in an iframe (for example AI Studio), set
   `AUTH_COOKIE_SAMESITE=none` and `ALLOW_IFRAME_EMBED=true`.
3. Make sure no RLS policy or `auth_school_id()` trusts `user_metadata`.
4. A test Supabase URL and anon key are still in git history (commit
   `2fb2bd6`). Rotate the key.
5. The rate limiter is per instance. If you scale out, back it with
   Redis/Upstash.

---

# Part 2: Multi-tenant isolation audit

Every school shares one database. Here the attacker is a legitimate admin of
school A who tries to read or change school B's data. All tests ran with
**RLS switched off**, so the application code had to stop every attack by
itself. Lab and raw results: `security/multi-tenant-lab/`.

## Findings (all fixed)

| # | Severity | Issue | Fix |
|---|---|---|---|
| T1 | Critical | Device secrets weren't checked per device. Adapters compared against the plaintext `device_secret`, but new devices store only the hash. So the single global `ZKTECO_DEVICE_SECRET` authenticated every school's devices. Anyone holding it could inject attendance (and paid SMS) into any school and pull its enrol commands. Hashed non-ZKTeco devices couldn't log in at all. | `isAuthorizedDevice()` checks the per-device hash first, with a timing-safe compare. The global secret is a transition fallback that you can turn off. |
| T2 | High | `enqueueDeviceCommand` found devices with a global, case-insensitive pattern match, and `schoolId` was optional. Commands could land in another school's device queue. | `schoolId` is required. Lookup is exact match + `school_id`. The command is refused if the device isn't yours. |
| T3 | High | Push / auto-assign: `classId` wasn't validated, and the class-name lookup wasn't scoped to the school (it leaked B's class names). Auto-assign used the raw serial. | `validatePushTarget()` checks device, category and class ownership. |
| T4 | High | `regenerateDeviceSecret` updated the device without a `school_id` filter. | Scoped, plus a UUID check. |
| T5 | High | `addPerson` accepted another school's class for students, and for teachers (`classIdsJson`). | `getOwnedClass` / `allClassesOwned`. |
| T6 | High | `addClass` accepted another school's teacher. | Teacher must belong to your school. |
| T7 | High | `recordTeacherAttendance` accepted any person ID and any status string. | Ownership + role check. Status is limited to an allowed list. |
| T8 | High | Payment webhook: the tenant **code** took priority over the school UUID we send ourselves, so a top-up could be credited to the wrong school. Non-UUID values went straight into a PostgREST `.or()` filter. Conflicting IDs were accepted. A missing reference became `tx_<now>`, so every replay credited again. | `resolveWebhookSchool()`: UUID first, conflicting IDs rejected, the code must map to exactly one school, and the school must exist. A reference is now required and the amount is bounds-checked. |
| T9 | Medium | Guardian SMS lookups (device processor, kiosk, manual attendance) didn't check the guardian's school. Credential→person joins weren't checked either. | Guardian and person must have the same `school_id`. |
| T10 | Low | `addDevice` said a serial was "already registered", which lets anyone enumerate serials. | Generic message. |
| T11 | Low | `topUpBalance` accepted any amount and phone number. | Validated. |

Defence in depth: `supabase_migrations/03_tenant_integrity.sql` adds triggers
that reject any cross-school link at the database level. It covers class,
teacher, attendance person/device, device commands, credentials, notifications
and guardians. It also makes `school_id` immutable and adds a case-insensitive
unique index on serials. Tested on Postgres 17 (16/16 cases).

## Results

Before: **15/42** attacks succeeded. After: **0/42** in strict mode (1/42 in
transition mode, which is intentional). All 17 legitimate same-school flows
still work.

## Deployment steps (Part 2)

1. Run the audit query at the bottom of `03_tenant_integrity.sql`. Then run the
   migration. It's safe to re-run, and it skips tables that don't exist.
2. Give every device its own secret: Dashboard → Devices → *Regenerate secret*,
   then enter it on the terminal.
3. Once every device uses its own secret, set
   `ZKTECO_GLOBAL_SECRET_FALLBACK=false`. Until then, any device using the
   shared secret logs a `[Device Auth] ... SHARED global secret` warning.
4. Make sure the payment provider sends back a `reference`/`transactionId` and
   `externalEntityId`/`metadata.schoolId`. Webhooks without them now get `400`.

---

# Part 3: Biometric device endpoint pentest

Scope: `/iclock/cdata`, `/iclock/getrequest`, `/iclock/devicecmd`,
`/api/devices/push`, all vendor adapters and the attendance processor.
Result: **11/14 attacks worked before → 0/15 after.** Normal device traffic
still works.

| # | Severity | Issue | Fix |
|---|---|---|---|
| D1 | Medium | Error messages showed whether a serial existed or was deactivated (serial enumeration). | Every failure returns the same `ERROR: UNAUTHORIZED`. Details go to server logs only. |
| D2 | Medium | Unlimited device-secret guessing. | Failures throttled per IP+serial (20 per 10 min) and per IP (100), then `429 Retry-After`. Working devices are never throttled. |
| D3 | High | `/api/devices/push` and `/iclock/devicecmd` read unlimited bodies **before** authenticating (memory DoS). | 1 MB cap (256 KB for acks). devicecmd now authenticates first. |
| D4 | Medium | Webhook devices (Hikvision/Suprema/Dahua/generic) could write attendance dated 2099 or 1999. | Processor drops events more than 10 min in the future or 60 days in the past. Batch capped at 2000 events, IDs at 64 chars. |
| D5 | Medium | Deactivated (left/expelled) people were still recorded and their parents still got SMS. | Inactive people are skipped. |
| D6 | High (cost) | Each tap of the reader sent a paid SMS (5 taps = 5 SMS). Replayed uploads did the same. | One SMS per child per direction per local day. Every punch is still stored. |
| D7 | Low | OPERLOG/USERINFO/BIODATA uploads were parsed as punches. | Only `ATTLOG` (or no table) is processed. Others are acknowledged. |
| D8 | High | A queued command with a line break could smuggle extra ADMS commands (e.g. `CLEAR ALL DATA`). | Refused when queued, and again when sent (marked `failed`). |
| D9 | High (data loss) | DB write failures were ignored and the device got `OK`, so it deleted punches that were never saved. | The device now gets `503 RETRY_LATER` and keeps the punches. Duplicate conflicts are skipped row by row. |

Also: command contents (names/PINs) are no longer written to logs.

Shared code: `lib/devices/gateway.ts` (authentication, throttling, body cap,
command check). Tests: `security/multi-tenant-lab/device-attack.mjs`.

Note: the throttle is in-memory, per instance. Behind a proxy, make sure
`X-Forwarded-For` is set by your platform (Vercel / Cloud Run do this).

---

# Part 4: Multi-tenant round 2 — database-level isolation (RLS)

## Why this round

Parts 1–3 made the **app** check tenancy everywhere. However, every admin's
browser holds a Supabase login token (JWT) and the public anon key. Anyone can
copy those and call the Supabase REST API **directly**, skipping all app code.
At that point only Postgres Row Level Security (RLS) stands between schools.
Signup is open, so anyone can get such a token.

The real database's RLS state is unknown: `types/supabase.ts` is empty, and
there are no RLS migrations in the repo. So this round tests the worst case.

## Test method

- The lab now emulates Supabase roles: `anon`, `authenticated`, and
  `service_role` (BYPASSRLS). It also emulates `auth.uid()` and the default
  grants (`supabase-base.sql`).
- The lab shim runs every REST request inside a transaction, with
  `SET LOCAL ROLE <role>` and the JWT claims set. This is the same model as
  PostgREST, so RLS is genuinely enforced.
- `rls-attack.mjs` (32 checks) logs in as school A's admin, then attacks
  school B with A's own token straight against REST. Before running, the
  service role gives B rows in every table, so "0 rows" really means blocked.
- The shim selects only the requested columns (like PostgREST). That matters
  with column privileges: an early run where it used `SELECT *` showed false
  permission errors. Each RLS run also checks that the policies are really
  installed (`rls-active.js`), because some suites reseed the database.
- The "after" run deliberately adds a legacy wide-open policy
  (`USING (true)` on `people`) before migration 04. This proves the
  restrictive guard still holds when someone has left an old policy behind.

## Findings

| # | Finding | Fix |
|---|---|---|
| R1 | Without RLS, A's token could read **every table** of school B (people, staff, devices, commands, logs, parents, credentials, notifications, links). | `04`: RLS on all school tables. The policy is `school_id = school.auth_school_id()`, and a RESTRICTIVE guard overrides any old permissive policy. |
| R2 | A's token could insert, update, move or delete B rows: inject students, deface records, steal B's device, queue `CLEAR DATA` on B's device, add itself as admin of B. | Same policies, with `WITH CHECK`. Trigger `03` also still blocks cross-tenant references. |
| R3 | Any admin could credit their own SMS balance by patching `schools.settings`, or their own `public.wallets.balance`. | `schools`: authenticated may only SELECT its own row (writes are revoked). Wallets/transactions/admin_profiles are read-only for their own tenant (opt-in hardening, see below). |
| R4 | `staff_users.pin_hash` was readable (allowing offline cracking of 6-char PINs) and writable (allowing reset of lockout counters). The same applied to `devices.device_secret`. | Column privileges: these columns are hidden from `authenticated` for both read and write. The server uses the service role. |
| R5 | The anon key alone (it's public, in the JS bundle) could read people, staff, devices and schools. | `REVOKE ALL … FROM anon` on tenant tables. |
| R6 | `/dashboard/people`: a logged-in user **without a school** got every school's class names in the response (the query ran unscoped when `schoolId` was null). Verified with `orphan-check.mjs`: old code leaked, new code does not. | The page now uses `requireSchoolAdminPage()` and always filters by `school_id`. |
| R7 | Some inserts didn't set `school_id` (the `staff_users` fallback insert in people actions, and kiosk `device_logs`). Under RLS these would fail, or leave orphan rows. | Both inserts now set `school_id`. |
| R8 | `processPendingNotificationsAction` updated notifications by id only. | Now also filters `.eq('school_id', schoolId)`. **Note:** this function only *simulates* sending (it marks items sent with fake provider data). Wire it to the real SMS gateway before relying on it. |
| R9 | The device processor wrote `device_logs` **without** `school_id`. With `03` installed, the trigger rejected every device audit row (a NULL school pointing at a real device's school), so the hardware audit trail silently stopped. Punches were still saved. | The processor now sets `school_id: device.school_id`. Trigger `03`: a row written with a NULL school now **inherits** the school of the row it points at, instead of being rejected. RLS `WITH CHECK` runs afterwards, so admin A can't use this to write into B (tested). Both `device_logs` writers retry without `school_id` if an older DB lacks that column (tested with the column dropped). |

## Results

| Run | Vulnerable |
|---|---|
| Direct-REST attack, no RLS (baseline) | **32 / 32** |
| Direct-REST attack, after `03` + `04` (with a legacy `USING(true)` policy present) | **0 / 32** |
| Sanity: service role still sees all; A still sees own data | pass |
| App legit flows (`regress.mjs`) running **under RLS** | 17 / 17 OK, zero permission errors in the Postgres log |
| Pages under RLS (`render-check.mjs`): dashboard, people, classes, devices, attendance | show A's data, none of B's |
| App-layer attack (`attack.mjs`) under RLS | 1 / 42 (the intentional transition-mode check, same as before) |
| Device pentest (`device-attack.mjs`) under RLS | 0 / 15 |
| NULL-school inheritance (`null-inherit-check.js`) | 3 / 3: service row inherits; A→B device rejected by RLS; A→own device gets A |
| Older DB without `device_logs.school_id` (`legacy-devlogs.mjs`, shim rejecting unknown columns like PostgREST) | device punch and kiosk clock-in still logged |
| Regress **without** RLS (DB that hasn't run `04` yet) | 17 / 17 OK |
| `tsc` / `eslint` | clean / 0 errors |

## Deployment steps (Part 4)

1. **Back up first**, then run `supabase_migrations/04_rls_tenant_isolation.sql`
   on **staging** after `03`.
2. Read the NOTICE/WARNING output. If `school.auth_school_id()` already exists,
   the migration keeps it, but warns if it reads `user_metadata`. Users can
   edit `user_metadata` themselves, so that would let them pick any school.
   It must look up `staff_users` (as the default the migration creates does).
3. Run the audit queries at the bottom of the file. The "tables without RLS"
   query should list no tenant tables, and no `anon` grants should remain.
4. Optional: run `SET smartskoolz.harden_public = 'on';` before the migration
   to also lock `public.wallets` / `transactions` / `admin_profiles`. Only do
   this if no other app writes those tables with a user token.
5. Click through the dashboard on staging (add student, push to device, mark
   attendance), then deploy to production.
6. Rotate the anon key that leaked in git history (commit `2fb2bd6`). It is
   less dangerous after `04`, but should still be replaced.
7. If you re-run `03` (it is idempotent), it picks up the improved
   NULL-school handling for `device_logs` and the other linked tables.

**Limit to know:** the policies treat every logged-in member of a school
alike. Today only admins log in, and teachers use kiosk PINs. If teachers or
parents ever get their own logins, the policies need a role check, so that a
teacher can't edit `staff_users` in their own school.


---

# Part 5: SMS credit and payment integrity pentest

**Scope:** money going in (mobile-money top-ups: `topUpBalance` server action, then the NaJiki payment webhook crediting `public.wallets` and `public.transactions`), and money going out (SMS queue, delivery reports, balance display). The goal: nobody can get SMS credit they did not pay for, and nobody loses credit they did pay for.

## How it was tested

Same lab as Parts 2–4 (real Postgres with migrations 03 + 04 + RLS, the real Next.js app, a Supabase shim). The shim also plays NaJiki: it accepts top-up requests and lets the attack script send signed webhooks. Script: `security/multi-tenant-lab/payments-attack.mjs`. It contains 14 attacks plus 7 legit flows that must keep working, and it checks wallet balances in the database after every step.

## Findings (all fixed)

| ID | Severity | What an attacker / bad luck could do | Fix |
|---|---|---|---|
| P1 | Critical | Anyone holding the webhook secret (or a buggy provider retry) could credit any school with a payment that was **never started** in the app (5,000,000 UGX credited in the test). | Every top-up now creates a `school.payment_intents` row **before** NaJiki is called. Webhooks only credit a matching intent. |
| P2 | Critical | Webhook claims more money than the top-up asked for: the larger amount was credited. | The credit is `least(paid, requested)`. Mismatches are logged. |
| P3 | Critical | The same webhook sent 5× at the same instant was credited 5×. A read-then-insert duplicate check let them all through. | All crediting happens inside one DB function, `school.apply_payment()`, under a transaction lock, plus a UNIQUE index on `transactions.reference`. |
| P3b | High | One top-up credited twice when the provider sends two notifications with different transaction ids. | Dedup by the **intent**: once credited, an intent can never be credited again. |
| P4 | High | Two different payments landing at once: one overwrote the other's balance (lost update). | Balance is updated atomically (`balance = balance + x`) inside the locked function. |
| P5 | High | A failed or cancelled payment was credited because the event name contained "success". | Only explicit success statuses credit. FAILED / CANCELLED / PENDING never do, whatever the event name says. |
| P6 | High | A payment in USD (or another currency) was credited as the same number of UGX. | A non-UGX payment is held for review, not credited. |
| P7 | High | School A's payment could be credited to school B by editing the school id or tenant code in the payload. | The school comes from the intent (created by the logged-in admin), not from the payload. A conflicting school is held for review. |
| P8 | High | A DB error while crediting was swallowed and NaJiki was told "OK", so a paid top-up was lost forever. | DB error → HTTP 500, so NaJiki retries. The retry credits exactly once (tested with an injected DB failure). |
| P9 / P9b | Medium | Duplicate wallet rows: the dashboard showed a wallet that was not being credited, so a paid top-up looked lost. | One wallet-picking helper (`lib/payments/wallet.ts`) used everywhere. Wallet pre-creation race removed. Migration 05 warns about existing duplicates. |
| P10 | Medium | The "process pending notifications" action marked SMS as delivered **without sending them** (a simulation left in production). | Disabled unless `SMS_SIMULATION_MODE=true`. **Never set this in production.** |
| P11 | Medium | The unauthenticated webhook read a 3 MB body before checking the signature (memory/CPU abuse). | 64 KB cap before anything else (HTTP 413). |
| P12 | Medium | The webhook accepted the **outbound API key** as its signing secret, so one leaked key gives both "send SMS" and "mint credit". | New dedicated `NAJIKI_WEBHOOK_SECRET`. The old key still works (with a log warning) only until the new one is set. |

Also fixed while testing:
- **SMS delivery reports never updated anything.** The code wrote to `public.notifications`, but the queue lives in `school.notifications`.
- **Top-up references were guessable** (timestamp-based). They are now random UUIDs.
- **Top-up rate limit:** at most 6 top-up requests per school per 10 minutes (`TOPUP_MAX_PER_10_MIN`). This stops someone spamming parents' phones with mobile-money PIN prompts.
- **`NAJIKI_API_KEY` is now required:** no silent fallback.

Every webhook outcome (credited, duplicate, unmatched, amount mismatch, wrong currency, wrong school, error) is written to `school.payment_events`, so money questions can be answered from data.

## Results

| Run | Attacks that worked | Legit flows broken |
|---|---|---|
| Before (original code) | **13 / 14** | 0 / 5 |
| After: code + migration 05, webhook still signed with API key | 1 / 14 (P12 only: config) | 0 / 7 |
| **After: code + migration 05 + `NAJIKI_WEBHOOK_SECRET`** | **0 / 14** (run 3× with the same result) | **0 / 7** |
| Code only, migration 05 **not** run | 4 / 14 (P1, P2, P3b, P7) | 0 / 7 |

**Migration 05 is required. Do not deploy the code without it.** Without 05 the app still works (it falls back to a serialized legacy credit path and logs a warning), but four critical/high holes stay open.

Legit flows checked:
- normal top-up credited once;
- provider retry after a DB hiccup credits once;
- a paid-less-than-requested amount credits what was paid;
- dashboard balance matches the ledger;
- a wrong signature is rejected;
- a delivery report marks the SMS as sent;
- `payment.failed` is acknowledged with 0 credited.

Direct-database attack with a school admin's own login token (`pay-rls-check.mjs`): **0 / 8**. Can't read other schools' top-ups, forge or inflate intents, read or erase the payment log, call `apply_payment`, edit the wallet, or insert fake transactions. All 8 are refused with "permission denied". The server (service role) still works.

Default rate limit: 6 top-ups allowed, the 7th and 8th refused with "Too many top-up attempts".

Regression (everything from Parts 1–4, re-run with 05 applied): legit flows 17/17, app attacks 1/42 (the known device shared-secret transition item), device attacks 0/15, direct REST attacks 0/32, dashboard render check OK.

## Go-live steps (Part 5), in order

1. **Back up the database**, then run `supabase_migrations/05_sms_payment_integrity.sql` (after 03 and 04). It is safe to re-run.
2. Read the migration output. If it prints a `WARNING` about duplicate transaction references or duplicate wallets, fix those rows (queries are in the comments at the bottom of 05) and re-run 05 so the UNIQUE index gets created.
3. In NaJiki, open the school application and copy its **webhook secret** (`njk_whsec_...`). NaJiki shows it when the application is created, or when the key is rotated with "rotate webhook secret". Set it as `NAJIKI_WEBHOOK_SECRET` in the school app. Don't invent your own: NaJiki signs with the secret it generated. If the application has no webhook secret, NaJiki signs with its legacy API key, or sends **unsigned** notifications that this app rejects.
3b. In NaJiki, check that the school application's **base URL + webhook path** points to `https://<school-app-domain>/api/internal/payment-completed` (or `/api/webhooks/najiki`; both are the same handler). Check that the **application code** equals `NAJIKI_APP_CODE` (default `school`), that a payment type `general` exists, and that every school has an active NaJiki **tenant** whose code matches `public.tenants.code`. Otherwise NaJiki refuses the top-up (400/404) before any PIN prompt.
4. Make sure `NAJIKI_API_KEY` is set (top-ups now refuse without it).
5. Leave `NAJIKI_REQUIRE_PAYMENT_INTENT` unset (the default, `true`). Top-ups started before this release have no intent and will be **held**, not lost. Credit them by hand after checking.
6. Do **not** set `SMS_SIMULATION_MODE`.
7. Do one real small top-up (e.g. 500 UGX) on day one. **Important:** NaJiki never retries a 4xx. If the secret is wrong, the notification gets a 401 and is dropped NaJiki-side: the school app logs `Unauthorized NaJiki webhook attempt: bad signature`, and the intent stays `pending` with NaJiki's `paymentId` in `provider_ref`. Fix the secret, then re-send it from NaJiki or credit it by hand. Check the balance went up exactly once and that `school.payment_events` shows `credited`.
8. Daily for the first weeks: check `school.payment_events` for anything that is not `credited` / `duplicate` (the reconciliation query is in 05). Each such row is real money that needs a human decision.

**Known limits (not blockers):**
- The top-up rate limit is in memory, per server instance. With several instances the real limit is 6 × instances.
- The kiosk can queue the same SMS twice on a fast double-tap.
- SMS are queued without checking the school still has enough balance; sending is charged by NaJiki.

## Part 5b: checked against NaJiki's real source (najiki-finance2)

After the first pass I went through the provider's code (`jikiservant-cmyk/najiki-finance2`): `src/lib/notification-signature.ts`, `src/lib/payments.ts`, `src/app/api/payments/route.ts`, `src/lib/sms-queue.ts` and `src/lib/backoff.ts`. Then I re-tested with payloads and signatures exactly as NaJiki produces them.

### Critical finding: every real payment notification would have been rejected

| | Format NaJiki actually sends | What this app checked |
|---|---|---|
| Signature | `X-Najiki-Signature: t=<ms>,v=<hex HMAC-SHA256(secret, "<t>.<body>")>` plus `X-Najiki-Timestamp` | bare `HMAC(body)` or `Authorization: Bearer <secret>` |
| Body | flat: `{paymentIntentId, reference, status:"success"/"failed", amount, currency, providerPaymentId, externalEntityId, metadata}` | handled (lowercase status, flat shape) |
| Our reference | only inside `metadata.idempotencyKey` (NaJiki makes its own `reference`) | handled |

Proof: one genuine NaJiki-signed 2,000 UGX payment sent to each version (`genuine-najiki-check.mjs`):

| Version | Response | Credited |
|---|---|---|
| Original code | 401 | **0** |
| First fix in this audit (`323ca55`) | 401 | **0** |
| **Now** | **200** | **2,000** |

NaJiki treats 4xx as permanent and never retries (`backoff.ts`). Every school's paid top-up would have been silently lost from day one. A payment signed by **NaJiki's own source file** (imported directly, `najiki-own-signer-check.mjs`) is now credited correctly, and NaJiki's own verifier confirms the signature.

### Fixes in this pass

- **Signature check rewritten** for NaJiki's scheme: HMAC over `"<t>.<body>"`, timing-safe compare, `X-Najiki-Timestamp` must equal the signed `t`, and a timestamp more than 5 min in the future is rejected.
- **Replay window: 72h by default** (`NAJIKI_WEBHOOK_MAX_AGE_HOURS`). NaJiki's QStash retries re-send the *original* headers for up to ~2 days, so a 5-minute window would reject legitimate retries. Replays inside the window cannot add money, because `apply_payment()` credits each payment once.
- **Old formats off by default:** bare body HMAC and secret-as-Bearer. Neither has replay protection, and the second leaks the secret into logs. `NAJIKI_WEBHOOK_ALLOW_LEGACY_SIGNATURE=true` re-enables them, only for an old NaJiki build.
- **NaJiki's `paymentId` is stored on the intent** (`payment_intents.provider_ref`) when NaJiki accepts the top-up, and `apply_payment()` matches on it as well as on our reference. A payment still matches if metadata were ever lost.
- **NaJiki returning `status: failed` immediately** marks the intent failed and shows the school an error.
- **Refused payment notifications** (conflicting school, missing reference, invalid amount: 4xx, so never retried) are now written to `payment_events` (`rejected_*`), so nothing disappears without a trace.
- The lab's fake NaJiki now enforces NaJiki's real request schema (`CreatePaymentRequestSchema`) and response shape `{paymentId, reference, status}`. The top-up request passes it.

### Results (payloads exactly as NaJiki sends them)

| Run | Attacks that worked | Legit flows broken |
|---|---|---|
| **Code + migration 05 + `NAJIKI_WEBHOOK_SECRET`** | **0 / 20** (P1–P12 + S1–S6, run 3×) | **0 / 12** |
| Code only, migration 05 **not** run | 4 / 20 (P1, P2, P3b, P7) | 0 |

New signature attacks, all blocked:
- S1: replay after 72h;
- S2: body altered after signing;
- S3: timestamp header swapped;
- S4: legacy bare HMAC;
- S5: raw secret as Bearer;
- S6: pre-signed future timestamp.

New legit flows, all passing:
- the top-up request passes NaJiki validation;
- NaJiki's `paymentId` is stored;
- a QStash retry with a 47h-old signature still credits;
- a payment is matched by `paymentId` when metadata is missing;
- NaJiki's `SMS_DELIVERY_UPDATE` is accepted;
- a refused notification is recorded.

Regression after this pass: legit flows 17/17, app attacks 1/42 (known device transition item), direct REST money attacks 0/8, RLS policies active.

### Not fixed here: needs a decision

- **Nothing sends the queued SMS.** The school app writes SMS into `school.notifications`, but neither this repo nor najiki-finance2 has code that passes them to NaJiki `POST /api/messaging/send`. The only thing that touched them was the simulation action (now disabled), which just marked them "sent". Real SMS sending needs a dispatcher with a per-SMS price and a wallet debit. Building it needs the business rules: price per SMS/part, and what happens at zero balance.
- **NaJiki side (other repo):** `POST /api/messaging/send` does not check or debit any wallet. Anyone holding the school app's `NAJIKI_API_KEY` can send unlimited SMS billed to NaJiki's SMS account. Keep that key server-side only (it is), and rotate it if it was ever exposed.
