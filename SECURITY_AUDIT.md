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
- ~~The top-up rate limit is in memory, per server instance.~~ Fixed in Part 6: it is also counted in the database.
- ~~The kiosk can queue the same SMS twice on a fast double-tap.~~ Fixed in Part 6 (one attendance SMS per child, direction and day).
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

### Notes

- **SMS sending happens in a Supabase Edge Function** (confirmed by the owner). *Update: that function now lives in this repo at `supabase/functions/send-sms/` and is reviewed and tested end to end in Part 21 — read that part instead of this note.* The checklist raised here was: use the service-role key (migration 04 RLS blocks anon access to `school.notifications`), charge the wallet atomically once per SMS, mark a row sent only after NaJiki accepts it, and store NaJiki's `smsId` in `provider_ref` so delivery reports can match it. All four are now implemented and verified.
- **NaJiki side (other repo):** `POST /api/messaging/send` does not check or debit any wallet. Anyone holding the school app's `NAJIKI_API_KEY` can send unlimited SMS billed to NaJiki's SMS account. Keep that key server-side only (it is), and rotate it if it was ever exposed.

# Part 6: Money round 3 ("rogue" pentest): public key, teacher, races

## How it was tested

New suite `security/multi-tenant-lab/rogue-attack.mjs` (23 attacks + 9 legit flows). It attacks like a real person would:

- **Anonymous visitor:** only the public anon key, which ships inside every browser bundle.
- **Teacher:** a logged-in teacher account.
- **School admin:** a logged-in admin account.
- **Races:** many identical requests at the same moment against the kiosk, the class register and the device endpoint.

Writes use `Prefer: return=minimal`, as an attacker would, and every result is checked in the database, not from the HTTP status. The lab now also contains a `public.credit_wallet` function created the way it would be in production. The original webhook called it, so production very likely has it. Like any Supabase function, it is executable by everyone unless someone revoked it.

Two starting points were measured:

- **"Optional step skipped"** (`HARDEN=0`): 04 was run without `smartskoolz.harden_public = 'on'`. The step was optional, so this is a realistic production state.
- **"Optional step done":** the best case from Part 4/5.

## Findings (all fixed)

| # | Attack | Before (skipped / done) |
|---|---|---|
| M1 | Anonymous visitor sets **any school's wallet balance** to 99,999,999 | vulnerable / ok |
| M2 | School admin sets own wallet balance | vulnerable / ok |
| M3 | Anonymous visitor **mints 5,000,000 UGX** for any school via `rpc/credit_wallet` | vulnerable / **vulnerable** |
| M4 | Teacher mints credit via `credit_wallet` | vulnerable / **vulnerable** |
| M5 / M6 / M16 | Anonymous visitor inserts fake ledger rows, **erases the whole ledger**, reads it | vulnerable / ok |
| M7 | Anonymous visitor rewrites school B's NaJiki **tenant code**: B's future top-ups are collected under the attacker's tenant | vulnerable / **vulnerable** |
| M8 | School A admin rewrites school B's tenant code | vulnerable / **vulnerable** |
| M9 | Admin rewrites own `profiles.code` / `school_id` (used as the tenant-code fallback) | vulnerable / **vulnerable** |
| M11 | Teacher queues 50 free-text SMS to any number ("send school fees to 07…"), **paid by the school** | vulnerable / **vulnerable** |
| M12 | A sent SMS flipped back to `pending`: sent and **charged again** | vulnerable / **vulnerable** |
| M14 | **Teacher promotes self to school admin** (one REST call) | vulnerable / **vulnerable** |
| M15 | Admin reads every school's wallet balance | vulnerable / ok |
| K1 | Kiosk: 10 simultaneous check-outs → **4–9 paid SMS** for one child | vulnerable / **vulnerable** |
| K2 | Class register: 6 simultaneous submits → **6 paid SMS** for one child | vulnerable / **vulnerable** |
| T3 | Top-up limit was per server instance only | vulnerable / **vulnerable** |
| M10, M13, K3, K4, T1, T2 | settings.balance write, anonymous SMS insert, device races/replays, teacher top-up, bad amounts | ok / ok |

## Fixes

1. **`supabase_migrations/06_money_lockdown.sql` (mandatory, idempotent)**:
   - **Money functions are server-only.** Every function in `public`/`school` whose name contains wallet, credit, debit, balance, payment, topup, charge, refund, deduct, ledger or sms loses EXECUTE for PUBLIC/anon/authenticated and keeps it for `service_role`. Each one is listed in the migration output.
   - **`public.wallets`, `public.transactions`:** RLS is on and users can read only their own school's rows. Clients can never write. This was optional in 04 and is now always applied.
   - **`public.tenants`:** users can read only their own row. Clients can't write. The tenant code decides where a top-up's money is collected.
   - **`public.profiles`, `public.admin_profiles`:** users can read their own row only. `school_id`, `code` and role columns are server-only. Harmless profile columns stay editable by their owner.
   - **`school.schools`, `school.notifications`, `school.staff_users`, `school.payment_intents`, `school.payment_events`:** there are no client writes. The app already wrote all of these through the server (service role), so no app feature changes.
   - **`school.notifications.dedupe_key`** plus a UNIQUE `(school_id, dedupe_key)` index.
2. **One attendance SMS per child, per direction, per local day.** This uses the new `lib/notifications/queue.ts`, which the kiosk, the class register and the device processor all go through. Simultaneous requests can no longer queue (and pay for) a second SMS, and two paths firing for the same child (device + register) send one SMS. Without migration 06 the code falls back to the old behaviour and logs a warning; it never breaks.
3. **Durable top-up limit.** `topUpBalance` also counts the school's top-ups from the last 10 minutes in `school.payment_intents`, which every server instance shares.
4. The demo-only "simulate SMS sent" action now uses the server client, because clients can no longer write the SMS queue.

## Results

| Setup | Attacks | Legit flows broken |
|---|---|---|
| Before, optional step skipped | **17 / 23** | 0 |
| Before, optional step done | **11 / 23** | 0 |
| **After (code + 06), optional step skipped** | **0 / 23** | **0 / 9** |
| Code only, 06 not run | 10 / 23 (all database-side) | 0 |

All "secure" REST results were confirmed to be real `42501 permission denied` errors, not unrelated failures.

Regression after this round:

- payments 0/20 (12 legit OK);
- 05 not run: 4/20, same as before;
- REST money attacks 0/8;
- legit app flows 17/17;
- app attacks 1/42 (the known device transition item);
- device 0/15;
- RLS 0/32;
- genuine NaJiki-signed payment: HTTP 200, credited;
- signed by NaJiki's own source: credited 3100 of 3100;
- all dashboard pages render own-school data only;
- `tsc` and `eslint` are clean.

## Go-live steps (Part 6)

1. Run **06** after 05 (back up first). Read the NOTICE list of server-only functions.
2. **SMS Edge Function:** it must use the `service_role` key (Supabase gives it `SUPABASE_SERVICE_ROLE_KEY` automatically). After 06, a function using the anon key or a user token can no longer update `school.notifications` or call wallet/balance functions. Send one test SMS after the migration.
3. Run the two verification queries at the bottom of 06. Both must return no rows.
4. If NaJiki shares this Supabase database: it uses Prisma over a direct Postgres connection, so 06 doesn't affect it.

**Known limits (not blockers):**
- Without migration 05, the legacy `credit_wallet` path may not carry an old `settings.balance` into a newly created wallet. Running 05, which is already required, avoids that path.
- A child can still get one check-in and one check-out SMS per day; that is intended.

# Part 7: Money round 4: provisioning, stale balances, fail-closed

## Findings (all fixed)

| # | Attack / bug | Before | After |
|---|---|---|---|
| R1 | Anonymous visitor (public anon key) calls `rpc/rp_create_school_from_admin_profile` for **any profile id**, creating schools and NaJiki tenants at will. The signup code calls it with the service key, but Supabase lets PUBLIC execute every new function. | vulnerable | 42501 |
| R2 | A teacher calls the same provisioning function | vulnerable | 42501 |
| R3 | **Stale balance re-minted.** After the first credit, `settings.balance` is only a copy that SMS spending never lowers. If the wallet row is deleted (for example during duplicate cleanup), the next top-up re-created the wallet from that copy. Lab: the school spent 100,000, then **got 101,500 back for a 500 top-up**. | vulnerable | wallet = 500 |
| R5 | A wallet still holding money could be deleted, and the school's credit vanished | vulnerable | refused |
| F1 | **Without migration 05**, the webhook fell back to an old crediting path that still had P1, P2, P3b and P7 (credit for a payment never started, overpay, double credit, wrong school). Top-ups also kept taking money that couldn't be matched safely. | 4 / 20 | 0 credited |
| R4 | Anon key executes school-schema functions (already blocked by 04; now guaranteed for every school function) | ok | ok |

Also checked and found sound:

- A "failed" payment notice never touches the intent, so it can't later enable a double credit.
- A delivery report can only set `sent` or `failed`, never `pending`.
- Under-payments are credited as paid; over-payments are capped at the top-up amount.

## Fixes

1. **`supabase_migrations/07_payment_hardening.sql`** (run after 06, idempotent):
   - `apply_payment` seeds a new wallet from the old `settings.balance` **only for a school it has never credited**. A school's genuine old balance still carries over on its first top-up (tested).
   - Provisioning functions (`rp_*`, `*create_school*`, `*provision*`, `*onboard*`) are **server-only**.
   - Every `school` schema function loses EXECUTE for PUBLIC and anon. Logged-in users keep what they had (`auth_school_id`, `fn_add_person`).
   - A trigger **refuses to delete a wallet that still holds money**. The error tells you to move the balance first.
2. **Fail closed without migration 05.**
   - The webhook answers **503** (NaJiki retries for about 2 days) instead of using the weak legacy path, which is deleted.
   - `topUpBalance` refuses to start a top-up, so no money is ever taken that can't be matched.
3. The dashboard (`getSchoolBalance`, `getAttendanceData`) follows the same rule. It never shows the stale `settings.balance` as spendable for a school that has been credited before (`legacyBalanceUsable` in `lib/payments/wallet.ts`).

## Results

`security/multi-tenant-lab/round4-attack.mjs`: **before 4/5 vulnerable, after 0/5, legit 4/4.**

Full regression:

- Round 3 rogue suite 0/23 (9 legit OK);
- payments 0/20 (12 legit OK);
- REST money attacks 0/8;
- legit app flows 17/17;
- app attacks 1/42 (known device transition item);
- device 0/15;
- RLS 0/32;
- genuine NaJiki payment credited;
- NaJiki's own signer: credited;
- all 5 dashboard pages show own-school data only;
- `tsc` and `eslint` are clean.

Without 05, the payments suite shows no credit at all: P1, P2, P3b and P7 are now blocked. P4 and P9b report "not credited", which is the intended fail-closed result; nothing is lost because NaJiki retries.

## Go-live (Part 7)

1. Run migrations in order: **05 → 06 → 07 → 08 → 09** (back up first; run 09 outside gate hours). Read the NOTICE lists.
2. If you ever merge duplicate wallets: move the balance to the wallet you keep, set the other to 0, then delete it.
3. Test one signup after the migration (it uses the service key, so it must still work).

# Part 8: Launch check (links, navigation, login flows)

Goal: every link opens the exact page it should, nobody gets stuck, nothing misbehaves on day one. Tested on the **production build** (`next build` + `next start`), not only the dev server.

## Bugs found and fixed

| # | What users would have seen | Cause | Fix |
|---|---|---|---|
| L1 | Teacher logins, accounts with no school, or signups whose setup failed: browser stuck on **"too many redirects"**, login form unreachable | Dashboard sends non-admins to `/login?error=access_denied`; server components can't clear cookies, so the session survived and middleware sent them straight back to `/dashboard` | `utils/supabase/middleware.ts`: on that page, sign the session out and expire `sb-*` cookies, **only if** it fails the same admin test as the dashboard (`isWorkingSchoolAdmin`), so a shared link can't log a real admin out. Redirects also drop the old query string |
| L2 | **Sign Out** sent people to `https://0.0.0.0:3000/login` (dead page) behind a real domain/proxy | Redirect URL built from `request.url` (the server's bind address) | `app/api/logout/route.ts`: relative `Location: /login` |
| L3 | Clicking **Students** then **Teachers** in the sidebar kept showing students | People list keeps its filter in `useState`, which ignores new props on client-side navigation | `app/dashboard/people/page.tsx`: `key={initialRoleFilter}` remounts the list per role |
| L4 | On any People page **both** Students and Teachers were highlighted | Sidebar ignored `?role=` | `Sidebar.tsx` compares the role too |
| L5 | Wrong / other school's class-register link said "No active teachers found" | Server's "Class not found or access denied" was dropped | `manual-attendance/[classId]/page.tsx` shows it |
| L6 | Build log: `[auth-guard] admin verification failed: Dynamic server usage` | The guard's `catch` swallowed Next.js's internal control-flow errors (risk: page wrongly treated as static) | `lib/auth-guard.ts`: `unstable_rethrow(err)` first; real errors still fail closed. Build is now warning-free |

## How it was tested

- `security/multi-tenant-lab/link-crawl.mjs <base>` crawls every link as 4 people (logged out, school admin, teacher, account with no school), follows redirects, checks assets, the 404 page, the access-denied flow, Sign Out, and that a real admin opening an access-denied link stays logged in.
- `security/multi-tenant-lab/flows-check.mjs <base> <repo>` logs in through the real form (right password, wrong password, teacher refused), checks each sidebar page shows the right content for the right school, that a Students→Teachers click re-keys the list, the data each page loads in the browser (people lists, attendance, SMS balance, kiosk users, class register), and that another school's / garbage class links leak nothing and don't crash.
- `lib.mjs` `actionIds` now also reads production-build manifests.

## Results (production build)

- link-crawl: **NO PROBLEMS FOUND**. Logged out: protected pages go to `/login`. Admin: all 12 pages land exactly. Teacher / no-school: access-denied page, session cleared, no loop. Unknown page: 404 with a link back.
- flows-check: **ALL FLOWS OK**.
- Re-run of every earlier suite: regress 17/17 OK; attack 1/42 (known device transition item); device 0/15; RLS 0/32; payments 0/20 (legit OK); pay-rls 0/8; rogue 0/23; round 4 0/5; genuine NaJiki payment credited; NaJiki's own signer credited; 5/5 dashboard pages show own-school data only.
- `next build` clean (0 warnings), `tsc` and `eslint` clean.

## Launch-day notes

- The repo's `start` script is `next start` while `next.config` sets `output: 'standalone'`. It works (Next prints a warning). If you deploy with Docker/standalone, run `node .next/standalone/server.js` and copy `.next/static` and `public` next to it.
- No browser could be downloaded in the test sandbox, so the one client-side check (L3) was verified from the navigation payload the browser receives (the list is keyed `"student"` / `"teacher"`), not with a real click. Worth a 10-second manual click on launch day.

# Part 9: Money round 5: reconciliation (do the books add up?)

A new test, `security/multi-tenant-lab/money-reconcile.mjs`, runs 12 real-life payment scenarios through the real app (production build), then audits that every shilling in the wallet is explained by exactly one payment. The scenarios:

- a normal top-up
- the same notification delivered 25 times at once
- a NaJiki retry 47 hours later with the original signature
- "failed" then success
- a late "failed" notice after a success
- an over-reported amount
- a partial payment
- notifications that lost our reference, plus their retries
- 10 payments arriving at once
- another school's payment relabelled
- NaJiki erroring while the parent pays anyway
- NaJiki hanging

## Findings (fixed)

| # | What could happen | Fix |
|---|---|---|
| M17 | **Double credit.** A payment notification that lacked our top-up reference was matched to the school's oldest pending top-up of the same amount (correct). NaJiki's **retry** of it then matched the **next** pending top-up of that amount. With two 1,200 top-ups pending, one payment credited 2,400 | `supabase_migrations/08_payment_retry_dedupe.sql`: `apply_payment` stores every reference a credited payment arrived with (`payment_events.detail.refs`, backfilled for older payments) and treats any later notification carrying one of them as a duplicate, checked under the payment lock. The webhook now also passes NaJiki's `providerPaymentId` (the mobile money transaction id) |
| M18 | **Top-up button hung** for as long as NaJiki did (60 s+ in the test; the platform kills the request with a generic error) | `topUpBalance`: 20 s limit on the NaJiki call. On a timeout or NaJiki 5xx the school is told "If you received a PIN prompt, complete it, your balance updates automatically", and the top-up stays pending so a payment that does arrive is credited. Only a 4xx (definite refusal) marks it failed |

## Results

- Before: 23/25 checks passed (M17 double credit; M18 60.1 s hang).
- New code without 08: M17 still double credits, so **08 is required**.
- After (code + 08): **25/25 checks pass; the books balance.**
  - Wallet growth = sum of ledger credit rows = sum of "credited" payment events.
  - No reference appears in the ledger twice.
  - Every credited event has its ledger row with the same amount.
  - No top-up was credited more than requested.
  - The legacy mirror equals the wallet.
  - The dashboard shows the wallet balance.
  - School B is untouched.
- Migration 08 on a database with 19 payments credited before it:
  - It applies cleanly, twice in a row.
  - All 19 payments are backfilled with their references.
  - Re-sending a pre-08 payment is refused as a duplicate.
  - Only `service_role` can run `apply_payment` (not anon, not logged-in users).
- Full regression:
  - payments 0/20 (legit OK); pay-rls 0/8; rogue 0/21 (K1/K2 only run 16:00–22:00 EAT); round 4 0/5.
  - Genuine NaJiki payment and NaJiki's own signer: credited.
  - regress 17/17; attack 1/42 (known device item); device 0/15; RLS 0/32.
  - link-crawl clean; flows OK; 5/5 pages show own-school data only.
  - `tsc`, `eslint` and `next build` are clean.

## Go-live (Part 9)

Run migrations **05 → 06 → 07 → 08 → 09** (back up first; run 09 outside gate hours). Migration 09 is safe to re-run.

---

# Part 10: Pushing student / teacher names to the device screen

**Test:** `security/multi-tenant-lab/device-names-check.mjs`. It runs a simulated ZKTeco terminal that follows the official PUSH protocol strictly:

- Command IDs may be at most 16 letters or digits.
- Only the exact `DATA UPDATE USERINFO` / `DATA DELETE USERINFO` commands are accepted. Anything else gets `-1002`, as on real firmware.

The terminal polls the real app, applies the commands to its own user list, and replies. The test covers:

- the "push all" button
- adding a student and adding a teacher
- changing and removing a device ID
- hostile names, `ë` and apostrophes, long names, a P.5 class
- the "auto-assign IDs" button
- acknowledgements
- isolation from school B's device

**Results** are in `device-names-results-*.txt`:

| Run | Result |
|---|---|
| Before, strict device | **12 / 15 FAILED**: no name reached the screen and all commands stayed `sent` |
| Before, lenient device (allows long IDs) | **12 / 15 FAILED**: every command was refused with `-1002` |
| After | **17 / 17 OK**, the same with lenient IDs. The device list matches the school's people exactly |

| # | Severity | Problem | Fix |
|---|---|---|---|
| N1 | Critical | The command ID was the 36-character queue UUID. The spec allows 16 letters or digits at most, so strict terminals ignored every command and no name was ever shown or acknowledged. | `lib/devices/commandId.ts` sends a stable number of at most 16 digits, derived from the UUID, so no migration is needed. `devicecmd` maps it back among this device's `sent` commands. UUID replies still work for commands sent before the deploy. 200,000 random IDs gave 0 collisions. |
| N2 | High | `DATA UPDATE userinfo` was lowercase, in the adapter and in the auto-assign button. Firmware expects `USERINFO`. | Uppercase in both places. |
| N3 | High | Changing a person's device ID left the old PIN on the terminal with their name (a "ghost" that a future person with that ID would inherit). Clearing the ID left the person on the terminal. | `enqueuePersonRemovalForSchool` queues `DATA DELETE USERINFO PIN=<old>` (before the new enrolment) for the school's ZKTeco devices. |
| N4 | Medium | Students: the class was kept and the child's own name chopped to 8 letters ("Nalubega (Senior 2 East)"), and the text could go over the 24-character screen. A support staff member named "Stafford …" lost their "Stf." prefix. | The formatter shows "Name (Class)" if it fits, otherwise the full name. It is never over 24 characters and never splits an emoji. Prefix detection uses whole words. Control characters become spaces. |

**Lab-only fix:** device-attack D9 used a fixed 15:00 punch, which is "in the future" before 15:00 EAT and was correctly dropped. It now uses a punch from 2 minutes ago.

**Not changed (decisions for the school):**

- Anyone with role `admin` is enrolled with `Pri=14`, which gives them the terminal's own admin menu.
- A command that was `sent` but whose reply was lost is not re-sent automatically, because re-sending an old name could overwrite a newer one. Use **Devices → Push users** to re-sync a terminal.
- Non-English letters (ë) are sent as UTF-8. Very old firmware may show them wrongly. Check once on the real device.

**Battery after the fixes:**

| Suite | Result |
|---|---|
| device | 0/15 |
| attack | 1/42 (the known global-secret transition item) |
| regress | OK |
| rls | 0/32 |
| flows | OK |
| link-crawl | OK |
| render | OK |
| payments | 0/20 |
| pay-rls | 0/8 |
| round4 | 0/5 |
| rogue | 0/21 |
| reconcile | OK |
| genuine NaJiki | credited 2000 |
| tsc / eslint / build | clean |

**Go-live:** no migration is needed for Part 10. After deploying, press **Devices → Push users to device** once per terminal, so every name is re-sent in the correct format.

## Part 10b: Push by category, class and stream (nothing changed for users)

Streams are class entries ("S.2 East", "S.2 West"), so "push by stream" means choosing that class.

**Test:** `device-push-categories-check.mjs`. The lab school has two streams, a P.5 class, teachers, an admin, support staff, a student who left, people with no device ID, and another school with a stream of the **same name**. Every option is pressed: Teachers (including admins), Support staff, All students, each stream and class, and Everyone. Each is checked through three paths: the preview, "Push names", and "Auto-assign IDs + push".

**Result after the fix: 44/44 OK.** For every option:

- The strict simulated terminal shows **exactly** the expected people.
- The preview equals what was pushed, and the names on the device equal the names in the preview.
- Device rights are unchanged (admin 14, everyone else 0).
- The other school's stream and device are refused, and their terminal receives nothing.

**Old code vs new code:** the same test was run on `77bd32e`, the code before Part 10, with a terminal that tolerates the old long IDs. The selection (who is queued, preview counts, push counts, auto-assign) is **identical** for every option. Compare `device-push-selection-old-code.json` with `device-push-selection-after.json`. Part 10 changed how names travel to the device, not who gets sent.

**One old bug fixed (N5):** "One class" with no class picked made **Auto-assign** apply no filter, so it gave device IDs to teachers and staff too. This was already the case before Part 10. The preview and Push already treat this case as "students only", and Auto-assign now uses the same rule.

Battery after the fix: device 0/15, attack 1/42 (known), regress, rls 0/32, flows, links, render, round4, rogue, reconcile, payments 0/20, pay-rls 0/8, and genuine NaJiki are all OK. tsc, eslint and build are clean.

# Part 11: ZKTeco double-thumb attendance deduplication

## Finding and fix

The old processor compared `person_id` + `occurred_at` as strings. PostgREST returned UTC timestamps such as `2026-10-06T04:45:00+00:00`, while the app compared against `2026-10-06T04:45:00.000Z`; the same saved punch therefore looked new on a later upload. The old two-second query window also did not deduplicate a child who thumbed again seconds later, and concurrent requests could all pass the read-before-write check.

`lib/devices/processor.ts` now compares parsed instants, defaults `ATTENDANCE_DUPLICATE_WINDOW_SECONDS` to **120** (clamped to 0–3600; 0 means exact duplicates only), sorts each upload oldest-first and remembers each kept punch. Same-direction punches within the window are deduplicated; check-in and check-out remain separate. A failed lookup logs a warning and continues, while non-unique insert errors still throw for the device's 503 retry. `23505` conflicts still use the row-by-row skip fallback, and duplicate uploads still receive `OK`. Parent SMS dedupe remains one message per child, direction and local day.

Migration `09_attendance_duplicate_guard.sql` archives only exact duplicate `source='device'` rows (same person and instant), retaining the lowest `id`; it leaves seconds-apart history and manual rows unchanged. The private archive has RLS enabled and no policies, app-role grants are revoked only on that table, and a partial unique index prevents a concurrent exact device punch from being stored twice.

## Double-thumb test (real Postgres + app + PostgREST-format timestamps)

`security/multi-tenant-lab/double-thumb-check.mjs` runs the real `/iclock/cdata` endpoint and counts database rows. The shim was run with `PGRST_TS=1`; its type-1184 parser returns `YYYY-MM-DDTHH:MM:SS+00:00` and sets UTC on each connection. Results are saved as `double-thumb-results-*.json`.

| Scenario | Expected | Before (old code) | After (window 120 + migration 09) |
|---|---:|---:|---:|
| Same second twice in one upload | 1 | 1 | 1 |
| Same punch re-sent in a later upload | 1 | 2 | 1 |
| Same punch sent 5× in parallel | 1 | 5 | 1 |
| Two thumbs 2 seconds apart, one upload | 1 | 2 | 1 |
| Two thumbs 2 seconds apart, separate uploads | 1 | 2 | 1 |
| Two thumbs 40 seconds apart | 1 | 2 | 1 |
| Check-in, then check-out 1 minute later | 2 | 2 | 2 |
| Same child again 3 minutes later | 2 | 2 | 2 |
| Two different students at the same second | 2 | 2 | 2 |
| Morning check-in, afternoon check-out | 2 | 2 | 2 |
| **Scenarios passing** | **10** | **5/10** | **10/10** |

The exact duplicate in one upload already passed before the fix because the old in-memory check caught byte-identical incoming timestamps. The later-upload resend and the seconds-apart cases exposed the timestamp-format/window bugs; the parallel case exposed the missing database guard.

- With `MIG09=0`, **9/10** scenarios passed; only the parallel case failed (2 rows in this run), confirming the database index is required for the race.
- With `ATTENDANCE_DUPLICATE_WINDOW_SECONDS=0`, exact repeats still passed; the 2-second and 40-second pairs correctly remained separate (7/10 against the default-window expectations).
- Migration 09 was tested independently: **9/9** checks passed—exact duplicates archived, seconds-apart and manual rows preserved, second run safe, repeated device punch rejected, manual inserts unrestricted, backup RLS on with no policies and no grants to `anon`/`authenticated`.

## Regression battery

All requested existing suites were rerun with migration 09 enabled. Payments, SMS, device-name push, category/class/stream push and links behaved as before.

| Suite | Result |
|---|---|
| `device-attack.mjs` | 0/15 vulnerable |
| `device-names-check.mjs` | 17/17 OK |
| `device-push-categories-check.mjs` | 44/44 OK |
| `attack.mjs` | 1/42; the known `ZKTECO_GLOBAL_SECRET_FALLBACK` transition item remains |
| `regress.mjs` | 17/17 OK |
| `rls-attack.mjs` | 0/32 vulnerable |
| `flows-check.mjs` | All flows OK |
| `link-crawl.mjs` | No problems; all checked links/assets resolved |
| `render-check.mjs` | 5/5 pages show school A only |
| `round4-attack.mjs` | 0/5 vulnerable; no legitimate failures |
| `rogue-attack.mjs` | 0/21 vulnerable; no legitimate failures |
| `money-reconcile.mjs` | All money/reconciliation checks OK |
| `payments-attack.mjs` | 0/20 vulnerable; no legitimate failures |
| `pay-rls-check.mjs` | 0/8 vulnerable |
| `genuine-najiki-check.mjs` | HTTP 200; 2,000 UGX credited |
| `tsc` | Passed |
| `eslint` | Passed with 0 errors (one existing `loadData` hook-dependency warning in `app/dashboard/attendance/page.tsx`) |
| `next build` | Passed |

**Go-live:** run migrations **05 → 06 → 07 → 08 → 09 → 10** (back up first; run 09 outside gate hours).

# Part 12: Round 12 Production Hardening, Scoped Capability Tokens & Zero-Vulnerability Supply Chain

## Findings & Fixes (all 11 resolved)

1. **Guardian linkage column & error propagation (`app/dashboard/people/actions.ts`):**
   - Fixed `student_parents` fallback insert column from nonexistent `is_primary` to `is_primary_contact: true`.
   - Checked `{ error }` on both `parents` and `student_parents` lookups/inserts, rolling back partial person rows and failing loudly instead of returning `guardian_linked: true` when guardian linking fails.
   - Sanitized leading formula prefixes (`=`, `+`, `-`, `@`, control characters) on person and guardian names and enforced canonical numeric enrollment PIN collision checks (`0555` vs `555`) in both `addPersonAction` and `updatePersonDeviceUserIdAction`.
2. **Production schema reconciliation & missing-column fallback resilience (`supabase_migrations/10_round12_production_hardening.sql`, `utils/zkteco/commandQueue.ts`, `app/iclock/devicecmd/route.ts`, `lib/devices/processor.ts`, `app/mark-attendance/actions.ts`, `security/multi-tenant-lab/seed.js`):**
   - Added idempotent migration `10_round12_production_hardening.sql` reconciling 19 columns across `school.devices`, `school.device_commands`, `school.device_logs`, and `school.person_credentials`, adding unique index `person_credentials_school_type_val_uniq`, and refreshing column-level `SELECT` grants while keeping secret columns (`pin_hash`, `failed_attempts`, `locked_until`, `device_secret`, `device_secret_hash`) strictly server-only and preserving zero client writes on `school.staff_users` per `06_money_lockdown.sql`.
   - Added `PGRST204` missing-column fallback loops in `commandQueue.ts`, `devicecmd/route.ts`, `processor.ts`, and `mark-attendance/actions.ts` so deployments stay operational even before migration `10` runs (`MIG10=0` + `SHIM_NO_AUTOCOL=1` verified).
3. **Legacy ADMS proxy lockdown (`app/legacy-adms-proxy/server.js`):**
   - Removed the hardcoded dev Cloud Run URL (`UPSTREAM_URL` required at startup), restricted paths/methods strictly to `GET|POST /iclock/cdata`, `GET /iclock/getrequest`, and `POST /iclock/devicecmd`, stripped incoming `x-forwarded-for`, `x-real-ip`, `x-device-token`, `authorization`, and `cookie` headers, enforced a 1 MiB body limit (`413`) and 15 s upstream timeout, and injected per-serial `X-Device-Token` values from `DEVICE_TOKENS_JSON` (falling back to `ZKTECO_DEVICE_SECRET`).
4. **Trusted proxy client IP extraction, hardware GoTrue bypass & relative redirects (`lib/security/request.ts`, `lib/devices/gateway.ts`, `middleware.ts`, `utils/supabase/middleware.ts`, `scripts/start-standalone.mjs`):**
   - Hardened `getClientIp` to ignore spoofed `X-Forwarded-For` headers unless running behind a verified proxy (`K_SERVICE`, `VERCEL`, or `TRUSTED_PROXY_HOPS`) and to read the right-most external hop rather than `split(',')[0]`.
   - Bypassed `supabase.auth.getUser()` round-trips on `/iclock/*`, `/api/devices/*`, and `/api/webhooks/*`.
   - Switched `middleware.ts` to `runtime: 'nodejs'` (ensuring live runtime secret resolution even on zero-secret Docker builds) and enforced host-header-immune relative `Location: /login` and `Location: /dashboard` 307 redirects preserving `Set-Cookie`.
5. **Web-Crypto HMAC-SHA256 scoped capability tokens for classroom teachers & gate kiosks (`lib/security/register-token.ts`, `app/manual-attendance/[classId]/{layout.tsx,page.tsx,actions.ts}`, `app/mark-attendance/{layout.tsx,actions.ts}`, `app/dashboard/classes/{page.tsx,CopyLinkButton.tsx}`, `app/dashboard/attendance/{actions.ts,page.tsx}`):**
   - Classroom teachers and gate kiosks now open `/manual-attendance/[classId]?token=...` (`sk_reg_cap` HttpOnly cookie) and `/mark-attendance?token=...` (`sk_kiosk_cap` HttpOnly cookie) without sharing the full `school_admin` session cookie.
   - Student rosters on capability-scoped register sessions are withheld until a valid Teacher PIN is verified (`sk_reg_pin` cookie bound to `pin_hash` digest so PIN resets immediately revoke prior sessions), while `school_admin` sessions retain full compatibility.
6. **PWA service worker v3 & logout `Clear-Site-Data` (`public/sw.js`, `app/api/logout/route.ts`):**
   - Bumped service worker cache to `smartskoolz-pwa-v3`, purged stale caches on `activate`, removed `/dashboard` from `STATIC_ASSETS`, bypassed all dynamic/authenticated/API/hardware paths (`/`, `/dashboard*`, `/manual-attendance*`, `/mark-attendance*`, `/login`, `/signup`, `/api/*`, `/iclock/*`, `/auth/*`), and added `Clear-Site-Data: "cache", "cookies", "storage"` + capability cookie expiration to `POST /api/logout`.
7. **Zero-dependency OpenXML `.xlsx` / Blob CSV export & dependency upgrades (`lib/security/safe-spreadsheet.ts`, `app/dashboard/attendance/AttendanceReports.tsx`, `package.json`, `scripts/start-standalone.mjs`):**
   - Replaced vulnerable `xlsx@0.18.5` with a zero-dependency ECMA-376 OpenXML `.xlsx` + RFC 4180 `Blob` CSV builder neutralizing formula injection (`=`, `+`, `-`, `@`, `\t`, `\r`) and fixing `#` data-URI truncation.
   - Removed unused `firebase-tools`, upgraded `next` & `eslint-config-next` to `15.5.28` and `sharp` to `^0.35.5`, added `scripts/start-standalone.mjs` for `"output": "standalone"`, and regenerated `package-lock.json` (`npm audit --omit=dev`: **0 vulnerabilities**; `npm audit --audit-level=critical`: **0 critical**).
8. **Device quotas, invite gate, multi-gate `ALL` broadcasts, midnight `% 24` formatting & repository hygiene (`app/dashboard/devices/actions.ts`, `app/signup/actions.ts`, `app/iclock/getrequest/route.ts`, `lib/devices/processor.ts`, `lib/attendance-window.ts`, `lib/eat-time.ts`, `.gitignore`):**
   - Added rate limiting and `MAX_DEVICES_PER_SCHOOL` quota enforcement to `addDeviceAction`, optional timing-safe `SIGNUP_INVITE_CODE` gating to `signupAction`, per-gate `delivered_device_ids` tracking on `target_serial = 'ALL'` broadcasts in `getrequest`, exact-match-first + canonical ambiguity guard on numeric PIN matching in `processor.ts`, `% 24` normalization on all `hour12: false` formatters, and purged tracked debug/cache artifacts (`fix-cdata.js`, `fix-route.js`, `.env.test.local`, `node-compile-cache/`).

## Verification Summary (PostgreSQL 17.5 + `SHIM_NO_AUTOCOL=1` + Standalone Next.js 15.5.28)

| Suite | Result |
|---|---|
| `round12-check.mjs` (`MIG10=0` fallback + `MIG10=1` full suite) | **35/35 PASSED** |
| `rls-attack.mjs` | **0/32 vulnerable** |
| `attack.mjs` (strict mode `ZKTECO_GLOBAL_SECRET_FALLBACK=false`) | **0/42 vulnerable** |
| `regress.mjs` | **17/17 OK** |
| `device-attack.mjs` | **0/15 vulnerable** |
| `device-names-check.mjs` | **17/17 OK** |
| `device-push-categories-check.mjs` | **45/45 OK** |
| `double-thumb-check.mjs` / `double-thumb-migration-check.mjs` | **10/10 PASS** / **9/9 PASS** |
| `payments-attack.mjs` (dedicated `NAJIKI_WEBHOOK_SECRET`) | **0/20 vulnerable; 0 legit failures** |
| `rogue-attack.mjs` | **0/21 vulnerable; 0 legit failures** |
| `round4-attack.mjs` | **0/5 vulnerable; 0 legit failures** |
| `pay-rls-check.mjs` | **0/8 vulnerable** |
| `money-reconcile.mjs` | **All money/reconciliation checks OK** |
| `topup-limit-check.mjs` | **PASS: 6 allowed, then refused** |
| `legacy-devlogs.mjs` | **punch 200 OK \| device_logs +1 \| attendance +1** |
| `flows-check.mjs` / `render-check.mjs` / `link-crawl.mjs` / `orphan-check.mjs` | **25/25 OK** / **5/5 OK** / **No problems found** / **No leak** |
| `security/pentest/attack.mjs` & `security/pentest/regress.mjs` | **15/15 SECURE** & **14/14 PASS** |
| `npm ci` + `npm audit --omit=dev` + `eslint` + `tsc --noEmit` + `npm run build` | **0 prod vulnerabilities, 0 errors, clean standalone build** |

# Part 13: Round 13 Deep Money Integrity, Webhook Hardening & Live Penetration Testing

## Adversarial Findings Reproduced Live & Closed (`money-round13-attack.mjs`)

1. **Cross-Tenant Deduplication Black Hole via Placeholder References (`supabase_migrations/11_round13_money_integrity.sql`, `lib/payments/webhook.ts`):**
   - **Pre-patch reproduction (`R13-01`, `R13-02`):** Auxiliary/placeholder values echoed by mobile money gateways (`providerPaymentId: "N/A"`, `"0"`, `"NONE"`, `"MTN"`, etc.) were stored in `school.payment_events.detail.refs` and matched globally via `(detail -> 'refs') ?| v_refs` *before* intent matching. Once any school completed a payment carrying `"N/A"`, every subsequent payment across every school carrying `"N/A"` returned `200 {"outcome":"duplicate"}`, permanently dropping paid money without retries.
   - **Fix:** Added `school.clean_payment_refs(text[])` in PostgreSQL and `cleanReferenceToken()` in `lib/payments/webhook.ts` to strip placeholder/noise/short tokens before deduplicating or persisting `detail.refs`.
2. **Payment Webhook Black Hole on Event Names Containing `sms` (`app/api/webhooks/najiki/handler.ts`, `lib/payments/webhook.ts`):**
   - **Pre-patch reproduction (`R13-03`):** `isDeliveryReport` matched any event type containing `"sms"` when `"payment"` was absent (e.g. `sms_topup.completed`, `wallet.sms_topup`), skipping `handlePayment()` and answering `200 {"received":true}` without crediting or logging the payment.
   - **Fix:** Added `hasPaymentIndicators()` and broadened `classifyPayment()` so any payload carrying payment/top-up identifiers (`paymentIntentId`, `providerPaymentId`, `sch_topup_*`) routes exclusively to `handlePayment()`.
3. **Outer-Envelope Foreign Currency Bypass & Object Coercion (`lib/payments/webhook.ts`, `app/api/webhooks/najiki/handler.ts`):**
   - **Pre-patch reproduction (`R13-04`):** `paidCurrency()` inspected only inner `payload.data` and coerced non-string objects (e.g. `{ code: "KES" }`) to `"" || "UGX"`, crediting `USD` and `KES` payments at 1:1 `UGX` value.
   - **Fix:** `paidCurrency(eventData, payload)` inspects all currency fields across outer `payload`, inner `data`, `data.amount`, and `metadata`, rejects conflicting or malformed values, and passes non-UGX codes straight to `apply_payment()` (`currency_mismatch`, HTTP `202`).
4. **Sub-Shilling Dust Attack (`0.001 UGX`) Burning Pending `50,000 UGX` Intents & Money Envelope Parsing (`lib/payments/webhook.ts`, `supabase_migrations/11_round13_money_integrity.sql`):**
   - **Pre-patch reproduction (`R13-05`):** A webhook reporting `amount: 0.001` matched a `50,000 UGX` `pending` intent, marked it `credited` with `credited_amount = 0.00` while adding `0.001` to `public.wallets.balance` (breaking double-entry parity), and caused the genuine `50,000 UGX` webhook to be dropped as `duplicate`. Meanwhile, valid money envelopes (`{ value: 3500, currency: "UGX" }`) or whitespace `amount: "   "` + `amount_paid` failed with HTTP `400`.
   - **Fix:** Enforced whole-shilling positive integer UGX validation (`>= 1`, `trunc(p_amount) = p_amount`, non-`NaN`) in both `paidAmount()` and SQL `school.apply_payment()`, while unwrapping `{ value | amount }` envelopes and skipping blank strings cleanly.
5. **Outer vs Inner Envelope School ID Conflict Bypass (`app/api/webhooks/najiki/handler.ts`):**
   - **Pre-patch reproduction (`R13-06`):** `resolveWebhookSchool()` ignored outer `payload.externalEntityId` / `payload.schoolId`, allowing conflicting outer vs inner tenant UUIDs to pass with HTTP `200`.
   - **Fix:** Collected school UUID candidates across both outer and inner envelopes (plus `metadata`), rejecting any discrepancy with HTTP `400` and recording `rejected_conflicting_school`.
6. **Blank / Punctuation-Only Phone Bypass, Cross-Tenant `profiles.code` Routing, & Multi-Instance Quota Race in `topUpBalance()` (`app/dashboard/attendance/actions.ts`, `app/dashboard/attendance/page.tsx`, `supabase_migrations/11_round13_money_integrity.sql`):**
   - **Pre-patch reproduction (`R13-07`, `R13-08`, `R13-09`):** `"         "` and `"---------"` passed `/^\+?[0-9\s\-().]{9,20}$/`, inserting empty-phone intents and calling NaJiki; a stale `public.profiles` row pointing to another school routed Mobile Money collection into the other school's NaJiki merchant account; and concurrent requests across instances raced past `SELECT ... LIMIT maxTopUps` (`1003` rows vs `1000` limit).
   - **Fix:** Normalized and validated 9–15 numeric MSISDN digits up front in both client UI and server action, verified `profiles.school_id === school.id` without raw `.or()` interpolation, sanitized error responses, and introduced advisory-locked `school.create_payment_intent()` (`pg_advisory_xact_lock`) with graceful `MIG11=0` fallback.
7. **Wallet Kernel Constraints, `wallet_migrated` Persistence & Atomic SMS Debit (`supabase_migrations/11_round13_money_integrity.sql`, `lib/payments/wallet.ts`, `app/dashboard/attendance/actions.ts`):**
   - **Pre-patch reproduction (`R13-10a`, `R13-10b`, `R13-10c`):** `public.wallets` allowed cross-tenant hybrid rows (`tenant_id = B, school_id = A`) and negative balances (`-500`), while `getSchoolBalance()` resurrected spent `settings.balance` when `settings.wallet_migrated = true`.
   - **Fix:** Added `wallets_same_tenant_chk` and `wallets_non_negative_balance_chk` constraints on `public.wallets`, stamped `settings.wallet_migrated = true` on wallet updates, failed closed on non-missing-table errors in `legacyBalanceUsable()`, aligned single-tenant wallet selection across SQL and TypeScript, and added atomic server-only `school.debit_sms_wallet()` (verified under 20x concurrency in `R13-13`).
8. **SMS Delivery State Machine, Schema Reconciliation & Retry Semantics (`app/api/webhooks/najiki/handler.ts`, `supabase_migrations/11_round13_money_integrity.sql`):**
   - **Pre-patch reproduction (`R13-11a`–`d`):** Delayed `QUEUED` / `SUBMITTED` webhooks overwrote `'sent'` SMS rows back to `'failed'`; `school.notifications` lacked `provider_ref`, `sent_at`, and `provider_response` under strict PostgREST (`SHIM_NO_AUTOCOL=1`); explicit `schoolId` claims on delivery webhooks were unvalidated; and transient DB errors returned `200` instead of `500`.
   - **Fix:** Added `provider_ref`, `sent_at`, and `provider_response` + partial index in `11_round13_money_integrity.sql` (with `MIG11=0` fallback), treated intermediate carrier statuses as non-terminal no-ops, guarded `.neq('status', 'sent')` against state regressions, scoped updates by explicit `schoolId` when provided, and returned HTTP `500` on DB failures so QStash retries cleanly.
9. **Static Non-Unique Gateway Tags (`"SMARTSKOOLZ_SMS"`), Multi-Intent Reference Stuffing, Top-Level JSON Array Guard & 4-Way Ledger Parity (`supabase_migrations/11_round13_money_integrity.sql`, `app/api/webhooks/najiki/handler.ts`, `app/dashboard/attendance/actions.ts`):**
   - **Fixes (`R13-19`–`R13-22`):** Required digit/UUID entropy in SQL `school.apply_payment()` deduplication so static labels such as `"SMARTSKOOLZ_SMS"` or `"MOBILE_MONEY"` can never falsely drop another school's payment as `duplicate`; counted ALL matching pending intents in `apply_payment()` (`count(*)`) so multi-intent reference stuffing returns `ambiguous_intent` (`HTTP 202`) instead of burning an intent; rejected top-level JSON arrays (`[]`) at `handler.ts` with `HTTP 400 Invalid JSON payload`; checked `intentErr` on direct fallback insert in `topUpBalance()`; and verified exact 4-way reconciliation across `public.wallets.balance`, `school.payment_events`, `public.transactions`, and `school.schools.settings.balance` mirror (`School A: 91,700 === 91,700 === 91,700 === 91,700`, `School B: 30,000 === 30,000 === 30,000 === 30,000`).
10. **Next.js Multipart `FormData` Streaming Race Elimination (`middleware.ts`, `app/dashboard/people/actions.ts`, `app/dashboard/devices/actions.ts` — `R13-23`):**
   - **Pre-patch reproduction:** Running `regress.mjs` back-to-back against standalone Next.js `15.5.28` with `export const config = { runtime: 'nodejs' }` in `middleware.ts` and synchronous tick-0 `formData.get('fullName')` in `addPersonAction` dropped multipart `FormData` fields on ~40% of cold socket bursts (`2/5` runs returning `{"error":"Full Name and Role are required."}`).
   - **Fix:** Restored standard Next.js Edge Runtime in `middleware.ts` (`lib/security/register-token.ts` uses pure Web Crypto `crypto.subtle`) and moved `await requireSchoolAdmin()` ahead of `formData.get(...)` in both `addPersonAction` and `addDeviceAction` (rejecting unauthenticated callers before parsing untrusted form inputs and yielding across async auth I/O). Verified `10/10` consecutive stress runs (`170/170` checks, `0.00%` failure rate).

## Round 13 Verification Matrix

| Suite | Pre-Patch | Post-Patch |
|---|---|---|
| `money-round13-attack.mjs` (24 red-team + 4-way double-entry + `MIG11=0` checks) | **16 vulnerable / 16 + ledger drift** | **0 vulnerable / 24; 0 legit failures (`91,700` & `30,000` 4-way exact)** |
| `payments-attack.mjs` | — | **0 vulnerable / 20; 0 legit failures** |
| `money-reconcile.mjs` + `genuine-najiki-check.mjs` | — | **BOOKS BALANCE: ALL MONEY CHECKS OK (`21,700 === 21,700`, `19 vs 19`)** |
| `round4-attack.mjs` / `pay-rls-check.mjs` / `rogue-attack.mjs` | — | **0/5** / **0/8** / **0/23 vulnerable** |
| `topup-limit-check.mjs` | — | **PASS: 6 allowed, then refused** |
| `rls-attack.mjs` / `null-inherit-check.js` / `test-triggers.js` | — | **0/32 vulnerable** / **3/3 passed** / **16/16 passed** |
| Strict `attack.mjs` / `regress.mjs` (10x stress) / `device-attack.mjs` | **40% multipart race in `regress.mjs`** | **0/42 vulnerable** / **10/10 (`170/170` OK)** / **0/15 vulnerable** |
| `round12-check.mjs` + all device, duplicate, crawl, SSR, orphan & `pentest` suites | — | **100% PASS (35/35, 10/10, 9/9, 15/15 SECURE, 14/14 PASS)** |

**Go-live migration sequence:** run **05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14** (all migrations are 100% idempotent).

## Rounds 14–17: Per-School Settings Lockdown, Strict 2-Write Daily Attendance & Full-Branch Offensive Penetration Test

### New Migrations & Security Controls Added
1. **`supabase_migrations/12_school_settings.sql` + `lib/school-settings.ts` + `app/dashboard/settings/*`:**
   - Dedicated `school.school_settings` table containing strictly **0 financial, pricing, or wallet columns** (`31` operational columns only), completely isolated from `school.schools.settings` JSONB.
   - Direct PostgREST writes (`INSERT`/`UPDATE`/`DELETE`) and client RPC execution on `school.save_school_settings` revoked from `anon` and `authenticated`; enforced server-side via `validateSchoolSettingsInput()` + PL/pgSQL rejection of all financial keys (`smsPrice`, `balance`, `walletBalance`, etc.) + strict GSM-7 single-segment SMS cap (`<= 160` ASCII chars, zero UCS-2 emojis).
2. **`supabase_migrations/13_two_daily_punches_guard.sql` + `lib/devices/processor.ts` + Kiosk/Register Actions:**
   - Enforces at most **2 attendance writes per person per local school day** across both application code and PostgreSQL (`UNIQUE INDEX attendance_logs_one_in_one_out_per_day (person_id, attendance_date, attendance_type)` + automatic timezone slot trigger `trg_attendance_logs_daily_slot`).
   - Archives pre-existing duplicate punches safely into RLS-locked `school.attendance_logs_duplicates_backup` (`service_role` only; `0` grants to `PUBLIC`/`anon`/`authenticated`) while preserving historical `late` `check_in` rows untouched.
3. **`supabase_migrations/14_rbac_audit_immutability_hardening.sql` (Discovered & Remediated During Full-Branch Penetration Test):**
   - **Pre-Patch Red-Team Findings (`full-branch-pentest.mjs before` — `8/27` Exploitable):**
     - `PT-05..PT-09` (**High — Intra-Tenant Vertical Privilege Escalation**): Non-admin `teacher` accounts blocked from `/dashboard` in Next.js could extract their own GoTrue JWT and call PostgREST directly to read parent phone directories, overwrite guardian SMS phone numbers, inject raw `ZKTeco` hardware commands (`DATA DELETE USERINFO`), wipe `school.attendance_logs`, and read `public.wallets`.
     - `PT-10..PT-11` (**High — Audit Trail Tampering Under Compromised Token**): A stolen `school_admin` JWT could execute `DELETE` on `school.attendance_logs` and `POST`/`DELETE` on raw biometric `school.device_logs`.
     - `PT-12` (**Medium — Arbitrary `status` Injection**): Direct PostgREST inserts accepted arbitrary strings (e.g. `<script>alert(1)</script>`) in `school.attendance_logs.status`.
   - **Remediation Verified (`full-branch-pentest.mjs after` — `27/27 SECURE | 0 VULNERABLE`):**
     - Added `SECURITY DEFINER` function `school.is_school_admin()` and enforced `RESTRICTIVE` RLS policies (`rbac_school_admin_only`) across every `school.*` table plus `public.wallets`, `public.transactions`, and `public.tenants`.
     - Revoked `DELETE, TRUNCATE` on `school.attendance_logs` and `INSERT, UPDATE, DELETE, TRUNCATE` on `school.device_logs` from `anon` and `authenticated`.
     - Enforced `CHECK (status IN ('present', 'late', 'absent', 'excused'))` on `school.attendance_logs`.




---

# Part 19: Full re-verification from a clean machine (2026-10-24)

Everything above was re-proven end to end on a freshly rebuilt environment:
PostgreSQL **17.5** (embedded binaries), the strict PostgREST/GoTrue shim
(`SHIM_NO_AUTOCOL=1 PGRST_TS=1`), and the **production start path**
(`npm start` -> `scripts/start-standalone.mjs`, i.e. the standalone server, not
`next start`) so the redirect + header hardening is tested exactly as it ships.

## Re-verification results

| Suite | Result |
|---|---|
| `full-branch-pentest.mjs` (27 vectors, incl. production launcher) | **27/27 SECURE, 0 vulnerable** |
| `full-branch-pentest.mjs before` (`MIG14=0`, regression proof) | **19/27, 8 vulnerable** (same 8, unchanged) |
| `attack.mjs` strict (`ZKTECO_GLOBAL_SECRET_FALLBACK=false`) | **0/42 vulnerable** |
| `device-attack.mjs` strict | **0/15 vulnerable** |
| `round12-check.mjs` | **35/35 passed** |
| `round14-settings-check.mjs` | **40/40 passed** |
| `round16-two-writes-check.mjs` | **18/18 passed** |
| `double-thumb-check.mjs` / `double-thumb-migration-check.mjs` | **11/11** / **9/9** |
| `money-round13-attack.mjs` | **0/24 vulnerable**, 4-way parity exact |
| `payments-attack.mjs` | **0/20 vulnerable** |
| `money-reconcile.mjs` | **ALL MONEY CHECKS OK** |
| `rogue-attack.mjs` / `round4-attack.mjs` / `pay-rls-check.mjs` / `rls-attack.mjs` | **0/21**, **0/5**, **0/8**, **0/32** |
| `flows-check.mjs` / `link-crawl.mjs` | **ALL FLOWS OK** / **NO PROBLEMS FOUND** |
| `null-inherit-check.js` / `test-triggers.js` | **4/4** / **16/16** |
| `device-names-check.mjs` / `device-push-categories-check.mjs` | **ALL CHECKS OK** |
| `topup-limit-check.mjs` (production default limit) | **6 allowed, then refused** |
| `genuine-najiki-check.mjs` (cross-repo) | **200, 2000 of 2000 UGX credited** |
| `najiki-own-signer-check.mjs` (signed by NaJiki's own source) | **200, 3100 of 3100 UGX; NaJiki's verifier agrees** |
| `npm audit` (prod and full) / `lint` / `tsc` / `build` | **0 vulnerabilities** / 0 errors (2 pre-existing warnings) / 0 / success |

## Issues found by the re-run and fixed

1. **[HIGH, dependency] `zod < 4.6.6` memory-exhaustion advisory (GHSA-mrhx-c7xc-m3w5).**
   Surfaced by `npm audit` on a fresh install. `zod` was a declared but unused
   dependency (no import anywhere in the app), so it was upgraded to
   **`zod ^4.6.7`** with no API surface affected. `npm audit` is back to
   **0 vulnerabilities** for both `--omit=dev` and the full tree.
2. **[Test flakiness] `money-round13-attack.mjs` R13-13 replayed a fixed reference.**
   The wallet-debit race test fired 20 concurrent debits and then replayed
   `sms_debit_0` to prove idempotency. Only 5 of the 20 can win, so ~75% of runs
   replayed a *losing* reference and correctly got `insufficient_funds` instead
   of `duplicate` — a false "vulnerable". The test now replays a reference that
   actually won. The security property itself was never at risk: it stayed
   **exactly 5 debits, final balance 0, no overdraft, no double-debit** in every
   run. Verified **5/5 consecutive clean runs**.
3. **[Harness deadlock] Lab shim could exhaust its connection pool.**
   Each `/rest/v1/` request pins one pooled client for its whole transaction, but
   two in-request probes (`pg_proc` lookups in `auth_school_id` and the RPC
   resolver) asked the pool for a *second* client. With pg's default `max: 10`,
   ~10 concurrent requests deadlocked the shim — which is why concurrent webhook
   suites could hang indefinitely. Fixed by running those probes on the request's
   own client (`dbq(...)`) and raising the pool to `max: 32`.
4. **[Harness robustness] A dropped Postgres connection killed the shim.**
   `pg_terminate_backend` (or any server restart/failover) emitted an unhandled
   `'error'` on the pool and exited the process mid-run, which looks like a test
   failure. Added a `pool.on('error')` listener that logs and keeps serving.
5. **[Test hygiene] `test-triggers.js` could only ever run once.**
   It creates a `school` schema in the `postgres` database and never dropped it,
   so every subsequent run died with `42P06`. It now drops the schema before and
   after, and is re-runnable (verified by two consecutive runs).

## Note on `null-inherit-check.js`

The third case previously asserted that a school-A admin could `INSERT` into
`school.device_logs` (with `school_id` NULL inheriting to A). Migration 14
deliberately makes `device_logs` a **server-only audit table** (finding PT-11),
so that expectation became wrong. The check now asserts the hardened behaviour
— anonymous/authenticated inserts are refused, and the NULL-inheritance trigger
is still verified through the service role the app actually uses
(**4/4 passing**).
---

# Part 20: Cross-check against the live payment provider source (2026-10-24)

We cloned the provider (`najiki-finance2`) and checked our integration against
its **actual source**, not against assumptions about it. The new suite
`security/multi-tenant-lab/provider-contract-check.mjs` imports the provider's
own modules — `src/lib/schemas.ts` (`CreatePaymentRequestSchema`,
`InternalNotificationPayloadSchema`), `src/lib/notification-signature.ts`
(`buildNotificationHeaders`, `verifyNotificationSignature`) and
`src/lib/constants.ts` (`PLATFORM_FEE_TYPES`, `isPlatformFeeType`) — via a small
ESM resolver hook (`ts-ext-hook.mjs`) so their TypeScript runs unmodified. It
then checks the traffic we really produce, captured off the wire.

## Finding 1 — HIGH: every SMS top-up was filed as a TENANT COLLECTION

We sent `paymentTypeCode: "general"`. The provider classifies each charge by
that code (`payment-intent-handler.ts`):

```ts
const isPlatformPayment = isPlatformFeeType(paymentType?.code ?? validatedBody.paymentTypeCode)
let credentialSource = isPlatformPayment ? 'platform-fee' : 'none'
if (!isPlatformPayment && (tenant || appRequiresTenantCredentials(application.code))) {
  const resolvedCreds = await resolveTenantOrPlatformCredentials(tenant.id, provider.id, tenant.code)
  if (!resolvedCreds) return NextResponse.json({ error: `Tenant "..." has no active credentials ...` }, { status: 503 })
}
```

`"general"` is **not** in `PLATFORM_FEE_TYPES` (`SMS`, `BUY_SMS`, `SMS_TOPUP`,
`ACTIVATION`, `ACCOUNT_ACTIVATION`, `SUBSCRIPTION`, `MONTHLY_SUBSCRIPTION`,
`PLATFORM_FEE`), so every school top-up went down the tenant-collection path and
demanded per-tenant gateway credentials. For a school without its own LivePay
account that is a **503 and the top-up never starts**.

An SMS-credit purchase is platform money. The provider seeds `BUY_SMS` itself as
*"SMS credits top-up (platform fee)"* (`scripts/seed.ts`) and its own messaging
route documents "BUY_SMS funds go to Na'jiki; the partner allocates SMS credits".

**Fix:** `paymentTypeCode` defaults to `BUY_SMS`, overridable with
`NAJIKI_PAYMENT_TYPE_CODE`, documented in `.env.example`. The code is also
echoed in `metadata.paymentTypeCode` for reconciliation.

**Proof (same suite, old value forced back via the env knob):**
`NAJIKI_PAYMENT_TYPE_CODE=general` → `FAIL our paymentTypeCode is in THEIR
PLATFORM_FEE_TYPES`; with the default → `PASS ... [BUY_SMS]`.

## Finding 2 — HIGH: a provider-side `tenantId` could reject every payment

The completion notification carries 13 fields, including the provider's **own**
`tenantId`:

```ts
const payloadObject = { paymentIntentId, reference, status, amount, currency,
  providerPaymentId, failureReason, externalEntityId, tenantId, tenantCode,
  paymentType, paymentTypeCode, metadata }
```

Our resolver treated `tenantId` as an equal "school UUID" claim next to the
`externalEntityId` we send. `Tenant.id` is a Prisma `cuid()` today, which fails
our UUID regex — so the collision was latent, not live — but the moment a
provider-side tenant id is UUID-shaped, the two claims disagree and every real
payment is rejected as *"Conflicting school identifiers"*.

**Fix:** two confidence tiers in `resolveWebhookSchool`. Explicit school
identifiers (`externalEntityId`, `schoolId`, `metadata.schoolId`) decide;
`tenantId`/`tenant_id` is only consulted when no school UUID is present (our own
`public.tenants` rows use the school UUID as their id). The existing
conflict-within-a-tier check is unchanged.

## Finding 3 — MEDIUM: SMS delivery reports matched on one identifier only

The provider's terminal SMS notification is:

```ts
{ eventType: 'SMS_DELIVERY_UPDATE', smsId, reference, status, providerId,
  recipient, applicationCode }
```

`smsId` is the provider's `SmsMessage.id`, `providerId` the carrier's id and
`reference` the provider's SMS reference. We matched only the first identifier
we found against `notifications.provider_ref`, so delivery reports were silently
dropped whenever the SMS Edge Function stored a different one. Also,
`delivered | failed | unknown | queued | pending` is the provider's status set
and `unknown` was being treated as a terminal failure.

**Fix:** match `provider_ref` against **any** of `smsId`, `messageId`,
`providerId`, `providerMessageId`, `reference`, `id`; fall back to the row id
for UUID-shaped identifiers; add `UNKNOWN` to the non-terminal statuses. The
"never downgrade an already-`sent` row" guard is preserved.

## Verified contract (`provider-contract-check.mjs`, 30 checks, all passing)

| Direction | Check |
|---|---|
| Outbound | Our body passes **their** `CreatePaymentRequestSchema` |
| Outbound | `applicationCode`, `tenantCode`, `paymentTypeCode` present; `externalEntityId` = school UUID; `amount` a JSON **number** of whole shillings; `currency` normalises to `UGX`; `phoneNumber` 9–15 MSISDN digits; `idempotencyKey` `sch_topup_<uuid>` |
| Outbound | Their `CreatePaymentResponse` shape `{paymentId uuid, reference, status}` |
| Routing | `paymentTypeCode` ∈ `PLATFORM_FEE_TYPES` → `credentialSource='platform-fee'` |
| Routing | `general` (the old value) is **not** a platform fee → tenant collection (regression guard) |
| Inbound | Their completion payload (all 13 fields) passes their `InternalNotificationPayloadSchema` |
| Inbound | Credits exactly the amount paid, once; redelivery is idempotent |
| Inbound | A foreign UUID `tenantId` does not block crediting |
| Inbound | Their own `verifyNotificationSignature` accepts the signature we were sent |
| Inbound | `/api/internal/payment-completed` credits identically to `/api/webhooks/najiki` |
| Inbound | `SMS_DELIVERY_UPDATE` matches by `smsId` and by `reference`; `unknown` is a no-op; late `failed` does not downgrade `sent`; a queued row does receive `failed` |

`/api/internal/payment-completed` is a thin delegation to the same
`handleNajikiWebhook`, so both the legacy path and the provider's self-healed
`/api/webhooks/najiki` path behave identically. Note the provider's self-heal
(`resolvePartnerWebhookUrl` / `postSignedPartnerWebhook`) only rewrites the
legacy path for `application.code === 'sacco'`; for `school` it is our route
that must answer — and it does.

## Regression

Re-ran after the fix, all green: `money-reconcile` **ALL MONEY CHECKS OK**,
`money-round13-attack` **0/24**, `payments-attack` **0/20**, `rogue-attack`
**0/21**, `round4-attack` **0/5**, `pay-rls-check` **0/8**,
`full-branch-pentest` **27/27 SECURE**, `flows-check` **ALL FLOWS OK**,
`round12` **35/35**, `round14` **40/40**, `round16` **18/18**. `tsc` 0 errors,
`lint` 0 errors, production build OK.

## Deployment note

`NAJIKI_PAYMENT_TYPE_CODE` defaults to `BUY_SMS`; only change it if the
`school` application in the gateway expects a different platform-fee code. The
`tenantCode` we send must exist as a tenant of the `school` application in the
gateway's own `tenants` table — the two systems must agree on tenant codes.

# Part 21: The SMS Edge Function (the only component that spends money)

## The rule this part enforces

A school never sends an SMS itself. The Next.js app only inserts a `queued` row
into `school.notifications` (`lib/notifications/queue.ts`). Everything after
that — pricing, charging the wallet, calling NaJiki, recording the provider's
id — happens in `supabase/functions/send-sms/`, a Deno Edge Function. Two files:

- `sms-sender.ts` — pure helpers (phone normalisation, request building,
  response classification, retry accounting, price validation). No I/O, so the
  test harness can import and unit-test them.
- `index.ts` — the function itself: claim, charge, send, record, release.

SMS purchases continue to use the payment code **`BUY_SMS`** (Part 20). The
per-message price is **platform-only** (`SMS_UNIT_PRICE_UGX`); no school-facing
setting, form or policy can reach it. That is the financial-integrity rule from
Part 13/20 applied to SMS specifically.

## What the function does, and why each step is safe

1. **Authorise** — `x-dispatch-secret` compared in constant time against
   `SMS_DISPATCH_SECRET`; a missing secret on the platform side fails closed
   (401), so an unconfigured deployment cannot be driven by anyone. GET → 405.
2. **Refuse to guess a price** — `resolveUnitPrice` must return a positive
   integer, otherwise the function returns 503 and sends nothing. An empty
   `SMS_UNIT_PRICE_UGX` (a very likely misconfiguration) therefore cannot invent
   a price or send free SMS.
3. **Claim** — `update({status:'sending'}).eq('status','queued')`. Postgres
   re-checks the predicate under the row lock, so two concurrent workers can
   never claim the same row; the loser sees 0 rows and does nothing.
4. **Charge once** — `school.debit_sms_wallet(school_id, price, 'sms_<id>')`,
   the `service_role`-only RPC from migration 11. The reference is derived from
   the notification id, so a retry returns `duplicate` instead of charging
   twice. `insufficient_funds` fails the row without sending.
5. **Send** — `POST /api/messaging/send` with
   `Idempotency-Key: sms_<notificationId>` (the same value as the wallet
   reference) and NaJiki's own shape: `to`, `message`, `applicationCode`,
   optional `senderId`. Success is **HTTP 202**, not 200.
6. **Record** — `provider_ref` is set to NaJiki's `smsId` (never a locally
   generated id, or the delivery report could not match), plus `sent_at`,
   plus the raw `provider_response`.
7. **Release** — a `finally` block returns every row still in `sending` back to
   `queued`. Without it, a function killed at the platform's wall-clock limit
   would strand rows as `sending` forever and they would never be retried.

## Findings fixed in this round

| # | Finding | Impact | Fix |
| --- | --- | --- | --- |
| 21-1 | The retry branch read `row.attempt_count`, but no such column exists (migration 11 only adds `provider_ref`, `sent_at`, `provider_response`). | `attempt_count` was always `undefined`, so `MAX_ATTEMPTS` was dead code: a permanently failing row was retried forever, on every cron tick. | Counter is persisted in `provider_response` (`{reason, attempts, charged}`) via `readAttempts`/`nextAttempt`. |
| 21-2 | Retries ignored whether money had already been taken. | A charged SMS that NaJiki kept failing would be marked `failed` after 3 tries: the school paid, got no SMS, and nothing flagged it for refund. There is no automatic refund RPC, so this is silent financial loss. | Two caps: 3 attempts when nothing was charged, 10 when it was; terminal failures of charged rows are labelled `charged_undelivered:` so they are findable and refundable by hand. |
| 21-3 | The batch loop could outlive the platform timeout (25 rows × 12 s worst case = 300 s vs a 150 s limit), leaving claimed rows in `sending` forever. | Paid-for messages silently stuck; queue leak. | 45 s soft budget (`SMS_BATCH_BUDGET_MS`) plus the `finally` release above. |
| 21-4 | `Deno.serve(handler)` always bound port 8000. | Harmless in production (one instance per function), but it made multi-instance verification impossible. | `PORT`/`HOSTNAME` read from env, defaulting to 8000/0.0.0.0 exactly as before. |
| 21-5 | The Deno function was inside the Next.js TypeScript program. | `npm run build` failed on `npm:` imports and Deno globals — the app could not be built at all with the function present. | `supabase/functions` excluded from `tsconfig.json` and ESLint; the function is type-checked with `deno check` instead (0 errors). |

## How it was verified

`security/multi-tenant-lab/sms-edge-e2e-check.mjs` runs the **real function**:
it spawns `deno run --allow-net --allow-env supabase/functions/send-sms/index.ts`,
points it at the lab shim (Supabase REST + RPC + the fake NaJiki SMS API that
mirrors `najiki-finance2`), and asserts against Postgres, never against HTTP
status alone. **41/41 checks pass**, including:

- 401 without / with a wrong dispatch secret, 405 on GET, 503 when
  `SMS_UNIT_PRICE_UGX` is unset (and nothing sent or charged in that case);
- happy path: `queued` → charged exactly 30 UGX once → NaJiki 202 →
  `sent`, `provider_ref` equal to NaJiki's `smsId`, `sent_at` set,
  `Idempotency-Key` = wallet reference = `sms_<id>`; a second run sends
  nothing and charges nothing;
- an unfunded school: `failed`, zero messages to NaJiki, wallet still 0;
- 503 from the gateway: row stays `queued` with `attempts:1, charged:true`, the
  charge is not repeated, the counter increments, and at the charged cap the row
  fails as `charged_undelivered:` (not silently);
- 429: retryable, and charging during the attempt moves the row onto the
  charged cap;
- invalid phone and over-length message: `failed`, no charge, no gateway call;
- zero time budget: no row left in `sending`, unreached rows uncharged and
  delivered by the next run.

`sms-sender-contract-check.mjs` adds **46/46** checks against NaJiki's *own*
code (`SmsInputSchema`, `MAX_SMS_BODY_BYTES`, `verifyNotificationSignature`):
every body the sender builds is accepted by their schema, 202-with-`smsId` is
classified as success, 409 as permanent, 429/5xx as retryable, plus 7 unit
checks on the retry accounting.

**Negative controls** (to prove the tests can fail):

- reverting the 202 check to `status === 200` → **5 failures**, all on the
  accept path (every real success would have been treated as a failure);
- reverting the charged-row cap → **5 failures**, including
  `retry_exhausted: Upstream unavailable (after 3 attempts)` on a row the school
  had already paid for — exactly finding 21-2.

`deno check` reports 0 type errors. `npm run lint`, `npx tsc --noEmit` and
`npm run build` are green with the function in the tree.

## Full regression sweep after these changes

`full-branch-pentest` **27/27 SECURE**, `provider-contract-check` **30/30**,
`sms-sender-contract-check` **46/46**, `sms-edge-e2e-check` **41/41**,
`money-round13-attack` **0/24**, `payments-attack` **0/20**, `rogue-attack`
**0/21**, `round4-attack` **0/5**, `pay-rls-check` **0/8**,
`money-reconcile` **ALL MONEY CHECKS OK**, `flows-check` **ALL FLOWS OK**,
`round12` **35/35**, `round14` **40/40**, `round16` **18/18**,
`double-thumb-check` **11/11**. Zero regressions.

## Deploying it

```bash
supabase functions deploy send-sms --no-verify-jwt
supabase secrets set \
  NAJIKI_API_URL=https://<gateway>/api/messaging/send \
  NAJIKI_API_KEY=... \
  NAJIKI_APP_CODE=school \
  NAJIKI_SENDER_ID=SMARTSKOOLZ \
  SMS_UNIT_PRICE_UGX=30 \
  SMS_DISPATCH_SECRET=$(openssl rand -hex 32)
# then, on a schedule (pg_cron / Supabase Scheduler / QStash):
#   POST /functions/v1/send-sms   x-dispatch-secret: <SMS_DISPATCH_SECRET>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform.
The service-role key is mandatory: migration 06 revoked anon/authenticated
writes to `school.notifications` and to the wallet functions.

Before go-live the migrations must be applied in order (`05` → `14`), because
this function depends on `school.debit_sms_wallet` (11) and on the delivery
columns added there.

## Residual risk, stated plainly

- **`sending` rows and no `updated_at`.** The `finally` release covers normal
  exits and the time budget, but a hard kill (OOM, platform SIGKILL) can still
  strand a row. `school.notifications` has no `updated_at` to age rows by, so
  there is no safe reaper yet. Recommended follow-up: add `updated_at` in a
  future migration and requeue `sending` rows older than ~10 minutes.
- **NaJiki does not debit its own wallet** for SMS it sends (Part 6 note). Our
  charge is the only one, so `SMS_UNIT_PRICE_UGX` must be kept in step with what
  the gateway actually costs; it is not derived from the gateway.
- **Delivery-report matching** is identifier-based and deliberately generous
  (Part 20), so an unrelated `reference` collision could flip a status. It
  cannot move money, and `sent` rows are never downgraded by a `failed` report.

# Part 22: The deployed SMS function could not send a single SMS

## What happened

The function running in the database was not the one written in Part 21. It was
a separate implementation, written against a schema and an RPC that **do not
exist**. Every one of the following was verified directly against Postgres, not
guessed:

| # | The deployed code did | Reality | Effect |
| --- | --- | --- | --- |
| 22-1 | `.update({ retry_count, next_retry_at, error })` | `school.notifications` has none of those columns (`42703`) | The **first claim UPDATE raised**, so `dispatchOne` returned 500 and no SMS was ever sent. The sweep's `.lt("retry_count", 5)` failed the same way. |
| 22-2 | `rpc("debit_sms_wallet", { p_wallet_id, p_amount, p_idempotency_key, p_tenant_id, p_description })` | No `public.debit_sms_wallet` with that shape (`42883`). The audited one is `school.debit_sms_wallet(p_school_id, p_amount, p_reference, p_description)` (migration 11). | Even with 22-1 fixed, every send would fail at the charge and be recorded as `insufficient_balance_or_debit_failed`. |
| 22-3 | Posted to NaJiki with **no `Idempotency-Key`** | `/api/messaging/send` dedupes only on that header | Each of the 5 retries would create a **new** SMS: up to 5 duplicate messages per notification, billed to the platform. |
| 22-4 | Never set `provider_ref` | `SMS_DELIVERY_UPDATE` matches on `provider_ref` (or an id) | Delivery reports would match nothing; rows would stay `sent` forever with no delivery state. |
| 22-5 | Wrote `provider_response: JSON.stringify(data)` | The column is `jsonb` | jsonb stores that as a **string scalar** (`jsonb_typeof` = `string`), so the payload is unreadable as data. |
| 22-6 | `SMS_COST = Number(env || "1")` | SMS price is platform-only | A missing secret would silently sell SMS at **1 UGX** instead of refusing. |

Note the inconsistency that made 22-1/22-2 easy to miss: the deployed function
used status `pending`, while Part 21's version used `queued`. The app writes
`pending` (`app/mark-attendance/actions.ts:366`,
`app/manual-attendance/[classId]/actions.ts:700`,
`lib/devices/processor.ts:539`), so the deployed vocabulary was right and
Part 21's was wrong.

## The replacement

`supabase/functions/send-sms/index.ts` is now a **drop-in replacement**: it keeps
the deployed function's entire external interface, because the app and the cron
callers already depend on it —

- auth: `Authorization: Bearer <DISPATCH_SECRET>` (and `x-dispatch-secret`);
- payloads: `{ notification_id }`, `{ record: { id } }`, `{ new: { id } }`,
  `{ id }` and `{ retry_sweep: true }`;
- statuses: `pending` → `sending` → `sent` | `failed` | `pending` (retry);
- env: `DISPATCH_SECRET`, `NAJIKI_DOMAIN`, `NAJIKI_API_KEY`, `SMS_COST`,
  `NAJIKI_TIMEOUT_MS` — the names already set on the project, so a redeploy
  needs no secret changes. (`NAJIKI_APP_CODE`, `NAJIKI_SENDER_ID`,
  `NAJIKI_API_URL`/`NAJIKI_MESSAGING_URL`, `SMS_UNIT_PRICE_UGX` and
  `SMS_BATCH_BUDGET_MS` are honoured as optional extras.)

...while fixing all six findings:

- charges through `school.debit_sms_wallet(p_school_id, …)` and reads its
  `outcome` (`debited` / `duplicate` / `insufficient_funds` / `invalid_*`)
  instead of treating every error as "insufficient balance";
- retry bookkeeping lives in `provider_response` JSON (`attempts`, `charged`,
  `reason`, `claimed_at`) — no new columns, so it runs on today's schema;
- sends `Idempotency-Key: sms_<notificationId>`, the same value as the wallet
  reference: a retry can neither charge nor send twice;
- stores NaJiki's `smsId` in `provider_ref`, so delivery reports match;
- writes `provider_response` as an object;
- no price default: a missing/invalid `SMS_COST` returns 503 and sends nothing.

Retry policy is unchanged from Part 21 in spirit, and now also protects money:
3 attempts while nothing was charged, 10 once it was, and a row that still
cannot be delivered fails as `charged_undelivered:` so the charge is visible for
manual reconciliation. The `finally` block returns a still-claimed row to
`pending`, and the sweep reclaims `sending` rows whose
`provider_response.claimed_at` is older than 10 minutes — which also closes the
"sending rows with no `updated_at`" residual risk noted in Part 21.

## Verification

Three suites, all green:

- **`sms-edge-e2e-check.mjs` — 57/57.** Runs the real function under Deno
  against the lab shim and asserts on Postgres through the deployed interface:
  Bearer/`x-dispatch-secret` auth, 405, 503 with no price, `{notification_id}`
  and `{record:{id}}` payloads, charge-once, NaJiki 202, `provider_ref`,
  `provider_response` as an object, no `smsId` leak into their schema, 503 → row
  stays `pending` with `attempts`/`charged`, 429/409 handling, `charged_undelivered`
  at the charged cap, invalid phone/over-length/non-SMS rows never charged, the
  sweep reclaiming a stale claim while leaving a live one alone, a tiny budget
  stranding nothing, and `SMS_DELIVERY_UPDATE` matching the stored `provider_ref`.
- **`sms-schema-contract-check.mjs` — 49/49 (new).** Database + static
  contract, no Deno needed: the debit RPC exists with exactly that signature,
  the legacy 5-argument call still fails with `42883`, `retry_count` /
  `next_retry_at` / `error` / `attempt_count` do not exist, the function's
  *code* (comments excluded) uses none of them, the app and the function agree
  on `pending`, the deployed env names and payload shapes are preserved, the
  price has no numeric fallback, and `provider_ref` is written before `sent`.
- **`sms-sender-contract-check.mjs` — 56/56.** Now also covers
  `resolveEndpoint` (domain vs full URL, trailing slashes, bare host) and
  `isStaleClaim` (fresh vs 30-minute-old vs missing vs unparseable timestamps),
  against NaJiki's own `SmsInputSchema`.

**Negative controls:** appending `retry_count` / `next_retry_at` / `p_wallet_id`
to the function → the schema suite fails 3 checks; the Part 21 controls
(`status === 200`, charged-cap revert) still fail their suites.

Full sweep after these changes: pentest **27/27**, provider-contract **30/30**,
money-round13 **0/24**, payments-attack **0/20**, rogue **0/21**, round4
**0/5**, pay-rls **0/8**, money-reconcile **OK**, flows **OK**, round12
**35/35**, round14 **40/40**, round16 **18/18**. `tsc`, `lint`, `build` clean.

## Deploying the replacement

```bash
supabase functions deploy send-sms --no-verify-jwt
# no secret changes needed; set SMS_COST first if it is not already set:
supabase secrets set SMS_COST=30 DISPATCH_SECRET=$(openssl rand -hex 32)
```

Then, from a scheduler, either `POST /functions/v1/send-sms {"retry_sweep":true}`
every few minutes, or `{"notification_id":"<id>"}` as a database webhook.

## Residual risk

- The **existing queued rows** should be checked after the redeploy: rows left at
  `failed` by the old function (`error = 'insufficient_balance_or_debit_failed'`
  or `'provider_failed'`) were never sent, and if the old code ever did reach the
  debit step they were never charged either. Requeue deliberately, not in bulk.
- `provider_response` is the retry ledger, so anything that overwrites it
  wholesale resets the attempt count. No app code writes that column.
- `NAJIKI_DOMAIN` defaults to `https://api.najiki.com`; production should set it
  explicitly so a gateway move cannot silently reroute paid traffic.

# Part 23: Correction — aligning the repo to the live project

## What I got wrong in Parts 21 and 22

Parts 21 and 22 measured the **lab database built from this repo's migrations**
and reported the result as if it described production. It did not. The live
project, as reported by the owner, is different:

| Thing | Parts 21–22 assumed (repo migrations) | Live project |
| --- | --- | --- |
| `school.notifications` retry columns | `retry_count`, `next_retry_at`, `error` **do not exist** | they **do exist** |
| `provider_response` | `jsonb` | **`text`** |
| `provider_ref` | exists and is how delivery reports match | **no such column** |
| `status` default | none | **`pending`** |
| wallet debit | `school.debit_sms_wallet(p_school_id, …)` | **`public.debit_sms_wallet(p_wallet_id text, p_amount numeric, p_idempotency_key text, p_tenant_id text, p_description text)`** |
| deployed function | `send-sms` | **`send-attendance-sms`, v16, JWT verification ENABLED** |

So the `42703` / `42883` errors in Part 22 were real **in this repository's
schema**, and irrelevant to the live database. The honest reading is the
opposite of what I wrote: **the repo had drifted from production**, and the
deployed function was written against the live schema all along. The two
"bugs" that were really my misreading:

- writing `retry_count` / `next_retry_at` / `error` is correct on the live schema;
- `JSON.stringify(...)` into `provider_response` is correct because that column
  is `text` there, not `jsonb`.

What *did* hold up, on the live schema, is below — including two genuine defects
that only became visible once the lab was rebuilt to match production.

## What changed in the repository

1. **`supabase_migrations/15_align_sms_dispatch_schema.sql` (new).** Brings a
   fresh database up to the live shape: `retry_count int not null default 0`,
   `next_retry_at timestamptz`, `error text`, `status` default `'pending'`,
   `provider_response` converted to `text`, a partial index for the sweep, and
   **`public.debit_sms_wallet(text, numeric, text, text, text)`** with the
   deployed signature (idempotent on `p_idempotency_key`, tenant-checked,
   raises on insufficient funds, `service_role` only).

   > **Do not run migration 15 against production.** The live project already
   > has these objects; replacing its wallet function with my reconstruction
   > would be a change to production money code based on a signature alone. It
   > is for fresh installs and the lab. If the live function's body differs
   > (return shape, rounding, ledger rows), the live one wins.

2. **The function is now `supabase/functions/send-attendance-sms/`** — the
   deployed implementation, faithful to its column names, status values, RPC
   signature, request body (`{smsId, to, message}`), env names
   (`DISPATCH_SECRET`, `NAJIKI_DOMAIN`, `NAJIKI_API_KEY`, `SMS_COST`,
   `NAJIKI_TIMEOUT_MS`), payload shapes, return values and its 5-attempt cap.
   `send-sms/` and its helper module were deleted: that function was never
   deployed, so it was only ever a source of confusion.
3. **The lab now mirrors production**: the retry columns exist,
   `provider_response` is `text`, and the wallet RPC has the deployed signature.
   Every assertion below runs against that shape.

Three changes to the deployed code, all additive and all marked in the file:

| Change | Why |
| --- | --- |
| `Idempotency-Key: sms:<notificationId>` on the NaJiki call | Without it, each of the 5 retries creates a **second billable SMS**. With it, a retry is the same message and NaJiki deduplicates it. |
| Constant-time comparison of the dispatch secret | The deployed `!==` leaks the secret's length/prefix through timing. |
| A real MSISDN check before the wallet is touched | The deployed `toE164` only rejected **empty** numbers. `12345` became `+12345`, passed, and was **charged** before the gateway rejected it — five times. |

## What the rebuilt lab proved (deployed function, live-shaped schema)

`sms-edge-e2e-check.mjs` — **56/56**, driving the real Deno function against the
lab shim and asserting on Postgres:

- 401 without/with a wrong `Bearer` secret, 405 on GET, 400 without an id,
  503 when `SMS_COST` is unset (and nothing sent or charged), and an unknown
  notification id answered with `skipped` rather than a retry loop;
- happy path: `pending` → charged 30 UGX exactly once → NaJiki 202 → `sent`,
  `retry_count` stays 0, `next_retry_at` cleared, `error` null,
  `provider_response` parses as JSON text, `smsId` carries our notification id,
  `Idempotency-Key` is `sms:<id>`, and the posted body passes NaJiki's own
  `SmsInputSchema`; a second dispatch is a no-op with no second charge;
- `{record:{id}}` webhook payloads work;
- an unfunded school: `failed` after the cap, `error =
  insufficient_balance_or_debit_failed`, zero messages to NaJiki, wallet still 0;
- retries: a 503 leaves the row `pending` with `retry_count` incremented, a
  **future `next_retry_at` lock** (a second call inside the backoff is refused),
  the same `Idempotency-Key` on every attempt, at most one charge, and the 5th
  attempt terminal with the backoff cleared;
- an idempotency conflict (same key, different body) recorded as
  `provider_failed` without a second charge;
- invalid numbers failed **before** any charge, with no gateway call;
- the sweep sends only due rows, leaves backed-off rows and rows at the cap
  alone, never re-sends `sent` rows, and charges only what it sends;
- the app's delivery webhook still returns 200 and leaves a delivered row
  `sent` on this schema (where `provider_ref` does not exist).

`sms-schema-contract-check.mjs` — **39/39**, no Deno required: the RPC exists
with the deployed signature and correct ACLs, debits once per idempotency key,
raises on insufficient funds and on a wallet/tenant mismatch; the notification
columns have the deployed types and defaults; the repo's function is
`send-attendance-sms` and the old one is gone; the code writes the retry
columns, calls the 5-argument RPC, never touches `provider_ref`, stores JSON
text, charges before sending, dispatches only `pending`, and keeps the three
fixes above; the app queues `pending` and its webhook survives a schema with no
`provider_ref`.

`provider-contract-check.mjs` (**30/30**) and the full pentest/regression sweep
are unchanged and green.

## Deployment and reconciliation

```bash
supabase functions deploy send-attendance-sms     # JWT verification STAYS ON
supabase secrets set SMS_COST=... DISPATCH_SECRET=...
# optional: SMS_SWEEP_BUDGET_MS=45000 (default) bounds one sweep invocation
psql "$DATABASE_URL" -f supabase_migrations/16_refund_sms_charge.sql   # refunds
# and a scheduler is required — a URL and a body are not a schedule:
#   POST /functions/v1/send-attendance-sms   {"retry_sweep": true}
#   cron: */5 * * * *
```

About the rows already in the table: 76 pending / 7 sent, of which 63 pending
carry `error` and `provider_response` markers. Those markers do **not** prove
whether the provider accepted or billed a message, and `retry_count` alone does
not either. Do not bulk-requeue them: for a sample, check `public.sms_messages` /
`public.sms_delivery_reports` by `provider_message_id` against
`provider_response`, then requeue only rows with no provider record. Rows at
`retry_count >= 5` will never be picked up by the sweep regardless.

## Still unverified from here

- Whether the deployed revision is byte-identical to the source pasted by the
  owner (v16 is what is live; the repo now carries that source plus three
  documented additions).
- The live `public.debit_sms_wallet` body: only its signature is known. My
  migration 15 implementation matches that signature and the call contract; it
  is not a claim about the live body.
- Whether the 63 marked rows were ever charged. That needs the reconciliation
  above, against the gateway's own records.

# Part 24: Stress test — is the deployed sender actually solid?

The contract suite (Part 23) proves the happy path. This part attacks the
function: races, a wallet that cannot pay, a gateway that lies, content that can
never be delivered, and hostile payloads. `sms-edge-stress-check.mjs`, **32/32
after fixes** (6 failures before), driven against the real Deno function and
asserted on Postgres.

## What held up (no changes needed)

| Attack | Result |
| --- | --- |
| **Two workers dispatch the same notification at the same instant** | exactly one claimed it, one charge, one message at NaJiki, one `sent` |
| **Retry sweep racing a single dispatch on the same row** | one charge, one message |
| **10 parallel sends against a wallet that can only pay for 5** | exactly 5 sent, 5 not sent, balance ended at 0 and never negative, no row charged twice, total debits == total messages |
| **Slow gateway (function timeout 1 s, gateway 2.5 s)** | aborted at 1031 ms, row stayed `pending`, `retry_count` incremented, charged once |
| **Malformed JSON** | 400, no crash |
| **SQL-ish id (`' OR 1=1 --`)** | treated as an id, no query change |
| **5000-character id** | no 500 |
| **Delivery report replayed** | both accepted, row stayed `sent`, no second charge |

The claim race is the interesting one: the sender "locks" a row by writing a
future `next_retry_at` inside a single `UPDATE ... WHERE status='pending' AND
(next_retry_at IS NULL OR next_retry_at <= now())`. Postgres re-checks that
predicate under the row lock, so the loser's update matches zero rows. It is
atomic, and the concurrency test confirms it.

## What broke, and what was fixed

| # | Finding (all confirmed by a failing test first) | Fix |
| --- | --- | --- |
| 24-1 | A **200 with `success:false`** was recorded as `sent`: `res.ok` alone decided success, so a rejected message was silently lost. | Success now requires a 2xx, a payload that does not deny success, **and** an `smsId`. |
| 24-2 | A **202 with no `smsId`** was also recorded as `sent`, leaving nothing to match a delivery report against. | Retried as `provider_ack_without_id` (same `Idempotency-Key`, so no duplicate). |
| 24-3 | A **2000-character message was charged** and then failed five times at the gateway. The school paid for something that could never be delivered. | Rejected before the wallet is touched (`invalid_message_length`, NaJiki's 918-char ceiling). |
| 24-4 | An **empty message was charged** for the same reason. | Same guard (`length < 1`). |
| 24-5 | A school whose wallet is keyed by **`school_id` instead of `tenant_id`** could never send: the lookup only queried `tenant_id`, so every row died as `wallet_missing`. | Falls back to `school_id` when no tenant-keyed wallet exists. |
| 24-6 | A **non-string notification id** (`{"$ne": null}`) was coerced to `"[object Object]"`, producing a pointless 200. | Only strings and numbers are accepted; anything else is a 400. |

Each of 24-1…24-6 was red before the fix and green after, in the same suite.

## Regression after the fixes

`sms-edge-e2e-check` **56/56**, `sms-schema-contract-check` **43/43**
(now also asserts the message-length guard, the payload check, the `ackId`
requirement and the `school_id` wallet fallback), `provider-contract` **30/30**,
`full-branch-pentest` **27/27**, `money-round13` **0/24**, `payments-attack`
**0/20**, `rogue` **0/21**, `round4` **0/5**, `pay-rls` **0/8**,
`money-reconcile` **OK**, `flows-check` **OK**, `round12` **35/35**,
`round14` **40/40**, `round16` **18/18**. `deno check`, `tsc`, `lint`, `build`
clean.

## Still not solid — known, not fixed

- **No "charged but undelivered" marker.** After the 5th failure a charged row is
  `failed` with `error = 'provider_failed'`, indistinguishable from a row that
  was never charged. Reconcile with
  `SELECT ... FROM public.transactions WHERE reference = 'sms:' || n.id`, not by
  `error`. Adding a `charged_undelivered:` prefix would make it visible but
  changes the `error` vocabulary the dashboard may parse, so it is a decision for
  the owner, not a silent edit.
- **No refund path.** A message that is charged and then cannot be delivered
  leaves the school out of pocket until someone credits it by hand.
- **The sweep has no time budget.** It dispatches up to 50 rows sequentially,
  each with a 30 s gateway timeout: up to 25 minutes inside one invocation. Rows
  it never reaches simply keep their (expiring) 1-minute claim, so nothing is
  lost, but a platform timeout will kill the invocation mid-batch. A soft budget
  before starting a row would make this predictable.
- **Backoff is fixed at 3 minutes** and ignores NaJiki's `Retry-After`.
- **`next_retry_at` is both the lock and the schedule.** A send that takes longer
  than 60 s (only possible if `NAJIKI_TIMEOUT_MS` is raised above 60 s) would let
  a second worker claim the same row. With the default 30 s it cannot happen, but
  the two values are not linked in code.

# Part 25: Closing the five "still not solid" items (2026-10-24)

Part 24 ended with a list of known gaps. This part closes all five, and changes
one piece of vocabulary on purpose.

## 25-1 — Charged-but-undelivered is now visible in one column

A terminal failure that happened **after** a successful debit is written as

```
error = 'charged_undelivered:<reason>'      -- e.g. charged_undelivered:provider_failed
```

A terminal failure that never took money keeps the bare reason
(`invalid_message_length`, `insufficient_balance_or_debit_failed`,
`provider_rejected`, …). So

```sql
SELECT id, error FROM school.notifications
 WHERE error LIKE 'charged_undelivered:%' AND sent_at IS NULL;
```

is now the exact list of schools that paid for nothing. This is a deliberate
change to the `error` vocabulary: anything parsing `error = 'provider_failed'`
must accept the prefix. The suffix after the colon is the old value, so a
tolerant parser (`error LIKE '%provider_failed'`) keeps working.

The flag is **per row** (`chargedThisRow`, reset on every dispatch), not shared
across a sweep — a batch is not "charged" because an earlier row was. A late
success clears `error` to `null` while `provider_response` keeps the history.

## 25-2 — A refund path that cannot pay twice

`supabase_migrations/16_refund_sms_charge.sql` adds

```sql
SELECT public.refund_sms_charge('<notification uuid>');
-- { outcome: 'refunded' | 'duplicate' | 'no_charge', amount, balance, reference }
```

It **credits the wallet and writes a ledger row** with reference
`sms_refund:<id>`, so a second call returns `duplicate` instead of crediting
again. It refuses (`no_charge`) when `sms:<id>` was never debited. It is
`SECURITY DEFINER`, revoked from `anon`/`authenticated`, granted to
`service_role` only — a school cannot refund itself.

**Why manual, not automatic inside the sender.** A message can still be
delivered after our last attempt: the gateway may have accepted it and we lost
the response (that is exactly the `provider_timeout_or_fetch_error` case). An
automatic refund would then both deliver the SMS and return the money. So the
sender only *marks*; the refund is an explicit, idempotent act after checking
`public.sms_messages` / `public.sms_delivery_reports` for a provider record.

## 25-3 — The sweep has a wall-clock budget

`SMS_SWEEP_BUDGET_MS` (default **45 000**) is checked **before starting each
row**. When it is exhausted the loop stops, leaves the remaining rows `pending`
with their claim expiring, and returns

```json
{ "swept": 50, "dispatched": 12, "stopped_early": true }
```

The next run picks up the rest. Previously a 50-row sweep at 30 s each could run
for 25 minutes into a platform timeout.

## 25-4 — Backoff honours `Retry-After`

`parseRetryAfter()` accepts both forms in the RFC (`Retry-After: 120` seconds and
`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`), clamps to **3600 s**, and falls
back to `DEFAULT_BACKOFF_SEC = 180` when the header is absent or unusable. A 429
no longer waits 3 minutes for nothing.

## 25-5 — The claim lock is derived from the send timeout

```
sendTimeoutMs = NAJIKI_TIMEOUT_MS (default 30 000)
lockMs        = max(60 000, sendTimeoutMs + 15 000)
```

The lock can no longer expire while a send is still running, even if someone
raises `NAJIKI_TIMEOUT_MS` above 60 s. The timeout is read once and reused by the
`AbortController`, so the two values cannot drift.

## Test evidence

`sms-edge-stress-check.mjs` grew from 32 to **46 checks** (two new sections):

| Check | Before | After |
| --- | --- | --- |
| 11-1 a terminal failure after a charge is marked `charged_undelivered` | red | green |
| 11-2 an uncharged terminal failure carries **no** marker | — | green |
| 11-3 the refund credits exactly one price | red (`function does not exist`) | green |
| 11-4 refunding twice is refused (`duplicate`) and does not credit again | — | green |
| 11-5 refunding a never-charged row is a no-op (`no_charge`) | — | green |
| 12-1 `Retry-After: 2` produces a 2.0 s backoff, not 180 s | red | green |
| 12-2 a 1 ms budget stops the sweep before the first row | red | green |
| 12-3 the skipped rows stay `pending` for the next run | — | green |
| 12-4 the next sweep with a normal budget delivers all four | — | green |

One of those checks was **wrong when first written** and passed for the wrong
reason: it killed `procs[procs.length - 1]` *before* starting the budget-scoped
instance, so it restarted nothing and the 1 ms process kept serving. It now
keeps the handle returned by `startFn()` and asserts `stopped_early === false`
plus all four rows `sent` afterwards. A passing assertion that does not test what
it claims is worse than a failing one.

## Regression after the fixes

`sms-edge-stress` **46/46**, `sms-edge-e2e` **56/56**, `sms-schema-contract`
**61/61** (18 new static checks: the marker, the refund RPC and its grants, the
`Retry-After` parser, the lock/timeout link, the sweep budget and its older
alias), `provider-contract` **31/31**, `full-branch-pentest` **27/27**,
`money-round13` **0/24**, `payments-attack` **0/20**, `rogue` **0/21**,
`round4` **0/5**, `pay-rls` **0/8**, `money-reconcile` **OK**, `flows-check`
**OK**, `round12` **35/35**, `round14` **40/40**, `round16` **18/18**.
`deno fmt --check` + `deno check`, `tsc --noEmit`, `lint` (0 errors) and a clean
`rm -rf .next && npm run build` all pass.

Two process notes, because they cost time:

- **`.next` was stale at the start of this round.** `payments-attack` and
  `provider-contract` failed with `Failed to find Server Action` — the running
  server predated the build. Stopping the app, `rm -rf .next && npm run build`,
  restarting **with the lab env** and re-seeding fixed all of it. Rebuilding
  under a running app is the same trap as before.
- **`RLS` must be exported, not passed inline.** `RLS=1 node suite.mjs` leaves
  the child re-seed without it, so migrations 05–11 are skipped and the DB has
  no `school.payment_intents`; the suite then crashes on a missing table that
  looks like a regression. Use `export RLS=1` for the whole sweep.

## Still open (honest list)

- **The refund is manual.** Nothing runs `refund_sms_charge` on a schedule. Until
  someone does, `charged_undelivered:%` is a report, not a remedy. A cron that
  refunds rows older than N days *after* confirming no provider record would be
  the next step; it needs a human decision about the late-delivery window.
- **The marker describes our last attempt, not the final truth.** A refunded row
  can still be delivered by the gateway. That is why the refund is not automatic.
- **`error` vocabulary changed.** A dashboard that does an exact match on
  `provider_failed` will show blanks for charged rows until it is updated.
- **Migration 16 must be applied** before the refund is callable. The sender does
  not depend on it, so deploying the function first is safe.
