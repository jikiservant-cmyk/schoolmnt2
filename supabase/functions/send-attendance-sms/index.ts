/**
 * Supabase Edge Function: send-attendance-sms  (deployed name, v16)
 *
 * This is the sender that actually runs in production. The repository used to
 * carry a different, never-deployed function (`send-sms`) that was written
 * against a schema this project does not have. This file is the deployed
 * implementation, kept faithful to what runs there:
 *
 *   school.notifications : retry_count, next_retry_at, error,
 *                          status default 'pending', provider_response (text)
 *   wallet RPC           : public.debit_sms_wallet(p_wallet_id text,
 *                            p_amount numeric, p_idempotency_key text,
 *                            p_tenant_id text, p_description text)
 *   env                  : DISPATCH_SECRET, NAJIKI_DOMAIN, NAJIKI_API_KEY,
 *                          SMS_COST, NAJIKI_TIMEOUT_MS
 *   payloads             : { notification_id } / { record: { id } } /
 *                          { new: { id } } / { id }  and  { retry_sweep: true }
 *   auth                 : Authorization: Bearer <DISPATCH_SECRET>
 *   JWT                  : platform verification stays ENABLED (do not deploy
 *                          with --no-verify-jwt); the handler checks the
 *                          dispatch secret as well.
 *
 * Deployment, exactly as it is in production:
 *   supabase functions deploy send-attendance-sms
 *   supabase secrets set DISPATCH_SECRET=... NAJIKI_API_KEY=... SMS_COST=...
 *
 * Scheduling is NOT implied by the function URL: the retry sweep needs a cron
 * job (pg_cron / Supabase Scheduler / QStash) that POSTs {"retry_sweep":true}.
 *
 * Everything external is unchanged, because it matches the live database and the
 * app's callers: column names, status values, RPC signature, request payloads,
 * auth header and return shapes. The hardening below is additive, and each item
 * is explained where it lives:
 *   1. `Idempotency-Key` on the NaJiki call, so a retry cannot create a second
 *      (billable) SMS;
 *   2. constant-time comparison of the dispatch secret;
 *   3. a real MSISDN check and a 1..918-character message guard, both BEFORE the
 *      wallet is charged (the deployed version only rejected empty numbers, so
 *      an undeliverable number or an over-long message was paid for and then
 *      retried five times);
 *   4. success requires three things, not one: a 2xx, a payload that does not
 *      say it failed, and an acknowledgement id to match a delivery report on;
 *   5. a wallet keyed by `school_id` instead of `tenant_id` is still found;
 *   6. a terminal failure after a successful debit is written as
 *      `charged_undelivered:<reason>`, so the schools that paid for nothing can
 *      be found with one query and refunded with
 *      `public.refund_sms_charge(notification_id)` (migration 16);
 *   7. backoff honours the gateway's `Retry-After` (seconds or HTTP date, capped
 *      at an hour) instead of always waiting 3 minutes;
 *   8. the claim lock is derived from the send timeout, so it can never expire
 *      while a send is still in flight;
 *   9. the retry sweep stops after a wall-clock budget
 *      (`SMS_SWEEP_BUDGET_MS`) instead of running up to 50 x 30 s inside one
 *      invocation.
 */

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const NAJIKI_DOMAIN = Deno.env.get("NAJIKI_DOMAIN") || "https://api.najiki.com";
const NAJIKI_API_KEY = Deno.env.get("NAJIKI_API_KEY") || "";
const DISPATCH_SECRET = Deno.env.get("DISPATCH_SECRET") || "";

// Cost per SMS charged via public.debit_sms_wallet. No default: an unset price
// must not silently sell SMS at an invented rate.
const SMS_COST = Number(Deno.env.get("SMS_COST") || "0");

const SCHOOL_SCHEMA = "school";
const NOTIFS_TABLE = "notifications";
const MAX_ATTEMPTS = 5;
/** NaJiki's hard ceiling (6 segments). Longer text can never be delivered, so
 * it must be rejected BEFORE the wallet is charged. */
const MAX_MESSAGE_CHARS = 918;

/** The id we can later match a delivery report on. */
function ackIdOf(data: any): string | null {
  const raw = data?.smsId ?? data?.id ?? data?.reference ?? null;
  return raw === null || raw === undefined ? null : String(raw).trim() || null;
}

function jsonResponse(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time compare, so the secret cannot be guessed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractNotificationId(body: any): string | null {
  const raw = body?.notification_id ??
    body?.record?.id ??
    body?.new?.id ??
    body?.record?.notification_id ??
    body?.new?.notification_id ??
    body?.id ??
    null;
  // A filter object (`{ $ne: null }`) is not an id: coercing it produced
  // "[object Object]" and a pointless round trip.
  if (typeof raw === "number") return String(raw);
  if (typeof raw !== "string") return null;
  return raw.trim() || null;
}

/** NaJiki's `SmsInputSchema.to` pattern. A number that cannot match must not be
 * charged for: the deployed version only rejected EMPTY numbers, so "+12345"
 * went all the way to the gateway, was billed, and was retried five times. */
const MSISDN_RE = /^\+?[0-9]{9,15}$/;

function toE164(phone: string): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) return "+256" + digits.slice(1);
  if (digits.startsWith("256")) return "+" + digits;
  return phone.startsWith("+") ? phone : "+" + digits;
}

function toIsoAfterSeconds(sec: number) {
  return new Date(Date.now() + sec * 1000).toISOString();
}

/** `Retry-After` is either a number of seconds or an HTTP date. Cap it so a
 * hostile or broken header cannot park a message for a day. */
function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return Math.min(Math.ceil(asNumber), 3600);
  }
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const sec = Math.ceil((asDate - Date.now()) / 1000);
    if (sec > 0) return Math.min(sec, 3600);
  }
  return null;
}

/** Default backoff when the gateway does not tell us. */
const DEFAULT_BACKOFF_SEC = 180;

/**
 * Distinguish "we took the money and never delivered" from "nothing happened".
 *
 * A terminal failure on a charged row is prefixed so it can be found with one
 * query (`error LIKE 'charged_undelivered:%'`) and refunded with
 * `public.refund_sms_charge(notification_id)`. Without the prefix, a charged
 * failure and an uncharged one look identical in the table.
 */
function failCode(
  base: string,
  isFinalAttempt: boolean,
  charged: boolean,
): string {
  return isFinalAttempt && charged ? `charged_undelivered:${base}` : base;
}

function maxAttemptsReached(nextRetryCount: number) {
  // nextRetryCount is 1..N; cap is 5 total attempts
  return nextRetryCount >= MAX_ATTEMPTS;
}

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (!DISPATCH_SECRET) {
      // Fail closed, and say why rather than 401-ing a misconfigured deploy.
      console.error("[send-attendance-sms] DISPATCH_SECRET is not set");
      return jsonResponse({ error: "Dispatch is not configured" }, 503);
    }
    const authHeader = req.headers.get("Authorization") || "";
    const presented = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!safeEqual(presented, DISPATCH_SECRET)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    if (!NAJIKI_API_KEY) {
      throw new Error("NAJIKI_API_KEY is required");
    }
    if (
      !Number.isFinite(SMS_COST) || SMS_COST <= 0 || !Number.isInteger(SMS_COST)
    ) {
      // Platform-only price. Refuse rather than invent one.
      console.error("[send-attendance-sms] SMS_COST is not a positive integer");
      return jsonResponse({ error: "SMS pricing is not configured" }, 503);
    }

    const body = await req.json().catch(() => ({} as any));

    if (body?.retry_sweep) {
      return await runRetrySweep();
    }

    const notificationId = extractNotificationId(body);
    if (!notificationId) {
      return jsonResponse({ error: "missing notification id" }, 400);
    }

    return await dispatchOne(notificationId, { strictPending: true });
  } catch (err: any) {
    console.error("dispatch-notification error:", err);
    return jsonResponse({ error: String(err) }, 500);
  }
});

async function dispatchOne(
  notificationId: string,
  opts: { strictPending: boolean },
) {
  // Hard stop: Only dispatch rows that were inserted by the teacher flow (status='pending').
  if (opts?.strictPending) {
    const { data: current } = await supabase
      .schema(SCHOOL_SCHEMA)
      .from(NOTIFS_TABLE)
      .select("id,status")
      .eq("id", notificationId)
      .maybeSingle();

    if (!current) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "notification not found",
      }, 200);
    }

    const status = (current as any).status;
    if (status !== "pending") {
      return jsonResponse(
        { ok: true, skipped: true, reason: "Status is not pending" },
        200,
      );
    }
  }

  // The claim lock must outlive the send itself, or a slow gateway would let a
  // second worker claim the same row while the first is still waiting on it.
  const sendTimeoutMs = Number(Deno.env.get("NAJIKI_TIMEOUT_MS") || "30000");
  const lockMs = Math.max(
    60_000,
    (Number.isFinite(sendTimeoutMs) ? sendTimeoutMs : 30_000) + 15_000,
  );
  const lockUntilIso = toIsoAfterSeconds(Math.ceil(lockMs / 1000));

  // Claim only pending rows
  const { data: claimed, error: claimErr } = await supabase
    .schema(SCHOOL_SCHEMA)
    .from(NOTIFS_TABLE)
    .update({
      next_retry_at: lockUntilIso,
      error: null,
    })
    .eq("id", notificationId)
    .eq("status", "pending")
    .or("next_retry_at.is.null,next_retry_at.lte." + new Date().toISOString())
    .select(
      "id,status,school_id,recipient_phone_snapshot,message,retry_count,next_retry_at",
    )
    .maybeSingle();

  if (claimErr) {
    console.error("claim error:", claimErr);
    return jsonResponse({ error: "claim failed" }, 500);
  }

  if (!claimed) {
    // Not claimable (already handled / not pending anymore)
    const { data: current } = await supabase
      .schema(SCHOOL_SCHEMA)
      .from(NOTIFS_TABLE)
      .select("status,next_retry_at")
      .eq("id", notificationId)
      .maybeSingle();

    if (!current) return jsonResponse({ error: "notification not found" }, 404);

    const status = (current as any).status;
    if (status !== "pending") {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "Status is not pending",
      }, 200);
    }

    return jsonResponse({ skipped: true, reason: "not claimable" }, 200);
  }

  const notif = claimed as any;
  const nextRetryCount = (notif.retry_count ?? 0) + 1;
  const isFinalAttempt = maxAttemptsReached(nextRetryCount);

  const messageText = String(notif.message ?? "");
  if (messageText.length < 1 || messageText.length > MAX_MESSAGE_CHARS) {
    // NaJiki rejects this every time; charging for it just loses the school's
    // money on five guaranteed failures.
    await supabase
      .schema(SCHOOL_SCHEMA)
      .from(NOTIFS_TABLE)
      .update({
        status: "failed",
        error: "invalid_message_length",
        retry_count: nextRetryCount,
        next_retry_at: null,
      })
      .eq("id", notificationId);

    return jsonResponse({ error: "invalid message length" }, 200);
  }

  const phone = toE164(notif.recipient_phone_snapshot || "");
  if (!phone || !MSISDN_RE.test(phone)) {
    await supabase
      .schema(SCHOOL_SCHEMA)
      .from(NOTIFS_TABLE)
      .update({
        status: "failed",
        error: "invalid_phone_snapshot",
        retry_count: nextRetryCount,
        next_retry_at: null,
      })
      .eq("id", notificationId);

    return jsonResponse({ error: "invalid phone" }, 200);
  }

  const schoolIdText = String(notif.school_id);

  // Some wallets are keyed by tenant_id, others by school_id. Looking up only
  // tenant_id left those schools stuck at wallet_missing forever.
  let { data: wallet, error: walletErr } = await supabase
    .from("wallets")
    .select("id,balance")
    .eq("tenant_id", schoolIdText)
    .maybeSingle();

  if (!walletErr && !wallet) {
    const bySchool = await supabase
      .from("wallets")
      .select("id,balance")
      .eq("school_id", schoolIdText)
      .maybeSingle();
    wallet = bySchool.data;
    walletErr = bySchool.error;
  }

  if (walletErr) {
    await markDispatchFailed(
      notificationId,
      nextRetryCount,
      isFinalAttempt,
      "wallet_lookup_error",
    );
    return jsonResponse({ error: "wallet lookup failed" }, 200);
  }

  if (!wallet) {
    await markDispatchFailed(
      notificationId,
      nextRetryCount,
      isFinalAttempt,
      "wallet_missing",
    );
    return jsonResponse({ error: "wallet missing" }, 200);
  }

  const idempotencyKey = `sms:${notificationId}`;

  const { error: debitErr } = await supabase.rpc("debit_sms_wallet", {
    p_wallet_id: wallet.id,
    p_amount: SMS_COST,
    p_idempotency_key: idempotencyKey,
    p_tenant_id: schoolIdText,
    p_description: `notification_dispatch:${notificationId}`,
  });

  let chargedThisRow = false;

  if (debitErr) {
    await supabase
      .schema(SCHOOL_SCHEMA)
      .from(NOTIFS_TABLE)
      .update({
        status: isFinalAttempt ? "failed" : "pending",
        error: "insufficient_balance_or_debit_failed",
        retry_count: nextRetryCount,
        next_retry_at: isFinalAttempt
          ? null
          : toIsoAfterSeconds(DEFAULT_BACKOFF_SEC),
        provider_response: JSON.stringify({ debit: debitErr.message }),
      })
      .eq("id", notificationId);

    return jsonResponse({ error: "insufficient balance" }, 200);
  }

  // The debit succeeded: from here on, a failure means the school paid for
  // nothing, and the error is marked accordingly.
  chargedThisRow = true;

  const najikiTimeoutMs = sendTimeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), najikiTimeoutMs);

  let najikiRes: Response | null = null;
  let najikiData: any = {};
  let retryAfterSec: number | null = null;

  try {
    najikiRes = await fetch(`${NAJIKI_DOMAIN}/api/messaging/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NAJIKI_API_KEY}`,
        // One key per notification: a retry is the SAME message, so NaJiki
        // deduplicates it instead of sending (and billing) a second SMS.
        "Idempotency-Key": idempotencyKey,
      },
      // `smsId` carries OUR notification id to the gateway, which is what lets
      // the delivery report name the row again.
      body: JSON.stringify({
        smsId: notif.id,
        to: phone,
        message: notif.message,
      }),
      signal: controller.signal,
    });

    retryAfterSec = parseRetryAfter(najikiRes.headers.get("retry-after"));
    najikiData = await najikiRes.json().catch(() => ({}));
  } catch (e: any) {
    const msg = e?.name === "AbortError"
      ? `timeout_${najikiTimeoutMs}ms`
      : String(e);

    await supabase
      .schema(SCHOOL_SCHEMA)
      .from(NOTIFS_TABLE)
      .update({
        status: isFinalAttempt ? "failed" : "pending",
        retry_count: nextRetryCount,
        provider_response: JSON.stringify({ error: msg }),
        error: failCode(
          "provider_timeout_or_fetch_error",
          isFinalAttempt,
          chargedThisRow,
        ),
        next_retry_at: isFinalAttempt
          ? null
          : toIsoAfterSeconds(DEFAULT_BACKOFF_SEC),
      })
      .eq("id", notificationId);

    return jsonResponse({ success: false, error: msg }, 200);
  } finally {
    clearTimeout(timeout);
  }

  const ackId = ackIdOf(najikiData);
  const payloadSaysFailed = !!najikiData &&
    (najikiData.success === false || (!!najikiData.error && !ackId));

  if (najikiRes && najikiRes.ok && !payloadSaysFailed && ackId) {
    await supabase
      .schema(SCHOOL_SCHEMA)
      .from(NOTIFS_TABLE)
      .update({
        status: "sent",
        provider_response: JSON.stringify(najikiData),
        // A retry that finally succeeds clears the charged-undelivered marker.
        error: null,
        sent_at: new Date().toISOString(),
        next_retry_at: null,
      })
      .eq("id", notificationId);

    return jsonResponse({ success: true }, 200);
  }

  // Everything below is a failure: non-2xx, a 2xx that admits failure, or a 2xx
  // with no smsId (nothing to match a delivery report against later).
  const reason = najikiRes && najikiRes.ok
    ? (payloadSaysFailed ? "provider_rejected" : "provider_ack_without_id")
    : "provider_failed";

  // Honour the gateway's own backoff when it sends one (429 + Retry-After),
  // instead of always waiting our default.
  const backoffSec = retryAfterSec ?? DEFAULT_BACKOFF_SEC;

  await supabase
    .schema(SCHOOL_SCHEMA)
    .from(NOTIFS_TABLE)
    .update({
      status: isFinalAttempt ? "failed" : "pending",
      retry_count: nextRetryCount,
      provider_response: JSON.stringify(najikiData),
      error: failCode(reason, isFinalAttempt, chargedThisRow),
      next_retry_at: isFinalAttempt ? null : toIsoAfterSeconds(backoffSec),
    })
    .eq("id", notificationId);

  return jsonResponse({ success: false, error: najikiData }, 200);
}

async function markDispatchFailed(
  notificationId: string,
  nextRetryCount: number,
  isFinalAttempt: boolean,
  errCode: string,
) {
  await supabase
    .schema(SCHOOL_SCHEMA)
    .from(NOTIFS_TABLE)
    .update({
      status: isFinalAttempt ? "failed" : "pending",
      error: errCode,
      retry_count: nextRetryCount,
      next_retry_at: isFinalAttempt
        ? null
        : toIsoAfterSeconds(DEFAULT_BACKOFF_SEC),
    })
    .eq("id", notificationId);
}

async function runRetrySweep() {
  const nowIso = new Date().toISOString();
  // 50 rows x a 30 s gateway timeout can outlive the platform's invocation
  // limit, which would kill the sweep mid-batch. Stop starting new rows early
  // and let the next run pick them up.
  // SMS_SWEEP_BUDGET_MS is the name; SMS_BATCH_BUDGET_MS is the older alias
  // documented in .env.example, still honoured so an existing secret keeps working.
  const budgetRaw = Number(
    Deno.env.get("SMS_SWEEP_BUDGET_MS") ||
      Deno.env.get("SMS_BATCH_BUDGET_MS") || "45000",
  );
  const budgetMs = Number.isFinite(budgetRaw) && budgetRaw > 0
    ? budgetRaw
    : 45_000;
  const startedAt = Date.now();

  const { data: stuck, error } = await supabase
    .schema(SCHOOL_SCHEMA)
    .from(NOTIFS_TABLE)
    .select("id")
    .eq("status", "pending")
    .lt("retry_count", MAX_ATTEMPTS)
    .or(`next_retry_at.is.null,next_retry_at.lte.${nowIso}`)
    .limit(50);

  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }

  if (!stuck || stuck.length === 0) return jsonResponse({ swept: 0 }, 200);

  let dispatched = 0;
  let stoppedEarly = false;

  for (const row of stuck) {
    if (Date.now() - startedAt > budgetMs) {
      stoppedEarly = true;
      console.warn(
        "[send-attendance-sms] sweep budget exhausted; the rest wait for the next run",
      );
      break;
    }
    await dispatchOne(String((row as any).id), { strictPending: true });
    dispatched++;
  }

  return jsonResponse({
    swept: stuck.length,
    dispatched,
    stopped_early: stoppedEarly,
  }, 200);
}
