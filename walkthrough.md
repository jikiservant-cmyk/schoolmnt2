# SecureCoder Security Audit

**Status**: Completed
**Scanned Files**: 7
**Vulnerabilities Found**: 10
**Vulnerabilities Fixed**: 10

| Vulnerability ID | File | Line | Description | Severity | Status | Remediation |
|---|---|---|---|---|---|---|
| CS-BOLA-001 | app/manual-attendance/[classId]/actions.ts | 30 | BOLA in manual attendance allowed users to fetch/submit data for other tenant schools. | Critical | Fixed | Enforced cross-tenant verification by comparing the target `classId`'s `school_id` with `auth_school_id()`. |
| CS-AUTH-001 | app/iclock/getrequest/route.ts, app/iclock/devicecmd/route.ts | 40, 26 | Unauthenticated ZKTeco ADMS polling and command acknowledgement endpoints. | Critical | Fixed | Implemented `adapter.buildAuthCheck` to validate incoming requests with device secrets. |
| CS-AUTH-002 | lib/devices/metadata.ts | 16 | Fail-open biometric authentication logic bypassing secret checks if token was missing. | Critical | Fixed | Implemented fail-closed logic rejecting empty tokens and using `crypto.timingSafeEqual`. |
| CS-EXPOSURE-001 | app/dashboard/classes/page.tsx, app/dashboard/devices/page.tsx, app/dashboard/page.tsx | Multiple | Dashboard server queries missing tenant filters allowed cross-tenant data exposure. | High | Fixed | Refactored queries to enforce `school_id` filtering from `auth_school_id()` and eliminated plaintext secrets selection. |
| CS-AUTH-003 | app/dashboard/actions.ts | 14 | Unauthenticated Server Action `processPendingNotificationsAction` triggered SMS billing. | High | Fixed | Restrained function execution with `supabase.auth.getUser()` and filtered pending queries by tenant context. |
| CS-INJ-001 | utils/zkteco/formatter.ts, app/dashboard/devices/actions.ts | 48, 599 | Raw command strings vulnerable to ADMS injection via manipulated user input. | High | Fixed | Systematically sanitized display names and PIN IDs by stripping newline and equal characters. |
| CS-INJ-002 | app/iclock/getrequest/route.ts, app/iclock/devicecmd/route.ts, app/iclock/cdata/route.ts | Multiple | Unsanitized `SN` payload param flowed into `.ilike()` filter, exposing wildcard PostgREST vulnerability. | Medium | Fixed | Stripped `%` and `_` characters and migrated filters from `.ilike()` to strict `.eq()`. |
| CS-DOS-001 | app/manual-attendance/[classId]/actions.ts | 49 | Usage of `bcrypt.compareSync` blocked Node event loop under load. | Medium | Fixed | Replaced synchronous hash validation with async `bcrypt.compare`. |
| CS-RACE-001 | app/api/webhooks/najiki/handler.ts | 200 | Race condition in Wallet webhooks led to non-idempotent wallet credits. | Medium | Fixed | Enforced atomicity by checking existing constraints and executing transaction insertion before crediting wallets. |
| CS-INFO-001 | app/api/webhooks/najiki/handler.ts, app/iclock/devicecmd/route.ts | 65, 17 | `console.log` exposed PII data and internal command statuses. | Low | Fixed | Scrubbed logs of PII payload data fields and omitted the raw device payload contents. |
