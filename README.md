# School Management

A multi-tenant school management app built with Next.js, React, and Supabase. The app includes attendance, guardian contacts, biometric-device integration, notification queueing, and wallet top-ups.

## Local development

**Prerequisites:** Node.js and a Supabase project (or a local Supabase stack).

1. Copy `.env.example` to `.env.local` and set valid Supabase values. The server-side service-role key must never use a `NEXT_PUBLIC_` prefix.
2. Install dependencies: `npm ci`
3. Start the app: `npm run dev`

The app requires `NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_URL`), `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `SUPABASE_ANON_KEY`), and `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_KEY`). Payment top-ups additionally require provider configuration; see [`.env.example`](./.env.example).

## Checks

```sh
npm test
npm run lint
npm run build
npm audit
```

`GET /api/health` is a non-cacheable readiness probe. It returns only `ok` or `unavailable` and does not expose tenant data.

## Production release

Before release, apply and validate the ordered SQL files in `supabase_migrations/`, run tenant-isolation integration tests against two test schools, and smoke-test deployed SMS and payment integrations. The SMS sender is managed outside this repository; wallet crediting requires the atomic `public.credit_wallet` RPC. Follow [`docs/production-release-checklist.md`](./docs/production-release-checklist.md) for migration, verification, and rollback gates.
