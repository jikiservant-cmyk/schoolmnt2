# Security Policy

This app handles student records, attendance, guardian phone numbers and school
payments, so security reports are taken seriously — including reports about the
test labs and migrations in `security/` and `supabase_migrations/`.

## Reporting a vulnerability

**Please report privately. Do not open a public issue, and do not post details
in a public pull request.**

- Preferred: GitHub **private vulnerability reporting** —
  <https://github.com/jikiservant-cmyk/schoolmnt2/security/advisories/new>
  (Security tab → *Report a vulnerability*). This keeps the report, the fix and
  the credit in one private thread.
- Include, where you can: what you found, the endpoint or file involved, the
  steps to reproduce, the impact you think it has, and any proof-of-concept.
- Do not attach real student, guardian or payment data. Redact screenshots and
  sample payloads.

If private reporting is not available to you, open a minimal public issue that
says only *"I have a security report, please contact me"* — with no technical
detail — and a maintainer will move it to a private channel.

### What to expect

This is a small project with no on-call rotation, so these are best-effort:

| Stage | Target |
|---|---|
| First reply | 3 business days |
| Triage + severity call | 7 business days |
| Fix or documented mitigation | 30 days for high/critical, best effort otherwise |

We will tell you what we found, and we will credit you in the advisory and in
`SECURITY_AUDIT.md` if you want the credit. Please give us a chance to ship a
fix before disclosing publicly.

## Scope

In scope:

- Authentication, session handling, logout and the teacher-PIN flow.
- Tenant (school) isolation — reading or writing another school's data.
- The biometric device endpoints (`/iclock/*`), device secrets and the device
  command queue.
- Payments, SMS credit, the Najiki webhook and reconciliation.
- `supabase_migrations/*.sql` — RLS policies, `auth_school_id()` and the
  integrity triggers.
- The app's HTTP surface: `app/api/**`, `middleware.ts`, `lib/auth-guard.ts`,
  security headers in `next.config.ts`.

Out of scope / already known:

- Denial of service by volume, brute force at the network layer, or anything
  that needs unlimited requests — the rate limiter is per instance and is not
  backed by a shared store yet (see below).
- Reports that only say dependency versions are old. Prefer a concrete exploit
  path; routine updates are tracked by `.github/dependabot.yml`.
- The test-only Supabase URL and anon key from early commit `2fb2bd6` (already
  disclosed in `SECURITY_AUDIT.md`; the key is being rotated).
- The `ZKTECO_GLOBAL_SECRET_FALLBACK` transition path in the device adapters —
  a documented, intentional fallback so existing hardware keeps working. It is
  designed to be switched off; report it only if you can show it authenticating
  a device it should not, after the fallback is disabled.
- The multi-tenant lab's fake credentials in `security/multi-tenant-lab/env.sh`
  (`lab-service-key`, `lab-anon-key`). They only work against the local test
  shim.

## Rules for testing

- Only test against your own school/tenant, or against the local lab in
  `security/multi-tenant-lab/`. Never touch another school's live data.
- Never access, download or keep real student or guardian data. If you
  encounter it by accident, stop, delete what you have, and tell us in the
  report.
- No social engineering of school staff, no physical attacks, no spam or SMS
  flooding to real guardians via our provider.
- Good-faith research within these rules is welcome and will not be met with
  legal action from us. You are responsible for obeying your local law.

## Before you report, check the existing work

`SECURITY_AUDIT.md` records eleven rounds of audits and pentests (auth, tenant
isolation, RLS, devices, payments, SMS, reconciliation, launch checks), each
with before/after results, and the reproduction scripts live in `security/`.
If a finding is already listed there as fixed, please say which part you read
and why you think the fix does not hold — regressions are exactly what we want
to hear about.

## Deployment notes for maintainers

Security-relevant settings that live in the GitHub UI, not in this repository:

- Settings → Code security: enable **Dependabot alerts** and **Dependabot
  security updates**. The `.github/dependabot.yml` file only covers version
  updates.
- Settings → Code security: enable **Private vulnerability reporting** so the
  link above works.
- Settings → Code security: keep **Secret scanning** and **Push protection** on
  (default for public repos).
- Settings → Actions → General: set the default `GITHUB_TOKEN` permissions to
  *read repository contents* and to *not* allow actions to approve pull
  requests.
- Code scanning: the `.github/workflows/codeql.yml` workflow runs CodeQL on
  `main`, on pull requests and weekly. Do not also switch on *default setup*
  for the same language — GitHub allows one configuration per language.
- Branch protection on `main`: require a pull request and a passing status
  check before merging, and consider enabling *Require approval of the most
  recent push*.

The application-side checklist (migrations `02` → `09`, environment variables
such as `AUTH_COOKIE_SAMESITE`, `ALLOW_IFRAME_EMBED` and
`ZKTECO_GLOBAL_SECRET_FALLBACK`) is at the end of `SECURITY_AUDIT.md`.
