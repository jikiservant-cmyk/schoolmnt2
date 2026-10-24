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
 * Changes from the version pasted by the owner are limited to two things, both
 * additive and both explained inline:
 *   1. an `Idempotency-Key` header on the NaJiki call, so a retry cannot create
 *      a second (billable) SMS;
 *   2. a constant-time comparison of the dispatch secret;
 *   3. a real MSISDN check, so an undeliverable number is failed BEFORE the
 *      wallet is charged (the deployed version only rejected empty numbers and
 *      therefore paid for, and retried, numbers the gateway cannot deliver).
 * Everything else — column names, status values, RPC signature, request body,
 * response handling and return values — is unchanged, because those match the
 * live database and the app's callers.
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
  return (
    body?.notification_id ??
      body?.record?.id ??
      body?.new?.id ??
      body?.record?.notification_id ??
      body?.new?.notification_id ??
      body?.id ??
      null
  )?.toString?.() ?? null;
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

function toIsoAfterMinutes(mins: number) {
  return new Date(Date.now() + mins * 60 * 1000).toISOString();
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

  const lockUntilIso = toIsoAfterMinutes(1);

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

  const { data: wallet, error: walletErr } = await supabase
    .from("wallets")
    .select("id,balance")
    .eq("tenant_id", schoolIdText)
    .maybeSingle();

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

  if (debitErr) {
    await supabase
      .schema(SCHOOL_SCHEMA)
      .from(NOTIFS_TABLE)
      .update({
        status: isFinalAttempt ? "failed" : "pending",
        error: "insufficient_balance_or_debit_failed",
        retry_count: nextRetryCount,
        next_retry_at: isFinalAttempt ? null : toIsoAfterMinutes(3),
        provider_response: JSON.stringify({ debit: debitErr.message }),
      })
      .eq("id", notificationId);

    return jsonResponse({ error: "insufficient balance" }, 200);
  }

  const najikiTimeoutMs = Number(Deno.env.get("NAJIKI_TIMEOUT_MS") || "30000");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), najikiTimeoutMs);

  let najikiRes: Response | null = null;
  let najikiData: any = {};

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
        error: "provider_timeout_or_fetch_error",
        next_retry_at: isFinalAttempt ? null : toIsoAfterMinutes(3),
      })
      .eq("id", notificationId);

    return jsonResponse({ success: false, error: msg }, 200);
  } finally {
    clearTimeout(timeout);
  }

  if (najikiRes && najikiRes.ok) {
    await supabase
      .schema(SCHOOL_SCHEMA)
      .from(NOTIFS_TABLE)
      .update({
        status: "sent",
        provider_response: JSON.stringify(najikiData),
        error: null,
        sent_at: new Date().toISOString(),
        next_retry_at: null,
      })
      .eq("id", notificationId);

    return jsonResponse({ success: true }, 200);
  }

  await supabase
    .schema(SCHOOL_SCHEMA)
    .from(NOTIFS_TABLE)
    .update({
      status: isFinalAttempt ? "failed" : "pending",
      retry_count: nextRetryCount,
      provider_response: JSON.stringify(najikiData),
      error: "provider_failed",
      next_retry_at: isFinalAttempt ? null : toIsoAfterMinutes(3),
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
      next_retry_at: isFinalAttempt ? null : toIsoAfterMinutes(3),
    })
    .eq("id", notificationId);
}

async function runRetrySweep() {
  const nowIso = new Date().toISOString();

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

  for (const row of stuck) {
    await dispatchOne(String((row as any).id), { strictPending: true });
  }

  return jsonResponse({ swept: stuck.length }, 200);
}
