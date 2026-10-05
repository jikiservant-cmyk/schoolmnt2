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
