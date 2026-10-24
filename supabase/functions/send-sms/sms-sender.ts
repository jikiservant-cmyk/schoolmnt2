/**
 * Pure helpers for the SMS Edge Function.
 *
 * Nothing here touches Deno, Node, the network or a database, so the exact
 * request body this function sends can be validated against NaJiki's REAL
 * `SmsInputSchema` by `security/multi-tenant-lab/sms-sender-contract-check.mjs`.
 *
 * The edge function is the only thing that SPENDS money on SMS: it claims a
 * queued `school.notifications` row, debits the school wallet atomically, and
 * hands the message to NaJiki. Everything that decides "did NaJiki accept it,
 * and what do we store so the delivery report can find the row again" lives
 * here, so those rules are testable without a live function.
 */

/** NaJiki's hard ceiling for one message: 6 segments, 918 characters. */
export const MAX_SMS_CHARS = 918;

/** NaJiki's `SmsInputSchema.to` pattern. */
const MSISDN_RE = /^\+?[0-9]{9,15}$/;

/**
 * Normalise a phone number to what NaJiki's schema accepts.
 * Keeps a leading `+` when present, drops spaces/dashes/parentheses, and
 * rewrites the Ugandan local form (`0772...` -> `256772...`) the same way the
 * rest of this codebase does.
 */
export function normalizeMsisdn(raw: string | null | undefined): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/[\s\-().]/g, "");
  const hadPlus = s.startsWith("+");
  if (hadPlus) s = s.slice(1);
  if (s.startsWith("00")) s = s.slice(2);
  if (s.startsWith("0")) s = "256" + s.slice(1);
  else if (s.length === 9 && s.startsWith("7")) s = "256" + s;
  if (!/^[0-9]{9,15}$/.test(s)) return "";
  return hadPlus || raw?.trim().startsWith("+") ? "+" + s : s;
}

/** True when a message fits NaJiki's schema (1..918 chars); empty is invalid. */
export function fitsProviderLimits(
  message: string | null | undefined,
): boolean {
  const m = String(message ?? "");
  return m.length >= 1 && m.length <= MAX_SMS_CHARS;
}

/**
 * One stable key per notification row, used for BOTH:
 *  - the wallet debit reference (`school.debit_sms_wallet` is idempotent on it)
 *  - NaJiki's `Idempotency-Key`
 *
 * The same SMS can therefore never be paid for twice or sent twice, however
 * many times the function is retried or however many workers run at once.
 */
export function idempotencyKeyFor(notificationId: string): string {
  return `sms_${String(notificationId).trim()}`;
}

/**
 * The body posted to `POST /api/messaging/send`.
 *
 * Only fields NaJiki documents are sent: `applicationCode` is optional there,
 * and `senderId` is validated as `^[A-Za-z0-9]{3,11}$` — an invalid sender is
 * dropped rather than allowed to 400 the whole batch.
 */
export function buildSmsRequest(input: {
  notificationId: string;
  message: string;
  recipient: string;
  applicationCode?: string | null;
  senderId?: string | null;
}): {
  body: Record<string, string>;
  idempotencyKey: string;
  walletReference: string;
} {
  const to = normalizeMsisdn(input.recipient);
  if (!to) throw new Error("invalid_recipient");
  const message = String(input.message ?? "");
  if (!fitsProviderLimits(message)) throw new Error("invalid_message");

  const idempotencyKey = idempotencyKeyFor(input.notificationId);

  const body: Record<string, string> = { to, message };
  const appCode = String(input.applicationCode ?? "").trim();
  if (appCode) body.applicationCode = appCode.slice(0, 64);

  const sender = String(input.senderId ?? "").trim();
  if (/^[A-Za-z0-9]{3,11}$/.test(sender)) body.senderId = sender;

  return { body, idempotencyKey, walletReference: idempotencyKey };
}

export type SendOutcome =
  | {
    outcome: "accepted";
    providerRef: string;
    reference: string | null;
    deduplicated: boolean;
  }
  | { outcome: "retry"; reason: string; retryAfterSeconds: number | null }
  | { outcome: "permanent_failure"; reason: string };

/** NaJiki's `smsId`/`reference` are what the delivery report echoes back. */
function readProviderRef(
  json: Record<string, unknown> | null | undefined,
): string {
  const raw = json?.smsId ?? json?.id ?? json?.reference;
  return typeof raw === "string" || typeof raw === "number"
    ? String(raw).trim().slice(0, 200)
    : "";
}

/**
 * Map NaJiki's response to what the sender must do next.
 *
 * `POST /api/messaging/send` answers **202** (accepted and queued), not 200, so
 * a naive `status === 200` check would treat every successful send as a
 * failure. 409 is their idempotency conflict (same key, different payload) and
 * is permanent; 429 and 5xx are retryable.
 */
export function classifySendResponse(
  httpStatus: number,
  json: Record<string, unknown> | null | undefined,
  retryAfterHeader?: string | null,
): SendOutcome {
  const providerRef = readProviderRef(json);
  const reference = typeof json?.reference === "string" ? json.reference : null;

  if (httpStatus === 202 || (httpStatus === 200 && json?.success === true)) {
    if (!providerRef) {
      return {
        outcome: "retry",
        reason: "accepted without smsId",
        retryAfterSeconds: null,
      };
    }
    return {
      outcome: "accepted",
      providerRef,
      reference,
      deduplicated: json?.deduplicated === true,
    };
  }

  const message = typeof json?.error === "string" && json.error
    ? json.error
    : `HTTP ${httpStatus}`;

  if (httpStatus === 409) {
    return {
      outcome: "permanent_failure",
      reason: `idempotency_conflict: ${message}`,
    };
  }

  if (
    httpStatus === 429 || httpStatus === 408 || httpStatus === 425 ||
    httpStatus >= 500
  ) {
    const parsed = Number(retryAfterHeader);
    return {
      outcome: "retry",
      reason: message,
      retryAfterSeconds: Number.isFinite(parsed) && parsed > 0
        ? Math.ceil(parsed)
        : null,
    };
  }

  // 400 / 401 / 403 / 404 / 413: retrying the identical request cannot help.
  return { outcome: "permanent_failure", reason: message };
}

/**
 * The wallet charge is server-priced: schools can never set it. When the price
 * is missing we must NOT invent one — refuse to send instead.
 */
export function resolveUnitPrice(
  raw: string | null | undefined,
): number | null {
  const n = Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Retry accounting.
 *
 * `school.notifications` has no `attempt_count` column (migration 11 only adds
 * `provider_ref`, `sent_at`, `provider_response`), so the counter lives inside
 * `provider_response` jsonb — which we already write and which survives between
 * invocations. Without it `MAX_ATTEMPTS` is dead code and a permanently failing
 * row is retried forever.
 *
 * Two caps, because the two cases are NOT symmetric:
 *   - nothing charged yet -> give up after MAX_SEND_ATTEMPTS (nothing to lose)
 *   - money already taken -> keep trying up to MAX_CHARGED_ATTEMPTS and, if it
 *     still cannot be delivered, fail with a `charged_undelivered:` reason so
 *     the row is visible for manual reconciliation instead of silently
 *     swallowing the school's money (there is no automatic refund RPC).
 */
export const MAX_SEND_ATTEMPTS = 3;
export const MAX_CHARGED_ATTEMPTS = 10;

export function readAttempts(
  providerResponse: unknown,
): { attempts: number; charged: boolean } {
  if (!providerResponse || typeof providerResponse !== "object") {
    return { attempts: 0, charged: false };
  }
  const o = providerResponse as Record<string, unknown>;
  const raw = o.attempts;
  const n = typeof raw === "number" ? raw : Number(raw);
  return {
    attempts: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
    charged: o.charged === true,
  };
}

export function nextAttempt(
  providerResponse: unknown,
  chargedThisAttempt: boolean = false,
): {
  attempts: number;
  maxAttempts: number;
  charged: boolean;
  exhausted: boolean;
} {
  const prev = readAttempts(providerResponse);
  const charged = prev.charged || chargedThisAttempt === true;
  const attempts = prev.attempts + 1;
  const maxAttempts = charged ? MAX_CHARGED_ATTEMPTS : MAX_SEND_ATTEMPTS;
  return { attempts, maxAttempts, charged, exhausted: attempts >= maxAttempts };
}
