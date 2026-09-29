# SmartSkoolz Attendance

SmartSkoolz is a multi-tenant school attendance portal. School administrators manage classes, students, staff, biometric terminals, attendance reports, and SMS wallet top-ups; attendance can be entered manually or received from ZKTeco ADMS and supported vendor webhooks.

## Stack

- Next.js App Router 16, React 19, TypeScript
- Supabase Auth and Postgres (`school` schema for application data)
- Server Actions and API routes for application/device integrations
- Tailwind CSS, bcryptjs, and vendor-specific device adapters

The application is configured for a standalone Next.js deployment. The expected traffic profile and deployment infrastructure are environment-specific and must be set by the operator.

## Requirements

- Node.js 20.9 or newer (Node 22 is recommended)
- npm 10 or newer
- A Supabase project with the application schema, RLS policies, auth configuration, and required RPCs
- A configured NaJiki payment/SMS integration if wallet top-ups are enabled

## Local setup

```bash
npm ci
cp .env.example .env.local
# Fill in every required value in .env.local.
npm run lint
npm test
npm run build
npm run dev
```

The local server listens on `http://localhost:3000`.

`npm ci` is intentional: it verifies that `package.json` and the committed lockfile remain reproducible. Do not use a hand-edited or stale lockfile in deployment.

## Environment variables

See [`.env.example`](.env.example). The following are required for the corresponding features:

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Browser/server Auth client key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes for server/admin paths | Server-only service-role key; never expose it to the browser |
| `ZKTECO_DEVICE_SECRET` | Only for legacy devices | Global fallback secret; per-device hashed secrets are preferred |
| `NAJIKI_API_URL` or `NAJIKI_DOMAIN` | For top-ups | Payment provider endpoint |
| `NAJIKI_API_KEY` | For top-ups and callbacks | NaJiki credential/webhook secret |
| `NAJIKI_APP_CODE` | For top-ups | Application code, normally `school` |
| `NAJIKI_MAX_TOPUP_UGX` | Optional | Maximum accepted top-up amount; defaults to `100000000` |
| `APP_URL` | Optional | Public application URL for infrastructure/integrations |

The app deliberately fails closed if Supabase configuration is missing. Do not use placeholder keys or the anon key as `SUPABASE_SERVICE_ROLE_KEY`.

## Database migrations

The repository does not contain a full baseline schema. The Supabase project must already contain the tables, RLS policies, functions, and relationships used by the application. Apply the repository migrations in order when upgrading an existing schema:

1. [`supabase_migrations/01_add_multi_vendor_device_columns.sql`](supabase_migrations/01_add_multi_vendor_device_columns.sql) adds device protocol, credential, location, and configuration columns.
2. [`supabase_migrations/02_production_safety_indexes.sql`](supabase_migrations/02_production_safety_indexes.sql) adds payment idempotency and attendance/device lookup indexes.

Before applying migration 02, reconcile any existing duplicate transaction references or device attendance events. The unique indexes intentionally fail rather than deleting or rewriting records. Device ingestion ignores exact duplicate attendance conflicts and avoids sending a second parent SMS for a mixed duplicate batch.

The payment webhook requires a database-side `credit_wallet` RPC that atomically inserts the transaction and updates the wallet. If that RPC is unavailable, callbacks return `503` and do not perform an unsafe read-then-write fallback.

## Routes and integrations

- `/dashboard` — administrator portal (authenticated and role-checked)
- `/api/health` — unauthenticated readiness probe; returns `200` only when the Supabase database check succeeds, otherwise `503`
- `/api/devices/push` — authenticated universal vendor push endpoint
- `/iclock/cdata` — authenticated ZKTeco ADMS handshake and attendance ingestion
- `/iclock/getrequest` — authenticated ZKTeco command polling
- `/iclock/devicecmd` — authenticated ZKTeco command acknowledgements
- `/api/webhooks/najiki` and `/api/internal/payment-completed` — HMAC/bearer-authenticated NaJiki callbacks

Device and webhook payloads are bounded. Put additional rate limiting and IP allowlisting at the load balancer/API gateway where possible, especially for publicly reachable device endpoints.

## Production deployment

1. Provision a server/runtime compatible with Node 20.9+.
2. Configure production environment variables through the platform secret manager, not a committed `.env` file.
3. Apply and verify Supabase migrations and RLS policies. Confirm `credit_wallet` is atomic and protected by the transaction-reference unique index.
4. Run `npm ci --omit=dev` in the runtime image or build stage, then `npm run build`.
5. Start the standalone app with `npm run start` (or the platform's equivalent). Bind the platform process to `0.0.0.0` and set the desired `PORT`.
6. Configure TLS, gateway rate limits, device network restrictions, log retention, backups, and alerting.
7. Configure the load balancer readiness check as `GET /api/health`. Do not use a successful TCP connection alone as readiness.

Back up Supabase according to the provider's point-in-time recovery/backup plan and periodically test restoring a copy. Attendance and payment records should be retained according to the school's legal and operational requirements.

## Verification commands

```bash
npm ci
npm run lint
npm test
npm run build
npm start
curl -i http://localhost:3000/api/health
```

There is no production database or device integration in this repository, so end-to-end verification also requires a staging Supabase project, a test NaJiki callback, and a test terminal with non-production credentials.
