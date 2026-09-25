# Production release checklist

This repository builds a Next.js standalone app and includes SQL migration files, but it does not contain a hosting-provider workflow, Supabase project configuration, or the source for the separately deployed SMS sender. Complete and record these checks in the target environment; a passing local build is not proof of production readiness.

## Required runtime configuration

Configure secrets in the hosting provider, not in Git:

- `NEXT_PUBLIC_SUPABASE_URL` (or the supported server-side alias `SUPABASE_URL`)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `SUPABASE_ANON_KEY`)
- `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_KEY`); server-only
- `NAJIKI_API_KEY` for payment initiation and webhook authentication
- `NAJIKI_API_URL` or `NAJIKI_DOMAIN` for the intended payment provider endpoint
- `NAJIKI_APP_CODE` if required by the provider

The app now fails closed when public Supabase settings are absent or invalid. The readiness probe is `GET /api/health`; it reports only `ok`/`unavailable` and never returns database rows or provider errors. Configure an external uptime check and alert on non-200 responses.

## Database migration and rollback

1. Take and verify a restorable database backup before schema changes.
2. Apply `supabase_migrations/01_add_multi_vendor_device_columns.sql`, `02_tenant_isolation_and_device_secrets.sql`, `03_idempotent_attendance_and_device_pins.sql`, and `04_restrict_public_admin_tables.sql` in staging, in order.
3. Migration 03 deliberately aborts if it finds duplicate school PINs, normalized `person_credentials` identifiers (when that optional table exists), or duplicate related notification rows. Review and reconcile those records rather than bypassing the checks.
4. Verify RLS is enabled and the intended policies exist for every exposed table in both `school` and `public`. Migration 04 denies direct `anon`/`authenticated` access to the app's public admin tables; confirm any external consumer that needs public access has its own reviewed, tenant-scoped policy before applying it.
5. Run `npm run test:tenant-integration` with a dedicated test project and two separate school accounts. Verify reads and writes are denied across tenants.
6. Apply the same migration sequence to production only after the staging test passes. Keep `03_idempotent_attendance_and_device_pins.down.sql` as a rollback aid; it removes the new unique indexes but intentionally preserves attendance idempotency keys. Restore the backup if a schema or data rollback is required.

## External integrations that require a production smoke test

- Enforce HTTPS at the hosting proxy, retain the app's HSTS header, and configure provider/platform rate limits for login/signup, webhook, and device-ingestion endpoints. The repository does not provide a durable distributed rate limiter.
- **SMS:** verify that the deployed sender consumes `school.notifications`, records its provider reference there, and that a signed NaJiki delivery callback updates the same row. Send one test attendance notification and verify delivered/failed status. `processPendingNotificationsAction` is intentionally not a sender.
- **Payments:** verify that `public.credit_wallet(p_school_id, p_amount, p_tx_ref)` updates the wallet and inserts the transaction atomically, with a unique transaction reference. Verify that the provider honors the submitted idempotency key when the same top-up request is retried. The webhook returns a retryable error if this RPC is missing or fails; it does not use a non-atomic REST fallback.
- **Devices:** test an authenticated device handshake, an attendance push within the 2 MiB/1,000-event limits, an oversized request (413), and a replay. Apply migration 03 before deploying code that uses attendance idempotency keys.

## Application verification

Run before deployment:

```sh
npm ci
npm test
npm run lint
npm run build
npm audit
```

Run a staging smoke test for admin login, school-to-school isolation, student/guardian creation, manual and device attendance, device command queueing, notification delivery, payment top-up, and logout. Record the release commit, migration state, backup reference, health-check URL, integration owners, and rollback decision-maker.
