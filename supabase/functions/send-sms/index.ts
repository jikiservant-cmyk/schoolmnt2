/**
 * Supabase Edge Function: send-sms
 *
 * The ONLY component that spends money on SMS. The Next.js app only inserts
 * `pending` rows into `school.notifications`; this function does the rest.
 *
 * This is a corrected drop-in replacement for the previously deployed function.
 * It keeps that function's ENTIRE external interface, because the app and the
 * cron/webhook callers already depend on it:
 *
 *   payloads : { notification_id } | { record: { id } } | { new: { id } } |
 *              { id }  and  { retry_sweep: true }
 *   auth     : Authorization: Bearer <DISPATCH_SECRET>  (x-dispatch-secret too)
 *   status   : pending -> sending -> sent | failed | pending (retry)
 *   env      : DISPATCH_SECRET, NAJIKI_DOMAIN, NAJIKI_API_KEY, SMS_COST,
 *              NAJIKI_TIMEOUT_MS  (the names that are already set on the project)
 *
 * ...and fixes the defects that made the previous version unable to send:
 *
 *  1. It called `public.debit_sms_wallet(p_wallet_id, p_amount,
 *     p_idempotency_key, p_tenant_id, p_description)`. No such function exists:
 *     the audited one is `school.debit_sms_wallet(p_school_id, p_amount,
 *     p_reference, p_description)` (migration 11). Every SMS therefore failed
 *     with 42883 and was recorded as "insufficient_balance_or_debit_failed".
 *  2. It wrote `retry_count`, `next_retry_at` and `error`. Those columns do not
 *     exist on `school.notifications` (checked: 42703), so the very first claim
 *     UPDATE raised, the function returned 500, and nothing was ever sent.
 *     Retry bookkeeping now lives in the existing `provider_response` jsonb.
 *  3. It sent no `Idempotency-Key`, so each of the 5 retries created a NEW SMS
 *     at NaJiki. The key is now `sms_<notificationId>`, the same value as the
 *     wallet reference — a retry can neither charge nor send twice.
 *  4. It never set `provider_ref`, so `SMS_DELIVERY_UPDATE` could not match the
 *     row and deliveries were never recorded. It now stores NaJiki's `smsId`.
 *  5. It stored `JSON.stringify(response)` in a jsonb column, which jsonb
 *     stores as a *string* (`jsonb_typeof` = 'string'), not an object.
 *  6. `SMS_COST` defaulted to 1 UGX. Pricing is platform-only and must never be
 *     guessed: a missing/invalid price now refuses to send (503) instead.
 *
 * Deploy:
 *   supabase functions deploy send-sms --no-verify-jwt
 *   supabase secrets set DISPATCH_SECRET=... NAJIKI_API_KEY=... SMS_COST=...
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildSmsRequest,
  classifySendResponse,
  isStaleClaim,
  MAX_CHARGED_ATTEMPTS,
  MAX_SEND_ATTEMPTS,
  nextAttempt,
  readAttempts,
  resolveEndpoint,
  resolveUnitPrice,
} from "./sms-sender.ts";

const SCHOOL_SCHEMA = "school";
const NOTIFS_TABLE = "notifications";

/** Rows handled per invocation, so one call cannot outlive the platform limit. */
const MAX_BATCH = 25;
const DEFAULT_BUDGET_MS = 45_000;
/** A `sending` row older than this is presumed dead and may be reclaimed. */
const STALE_CLAIM_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
/** First non-empty value, so old and new secret names both keep working. */
const firstEnv = (...names: string[]) => {
  for (const n of names) {
    const v = env(n);
    if (v) return v;
  }
  return "";
};

function jsonResponse(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time string compare, so the secret cannot be guessed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function presentedSecret(req: Request): string {
  const header = req.headers.get("x-dispatch-secret");
  if (header) return header.trim();
  const auth = req.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : "";
}

/** Every shape the DB webhook / cron / manual callers have used. */
function extractNotificationId(body: any): string | null {
  const raw = body?.notification_id ??
    body?.record?.id ??
    body?.new?.id ??
    body?.record?.notification_id ??
    body?.new?.notification_id ??
    body?.id ??
    null;
  return raw === null || raw === undefined ? null : String(raw).trim() || null;
}

type Row = Record<string, any>;

const port = Number(env("PORT")) || 8000;
const hostname = env("HOSTNAME") || "0.0.0.0";

Deno.serve({ port, hostname }, async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Fail closed: a deployment with no secret rejects everyone.
  const secret = firstEnv("DISPATCH_SECRET", "SMS_DISPATCH_SECRET");
  if (!secret) {
    console.error(
      "[send-sms] DISPATCH_SECRET is not set; refusing to dispatch.",
    );
    return jsonResponse({ error: "Dispatch is not configured" }, 503);
  }
  if (!safeEqual(presentedSecret(req), secret)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Server configuration error" }, 500);
  }

  // Platform-only price. Never invent one (the old default of 1 UGX is gone).
  const unitPrice = resolveUnitPrice(
    firstEnv("SMS_COST", "SMS_UNIT_PRICE_UGX"),
  );
  if (unitPrice === null) {
    console.error(
      "[send-sms] SMS_COST / SMS_UNIT_PRICE_UGX is not a positive integer; refusing to send.",
    );
    return jsonResponse({ error: "SMS pricing is not configured" }, 503);
  }

  const apiKey = env("NAJIKI_API_KEY");
  if (!apiKey) {
    console.error("[send-sms] NAJIKI_API_KEY is not set; refusing to send.");
    return jsonResponse({ error: "SMS gateway is not configured" }, 503);
  }

  const endpoint = resolveEndpoint(
    env("NAJIKI_DOMAIN"),
    firstEnv("NAJIKI_API_URL", "NAJIKI_MESSAGING_URL"),
  );
  const applicationCode = firstEnv("NAJIKI_APP_CODE") || "school";
  const senderId = env("NAJIKI_SENDER_ID");
  const timeoutRaw = Number(env("NAJIKI_TIMEOUT_MS"));
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? timeoutRaw
    : DEFAULT_TIMEOUT_MS;
  const budgetRaw = Number(env("SMS_BATCH_BUDGET_MS"));
  const budgetMs = Number.isFinite(budgetRaw) && budgetRaw > 0
    ? budgetRaw
    : DEFAULT_BUDGET_MS;

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const school = db.schema(SCHOOL_SCHEMA);

  const ctx: Ctx = {
    school,
    unitPrice,
    endpoint,
    apiKey,
    applicationCode,
    senderId,
    timeoutMs,
  };

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (body?.retry_sweep) {
    return await runRetrySweep(ctx, budgetMs);
  }

  const notificationId = extractNotificationId(body);
  if (!notificationId) {
    return jsonResponse({ error: "missing notification id" }, 400);
  }

  try {
    return await dispatchOne(ctx, notificationId);
  } catch (err) {
    console.error("[send-sms] dispatch error:", err);
    return jsonResponse({ error: String(err) }, 500);
  }
});

type Ctx = {
  school: any;
  unitPrice: number;
  endpoint: string;
  apiKey: string;
  applicationCode: string;
  senderId: string;
  timeoutMs: number;
};

type DispatchResult = {
  status: number;
  body: Record<string, unknown>;
};

const ok = (body: Record<string, unknown>): DispatchResult => ({
  status: 200,
  body,
});
const skipped = (reason: string): DispatchResult => ({
  status: 200,
  body: { ok: true, skipped: true, reason },
});

/**
 * Dispatch exactly one notification.
 *
 * Claim -> charge -> send -> record, with the claim and the charge both
 * idempotent, so concurrent workers and retries cannot double-send or
 * double-charge. The `finally` puts the row back to `pending` if it is still
 * claimed when we leave, which is what stops rows getting stuck in `sending`.
 */
async function dispatchOne(
  ctx: Ctx,
  notificationId: string,
): Promise<Response> {
  const { school } = ctx;

  const { data: row, error: readErr } = await school
    .from(NOTIFS_TABLE)
    .select(
      "id, status, school_id, channel, message, recipient_phone_snapshot, provider_response",
    )
    .eq("id", notificationId)
    .maybeSingle();

  if (readErr) {
    console.error("[send-sms] could not read notification:", readErr.message);
    return jsonResponse({ error: "notification lookup failed" }, 500);
  }
  if (!row) return jsonResponse(skipped("notification not found").body);

  const current = row as Row;
  if (current.channel && String(current.channel) !== "sms") {
    return jsonResponse(skipped("not an sms notification").body);
  }
  if (String(current.status) !== "pending") {
    return jsonResponse(skipped("Status is not pending").body);
  }

  // Give up on rows that already used their budget instead of retrying forever.
  const prev = readAttempts(current.provider_response);
  const cap = prev.charged ? MAX_CHARGED_ATTEMPTS : MAX_SEND_ATTEMPTS;
  if (prev.attempts >= cap) {
    await finishFailed(
      school,
      notificationId,
      current.provider_response,
      prev.attempts,
      prev.charged,
      `${
        prev.charged ? "charged_undelivered" : "retry_exhausted"
      }: attempts already at ${prev.attempts}`,
    );
    return jsonResponse({ success: false, error: "retry budget exhausted" });
  }

  // ---- claim -------------------------------------------------------------
  // The `eq("status", "pending")` predicate is re-checked by Postgres under the
  // row lock, so exactly one caller can claim a row.
  const claimedAt = new Date().toISOString();
  const claimPayload = {
    ...(current.provider_response ?? {}),
    claimed_at: claimedAt,
  };
  const { data: claimed, error: claimErr } = await school
    .from(NOTIFS_TABLE)
    .update({ status: "sending", provider_response: claimPayload })
    .eq("id", notificationId)
    .eq("status", "pending")
    .select(
      "id, school_id, message, recipient_phone_snapshot, provider_response",
    )
    .maybeSingle();

  if (claimErr) {
    console.error("[send-sms] claim failed:", claimErr.message);
    return jsonResponse({ error: "claim failed" }, 500);
  }
  if (!claimed) return jsonResponse(skipped("not claimable").body);

  const notif = claimed as Row;
  let charged = prev.charged;
  let attempts = attemptCount(notif.provider_response);

  try {
    let request: ReturnType<typeof buildSmsRequest>;
    try {
      request = buildSmsRequest({
        notificationId,
        message: String(notif.message ?? ""),
        recipient: String(notif.recipient_phone_snapshot ?? ""),
        applicationCode: ctx.applicationCode,
        senderId: ctx.senderId,
      });
    } catch (e) {
      // Bad number or over-length body: retrying cannot fix it, so no charge.
      await finishFailed(
        school,
        notificationId,
        notif.provider_response,
        attempts,
        charged,
        `invalid_notification: ${(e as Error).message}`,
      );
      return jsonResponse({ success: false, error: "invalid notification" });
    }

    // ---- charge (idempotent on the reference) ----------------------------
    const { data: debit, error: debitErr } = await school.rpc(
      "debit_sms_wallet",
      {
        p_school_id: notif.school_id,
        p_amount: ctx.unitPrice,
        p_reference: request.walletReference,
        p_description: "SMS Notification Charge",
      },
    );

    if (debitErr) {
      console.error("[send-sms] wallet RPC failed:", debitErr.message);
      return await retryOrFail(
        school,
        notificationId,
        notif.provider_response,
        attempts,
        charged,
        "wallet_unavailable",
        null,
      );
    }

    const outcome = String((debit as Row | null)?.outcome ?? "unknown");
    if (
      outcome === "insufficient_funds" || outcome === "invalid_amount" ||
      outcome === "invalid_request"
    ) {
      // No money, no message — and no retry storm.
      await finishFailed(
        school,
        notificationId,
        notif.provider_response,
        attempts,
        charged,
        `wallet_${outcome}`,
      );
      return jsonResponse({ success: false, error: outcome });
    }
    if (outcome !== "debited" && outcome !== "duplicate") {
      return await retryOrFail(
        school,
        notificationId,
        notif.provider_response,
        attempts,
        charged,
        `wallet_${outcome}`,
        null,
      );
    }
    // 'duplicate' = an earlier attempt already charged this row. The send below
    // is still safe because NaJiki deduplicates on the same Idempotency-Key.
    charged = true;

    // ---- send ------------------------------------------------------------
    let httpStatus = 0;
    let payload: Record<string, unknown> | null = null;
    let retryAfter: string | null = null;
    try {
      const res = await fetch(ctx.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${ctx.apiKey}`,
          "x-api-key": ctx.apiKey,
          "Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(ctx.timeoutMs),
      });
      httpStatus = res.status;
      retryAfter = res.headers.get("retry-after");
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
    } catch (e) {
      console.warn("[send-sms] gateway unreachable:", (e as Error).message);
      return await retryOrFail(
        school,
        notificationId,
        notif.provider_response,
        attempts,
        charged,
        "gateway_unreachable",
        null,
      );
    }

    const result = classifySendResponse(httpStatus, payload, retryAfter);

    if (result.outcome === "accepted") {
      const response = {
        ...(notif.provider_response ?? {}),
        attempts,
        charged: true,
        smsId: result.providerRef,
        reference: result.reference,
        deduplicated: result.deduplicated,
        httpStatus,
        claimed_at: null,
      };
      const { error: recErr } = await school
        .from(NOTIFS_TABLE)
        .update({
          status: "sent",
          provider_ref: result.providerRef,
          sent_at: new Date().toISOString(),
          provider_response: response,
        })
        .eq("id", notificationId);
      if (recErr) {
        console.error(
          "[send-sms] could not record acceptance:",
          recErr.message,
        );
        return jsonResponse({
          success: false,
          error: "could not record acceptance",
        }, 500);
      }
      return jsonResponse({
        success: true,
        smsId: result.providerRef,
        deduplicated: result.deduplicated,
      });
    }

    if (result.outcome === "retry") {
      return await retryOrFail(
        school,
        notificationId,
        notif.provider_response,
        attempts,
        charged,
        result.reason,
        httpStatus,
      );
    }

    await finishFailed(
      school,
      notificationId,
      notif.provider_response,
      attempts,
      charged,
      `${
        charged ? "charged_undelivered" : "provider_rejected"
      }: ${result.reason}`,
    );
    return jsonResponse({ success: false, error: result.reason });
  } finally {
    // If anything above left the row claimed, hand it back to the queue.
    await releaseIfClaimed(school, notificationId);
  }
}

function attemptCount(providerResponse: unknown): number {
  const prev = readAttempts(providerResponse);
  return prev.attempts + 1;
}

async function retryOrFail(
  school: any,
  notificationId: string,
  baseResponse: unknown,
  attempts: number,
  charged: boolean,
  reason: string,
  httpStatus: number | null,
): Promise<Response> {
  // The cap depends on whether money has moved: an uncharged row may be dropped
  // after MAX_SEND_ATTEMPTS, but a charged one keeps trying (and, if it still
  // cannot be delivered, fails with a reason that an operator can reconcile).
  const maxAttempts = charged ? MAX_CHARGED_ATTEMPTS : MAX_SEND_ATTEMPTS;
  if (attempts >= maxAttempts) {
    await finishFailed(
      school,
      notificationId,
      baseResponse,
      attempts,
      charged,
      `${
        charged ? "charged_undelivered" : "retry_exhausted"
      }: ${reason} (after ${attempts} attempts)`,
    );
    return jsonResponse({ success: false, error: reason, attempts });
  }

  const response = {
    ...(baseResponse ?? {}),
    attempts,
    charged,
    reason,
    httpStatus,
    claimed_at: null,
  };
  const { error } = await school
    .from(NOTIFS_TABLE)
    .update({ status: "pending", provider_response: response })
    .eq("id", notificationId);

  if (error) console.error("[send-sms] could not requeue:", error.message);
  return jsonResponse({ success: false, retry: true, error: reason, attempts });
}

async function finishFailed(
  school: any,
  notificationId: string,
  baseResponse: unknown,
  attempts: number,
  charged: boolean,
  reason: string,
): Promise<void> {
  const response = {
    ...(baseResponse ?? {}),
    attempts,
    charged,
    reason: reason.slice(0, 300),
    claimed_at: null,
  };
  const { error } = await school
    .from(NOTIFS_TABLE)
    .update({ status: "failed", provider_response: response })
    .eq("id", notificationId);
  if (error) {
    console.error("[send-sms] could not record failure:", error.message);
  }
}

async function releaseIfClaimed(
  school: any,
  notificationId: string,
): Promise<void> {
  const { error } = await school
    .from(NOTIFS_TABLE)
    .update({ status: "pending" })
    .eq("id", notificationId)
    .eq("status", "sending");
  if (error) {
    console.error("[send-sms] could not release claim:", error.message);
  }
}

/**
 * Retry sweep for a cron scheduler.
 *
 * Also reclaims rows stuck in `sending` (a killed invocation), which is why the
 * `provider_response.claimed_at` timestamp is written at claim time: without it
 * a crashed run would hide its rows forever.
 */
async function runRetrySweep(ctx: Ctx, budgetMs: number): Promise<Response> {
  const { school } = ctx;
  const now = Date.now();

  const { data: rows, error } = await school
    .from(NOTIFS_TABLE)
    .select("id, status, provider_response")
    .in("status", ["pending", "sending"])
    .is("provider_ref", null)
    .order("created_at", { ascending: true })
    .limit(MAX_BATCH * 2);

  if (error) {
    console.error("[send-sms] sweep read failed:", error.message);
    return jsonResponse({ error: error.message }, 500);
  }

  const startedAt = Date.now();
  let dispatched = 0;
  let sent = 0;
  let failed = 0;
  let released = 0;
  let skippedCount = 0;

  for (const r of (rows ?? []) as Row[]) {
    if (dispatched >= MAX_BATCH) break;
    if (Date.now() - startedAt > budgetMs) {
      console.warn(
        "[send-sms] out of time, leaving the rest for the next sweep",
      );
      break;
    }

    if (String(r.status) === "sending") {
      if (!isStaleClaim(r.provider_response, now, STALE_CLAIM_MS)) {
        skippedCount++;
        continue; // another worker owns it right now
      }
      // The owner died: put it back in the queue, then treat it as pending.
      const { data: reclaimed } = await school
        .from(NOTIFS_TABLE)
        .update({ status: "pending" })
        .eq("id", r.id)
        .eq("status", "sending")
        .select("id")
        .maybeSingle();
      if (!reclaimed) {
        skippedCount++;
        continue;
      }
      released++;
    }

    dispatched++;
    const res = await dispatchOne(ctx, String(r.id));
    const body = await res.json().catch(() => ({}));
    const status = Number(res.status);
    if (body?.success === true) sent++;
    else if (body?.skipped === true) skippedCount++;
    else if (status >= 500) failed++;
    else if (body?.retry === true) skippedCount++;
    else failed++;
  }

  console.log(
    `[send-sms] sweep dispatched=${dispatched} sent=${sent} failed=${failed} released=${released} skipped=${skippedCount}`,
  );
  return jsonResponse({
    swept: (rows ?? []).length,
    dispatched,
    sent,
    failed,
    released,
    skipped: skippedCount,
  });
}
