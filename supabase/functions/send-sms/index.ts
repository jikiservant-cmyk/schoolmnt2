/**
 * Supabase Edge Function: send-sms
 *
 * The ONLY component that spends money on SMS. The Next.js app never sends a
 * message itself — it queues rows into `school.notifications` (see
 * `lib/notifications/queue.ts`). This function drains that queue:
 *
 *   1. claim queued rows atomically (status guard, so concurrent workers and
 *      retries can never send the same SMS twice)
 *   2. debit the school wallet atomically via `school.debit_sms_wallet(...)`,
 *      whose reference is derived from the notification id — so the charge is
 *      idempotent too
 *   3. POST to NaJiki `/api/messaging/send` with `Idempotency-Key` = same id
 *   4. store NaJiki's `smsId` in `provider_ref`, so the delivery report
 *      (`SMS_DELIVERY_UPDATE`) can find the row again, plus `sent_at` and the
 *      raw `provider_response`
 *
 * Pricing is PLATFORM-ONLY (`SMS_UNIT_PRICE_UGX`). A school can never set it;
 * if it is missing the function sends nothing rather than inventing a price.
 *
 * Deploy:
 *   supabase functions deploy send-sms --no-verify-jwt
 *   supabase secrets set \
 *     NAJIKI_API_URL=https://<gateway>/api/messaging/send \
 *     NAJIKI_API_KEY=... \
 *     NAJIKI_APP_CODE=school \
 *     SMS_UNIT_PRICE_UGX=... \
 *     SMS_DISPATCH_SECRET=...
 *
 * Call it from a schedule (pg_cron / QStash / Supabase Scheduler) with the
 * dispatch header:
 *   POST /functions/v1/send-sms   x-dispatch-secret: <SMS_DISPATCH_SECRET>
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to every Supabase
 * Edge Function automatically. The service-role key is REQUIRED: since
 * migration 06, anon/authenticated have no write access to school.notifications
 * or to the wallet functions.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  buildSmsRequest,
  classifySendResponse,
  nextAttempt,
  resolveUnitPrice,
} from "./sms-sender.ts";

const BATCH_SIZE = 25;
const SEND_TIMEOUT_MS = 12_000;
// Supabase Edge Functions are killed at the wall-clock limit, which would leave
// claimed rows stranded in `sending`. Stop starting new work well before that.
// Overridable for tests and for platforms with a different timeout.
const DEFAULT_BATCH_BUDGET_MS = 45_000;

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Constant-time-ish comparison; the secret never appears in a URL or log. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req: Request): boolean {
  const expected = env("SMS_DISPATCH_SECRET");
  if (!expected) return false; // fail closed: an unauthenticated endpoint that spends money is worse than a dead one
  const bearer = (req.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  ).trim();
  const direct = (req.headers.get("x-dispatch-secret") ?? "").trim();
  return safeEqual(direct, expected) || safeEqual(bearer, expected);
}

type Row = Record<string, any>;

// The platform injects no port, so default to Deno's 8000 exactly as before;
// PORT only exists so several instances can run side by side in tests.
const port = Number(env("PORT")) || 8000;
const hostname = env("HOSTNAME") || "0.0.0.0";

Deno.serve({ port, hostname }, async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!authorized(req)) return json({ error: "Unauthorized" }, 401);

  const supabaseUrl = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "Server configuration error" }, 500);
  }

  const budgetRaw = Number(env("SMS_BATCH_BUDGET_MS"));
  const batchBudgetMs = Number.isFinite(budgetRaw) && budgetRaw > 0
    ? budgetRaw
    : DEFAULT_BATCH_BUDGET_MS;

  const unitPrice = resolveUnitPrice(env("SMS_UNIT_PRICE_UGX"));
  if (unitPrice === null) {
    // Do not guess a price: an unset/invalid one means no SMS is charged or sent.
    console.error(
      "[send-sms] SMS_UNIT_PRICE_UGX is not a positive integer; refusing to send.",
    );
    return json({ error: "SMS pricing is not configured" }, 503);
  }

  const endpoint = env("NAJIKI_API_URL") ||
    "https://najiki.vercel.app/api/messaging/send";
  const apiKey = env("NAJIKI_API_KEY");
  if (!apiKey) return json({ error: "SMS gateway is not configured" }, 503);
  const applicationCode = env("NAJIKI_APP_CODE") || "school";
  const senderId = env("NAJIKI_SENDER_ID") || "";

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const school = db.schema("school");

  // ---- 1. find work -------------------------------------------------------
  const { data: candidates, error: findErr } = await school
    .from("notifications")
    .select(
      "id, school_id, message, recipient_phone_snapshot, notification_type, related_table, related_id, provider_response",
    )
    .eq("channel", "sms")
    .eq("status", "queued")
    .is("provider_ref", null)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (findErr) {
    console.error("[send-sms] could not read the queue:", findErr.message);
    return json({ error: "Queue read failed" }, 500);
  }
  if (!candidates || candidates.length === 0) {
    return json({ processed: 0, sent: 0, failed: 0, retried: 0 });
  }

  // ---- 2. claim them atomically ------------------------------------------
  // The `.eq('status','queued')` predicate is what makes this safe: Postgres
  // re-checks it under the row lock, so two workers (or two retries) can never
  // both claim the same row.
  const { data: claimed, error: claimErr } = await school
    .from("notifications")
    .update({ status: "sending" })
    .in("id", candidates.map((c: Row) => c.id))
    .eq("status", "queued")
    .select(
      "id, school_id, message, recipient_phone_snapshot, notification_type, related_table, related_id, provider_response",
    );

  if (claimErr) {
    console.error("[send-sms] claim failed:", claimErr.message);
    return json({ error: "Queue claim failed" }, 500);
  }

  let sent = 0;
  let failed = 0;
  let retried = 0;

  const claimedRows = (claimed ?? []) as Row[];

  // Whatever happens below (time budget, thrown error, platform timeout), any
  // row still in `sending` goes back to `queued`. The `.eq('status','sending')`
  // predicate means already-finished rows are untouched, so this is idempotent.
  const releaseUnprocessed = async () => {
    const ids = claimedRows.map((r) => r.id);
    if (ids.length === 0) return;
    const { error } = await school
      .from("notifications")
      .update({ status: "queued" })
      .in("id", ids)
      .eq("status", "sending");
    if (error) {
      console.error(
        "[send-sms] could not release unprocessed rows:",
        error.message,
      );
    }
  };

  const startedAt = Date.now();

  try {
    for (const row of claimedRows) {
      if (Date.now() - startedAt > batchBudgetMs) {
        console.warn("[send-sms] out of time, leaving the rest queued");
        break;
      }
      const markFailed = async (reason: string) => {
        await school
          .from("notifications")
          .update({
            status: "failed",
            provider_response: { reason: reason.slice(0, 300) },
          })
          .eq("id", row.id);
        failed++;
      };
      const requeue = async (
        reason: string,
        state: { attempts: number; charged: boolean },
      ) => {
        await school
          .from("notifications")
          .update({
            status: "queued",
            // Persist the counter: this jsonb blob is the only place it can live
            // (no attempt_count column), and it is what stops infinite retries.
            provider_response: {
              reason: reason.slice(0, 300),
              attempts: state.attempts,
              charged: state.charged,
            },
          })
          .eq("id", row.id);
        retried++;
      };

      let request: ReturnType<typeof buildSmsRequest>;
      try {
        request = buildSmsRequest({
          notificationId: String(row.id),
          message: String(row.message ?? ""),
          recipient: String(row.recipient_phone_snapshot ?? ""),
          applicationCode,
          senderId,
        });
      } catch (e) {
        // Bad number or over-length body: retrying cannot fix it.
        await markFailed(`invalid_notification: ${(e as Error).message}`);
        continue;
      }

      // ---- 3. charge the school, idempotently -----------------------------
      const { data: debit, error: debitErr } = await school.rpc(
        "debit_sms_wallet",
        {
          p_school_id: row.school_id,
          p_amount: unitPrice,
          p_reference: request.walletReference,
          p_description: "SMS Notification Charge",
        },
      );

      if (debitErr) {
        console.error(
          "[send-sms] wallet RPC failed for",
          row.id,
          debitErr.message,
        );
        const st = nextAttempt((row as Row).provider_response);
        if (st.exhausted) {
          await markFailed("retry_exhausted: wallet_unavailable");
        } else await requeue("wallet_unavailable", st);
        continue;
      }

      const outcome = String((debit as Row | null)?.outcome ?? "unknown");
      if (
        outcome === "insufficient_funds" || outcome === "invalid_amount" ||
        outcome === "invalid_request"
      ) {
        // No money, no message — and no retry storm.
        await markFailed(`wallet_${outcome}`);
        continue;
      }
      if (outcome !== "debited" && outcome !== "duplicate") {
        const st = nextAttempt((row as Row).provider_response);
        if (st.exhausted) {
          await markFailed(`retry_exhausted: wallet_${outcome}`);
        } else await requeue(`wallet_${outcome}`, st);
        continue;
      }
      // From here on the school HAS been charged for this row (`duplicate` means an
      // earlier attempt already charged it), which changes the retry policy below.
      const chargedNow = true;
      // 'duplicate' means this row was already charged on an earlier attempt;
      // the send below is still safe because NaJiki is idempotent on the same key.

      // ---- 4. hand it to NaJiki -------------------------------------------
      let httpStatus = 0;
      let payload: Record<string, unknown> | null = null;
      let retryAfter: string | null = null;
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
            "x-api-key": apiKey,
            "Idempotency-Key": request.idempotencyKey,
          },
          body: JSON.stringify(request.body),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        httpStatus = res.status;
        retryAfter = res.headers.get("retry-after");
        try {
          payload = await res.json();
        } catch {
          payload = null;
        }
      } catch (e) {
        console.warn(
          "[send-sms] gateway unreachable for",
          row.id,
          (e as Error).message,
        );
        const st = nextAttempt((row as Row).provider_response, chargedNow);
        if (st.exhausted) {
          await markFailed(`charged_undelivered: gateway_unreachable`);
        } else await requeue("gateway_unreachable", st);
        continue;
      }

      const result = classifySendResponse(httpStatus, payload, retryAfter);

      if (result.outcome === "accepted") {
        // provider_ref is what the delivery report matches on, so store NaJiki's
        // own smsId — never a guessed or locally-generated id.
        const { error: recErr } = await school
          .from("notifications")
          .update({
            status: "sent",
            provider_ref: result.providerRef,
            sent_at: new Date().toISOString(),
            provider_response: {
              smsId: result.providerRef,
              reference: result.reference,
              deduplicated: result.deduplicated,
              httpStatus,
            },
          })
          .eq("id", row.id);
        if (recErr) {
          console.error(
            "[send-sms] could not record acceptance for",
            row.id,
            recErr.message,
          );
        } else sent++;
        continue;
      }

      if (result.outcome === "retry") {
        const st = nextAttempt((row as Row).provider_response, chargedNow);
        if (st.exhausted) {
          // Never report a charged message as a plain retry failure: the
          // `charged_undelivered:` prefix is what tells an operator money moved
          // without a delivered SMS, so it can be refunded by hand.
          const prefix = st.charged ? "charged_undelivered" : "retry_exhausted";
          await markFailed(
            `${prefix}: ${result.reason} (after ${st.attempts} attempts)`,
          );
        } else {
          await requeue(result.reason, st);
        }
        continue;
      }

      await markFailed(result.reason);
    }
  } finally {
    // Rows we never reached (time budget, thrown error) must not stay claimed.
    await releaseUnprocessed();
  }

  const processed = sent + failed + retried;
  const skipped = (candidates?.length ?? 0) - (claimed?.length ?? 0);
  console.log(
    `[send-sms] claimed=${
      claimed?.length ?? 0
    } sent=${sent} failed=${failed} requeued=${retried} skipped=${skipped}`,
  );
  return json({ processed, sent, failed, retried, skipped });
});
