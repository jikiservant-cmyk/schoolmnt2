// End-to-end test of the REAL Supabase Edge Function (supabase/functions/send-sms).
//
// Nothing here is simulated: the function is started with Deno exactly as the
// platform runs it, it talks to the lab's Supabase shim (REST + RPC + the fake
// NaJiki SMS API), and every assertion is made against the actual database.
//
// It deliberately drives the function through the SAME interface the deployed
// one exposes, because the app and the cron callers depend on it:
//   - auth      : Authorization: Bearer <DISPATCH_SECRET>  (x-dispatch-secret too)
//   - payloads  : { notification_id }, { record: { id } }, { retry_sweep: true }
//   - statuses  : pending -> sending -> sent | failed | pending (retry)
//
// Usage: node sms-edge-e2e-check.mjs [base] [appDir] [label]
// Env:   DENO_BIN (default `deno`), PORT_DENO (default 8000), SKIP_SEED=1
import crypto from "crypto";
import fs from "fs";
import pg from "pg";
import { execSync, spawn } from "child_process";
import net from "node:net";
import { createRequire } from "node:module";
import seedMod from "./seed.js";

const require = createRequire(import.meta.url);
const { IDS: { A: SA, B: SB } } = seedMod;
const SCHOOL = SA.school;
const SCHOOL_B = SB.school;
const [BASE = "http://127.0.0.1:3000", , LABEL = "run"] = process.argv.slice(2);
const SHIM = "http://127.0.0.1:54321";
const API_KEY = process.env.NAJIKI_API_KEY || "lab-najiki-secret";
const WEBHOOK_SECRET = process.env.NAJIKI_WEBHOOK_SECRET || "lab-dedicated-webhook-secret-123";
const DISPATCH = "lab-dispatch-" + crypto.randomBytes(6).toString("hex");
const PRICE = 30;
const FN_PORT = Number(process.env.PORT_DENO || 8000);
const DENO = process.env.DENO_BIN || "deno";
const FN_ENTRY = "/home/user/schoolmnt2/supabase/functions/send-sms/index.ts";

let fail = 0;
const check = (name, pass, detail = "") => {
  if (!pass) fail++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
};

try {
  execSync(`${DENO} --version`, { stdio: "ignore" });
} catch {
  console.log("\n=== SMS EDGE E2E: SKIPPED (deno not installed) ===");
  console.log("Install with: npm install --no-save deno   (or set DENO_BIN=/path/to/deno)");
  process.exit(0);
}
if (!fs.existsSync(FN_ENTRY)) {
  console.error(`Missing ${FN_ENTRY}`);
  process.exit(2);
}

if (!process.env.SKIP_SEED) {
  execSync("node seed.js", { cwd: "/home/user/mt-lab", stdio: "ignore", env: { ...process.env, RLS: "1" } });
}
await fetch(SHIM + "/__reload", { method: "POST" });

const db = new pg.Client({ host: "127.0.0.1", port: 54329, user: "postgres", password: "pw", database: "mtlab" });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;

// ---------------------------------------------------------------- harness ---
const waitForPort = async (port, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => { sock.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};

const procs = [];
const startFn = async (extraEnv = {}, { port = FN_PORT, price = PRICE } = {}) => {
  const env = {
    ...process.env,
    SUPABASE_URL: SHIM,
    SUPABASE_SERVICE_ROLE_KEY: "lab-service-key",
    // The deployed function's own env names.
    NAJIKI_DOMAIN: SHIM,
    // Do not inherit the app's PAYMENTS endpoint from the lab shell env.
    NAJIKI_API_URL: "",
    NAJIKI_MESSAGING_URL: "",
    NAJIKI_API_KEY: API_KEY,
    NAJIKI_APP_CODE: "school",
    NAJIKI_SENDER_ID: "SMARTSKOOLZ",
    DISPATCH_SECRET: DISPATCH,
    SMS_COST: price === null ? "" : String(price),
    PORT: String(port),
    ...extraEnv,
  };
  const p = spawn(DENO, ["run", "--allow-net", "--allow-env", FN_ENTRY], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  p.stdout.on("data", (d) => logs.push(String(d)));
  p.stderr.on("data", (d) => logs.push(String(d)));
  procs.push(p);
  if (!(await waitForPort(port))) throw new Error(`edge function did not start on :${port}\n${logs.join("")}`);
  return { p, logs, port };
};
const stopAll = () => { for (const p of procs) { try { p.kill("SIGKILL"); } catch {} } };
process.on("exit", stopAll);

const callFn = async (payload, { port = FN_PORT, headers = {}, auth = true } = {}) => {
  const h = { "Content-Type": "application/json", ...headers };
  if (auth) h.Authorization = `Bearer ${DISPATCH}`;
  return fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: h, body: JSON.stringify(payload) });
};

// A notification row exactly as lib/notifications/queue.ts writes it: 'pending'.
const queueSms = async (message, opts = {}) => {
  const {
    school = SCHOOL, recipient = "+256772123456", status = "pending",
    channel = "sms", providerResponse = null, providerRef = null,
  } = opts;
  const rows = await q(
    `INSERT INTO school.notifications(school_id, channel, notification_type, message, status,
        recipient_phone_snapshot, recipient_type, dedupe_key, provider_response, provider_ref)
     VALUES ($1,$2,'attendance_check_in',$3,$4,$5,'parent',$6,$7,$8) RETURNING id`,
    [school, channel, message, status, recipient, "att:" + crypto.randomUUID(),
      providerResponse === null ? null : JSON.stringify(providerResponse), providerRef],
  );
  return rows[0].id;
};
const notif = async (id) => (await q(
  "SELECT status, provider_ref, sent_at, provider_response FROM school.notifications WHERE id=$1", [id]))[0];
const walletBalance = async (school) => Number((await q(
  "SELECT coalesce(sum(balance),0) AS b FROM public.wallets WHERE tenant_id=$1 OR school_id=$1", [school]))[0].b);
// The suite deliberately spends money; keep the school funded so a later
// section cannot fail for the wrong reason.
const ensureFunds = async (school, min) => {
  const bal = await walletBalance(school);
  if (bal < min) {
    await q("UPDATE public.wallets SET balance = balance + $2 WHERE tenant_id=$1 OR school_id=$1", [school, min - bal]);
  }
};
const debitCount = async (id) => Number((await q(
  "SELECT count(*) AS c FROM public.transactions WHERE reference=$1 AND type='debit'", ["sms_" + id]))[0].c);
const smsLog = async () => (await fetch(SHIM + "/__najiki/sms-log")).json();
const resetSmsLog = () => fetch(SHIM + "/__najiki/sms-log", { method: "DELETE" });
// Same scheme the app verifies: `x-najiki-signature: t=<ms>,v=<hmac(ts.body)>`
const signWebhook = (secret, body) => {
  const t = Date.now();
  const v = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return { "Content-Type": "application/json", "x-najiki-signature": `t=${t},v=${v}` };
};

console.log("\n--- 1. Auth, method and configuration (fail closed) ---");

await startFn();

const noSecret = await callFn({ notification_id: crypto.randomUUID() }, { auth: false });
check("no dispatch secret is rejected", noSecret.status === 401, `HTTP ${noSecret.status}`);
const wrongSecret = await callFn({ notification_id: crypto.randomUUID() }, { headers: { Authorization: "Bearer nope" }, auth: false });
check("wrong dispatch secret is rejected", wrongSecret.status === 401, `HTTP ${wrongSecret.status}`);
const asGet = await fetch(`http://127.0.0.1:${FN_PORT}/`, { headers: { Authorization: `Bearer ${DISPATCH}` } });
check("GET is refused", asGet.status === 405, `HTTP ${asGet.status}`);
const noId = await callFn({});
check("a payload without a notification id is a 400", noId.status === 400, `HTTP ${noId.status}`);

// Fail closed when the platform price is missing: nothing may be sent or charged.
const noPrice = await startFn({}, { port: FN_PORT + 1, price: null });
const missingPrice = await callFn({ notification_id: crypto.randomUUID() }, { port: FN_PORT + 1 });
check("a missing SMS_COST refuses to send (503, no 1-UGX default)", missingPrice.status === 503, `HTTP ${missingPrice.status}`);
noPrice.p.kill("SIGKILL");

console.log("\n--- 2. Happy path: pending row -> charged once -> NaJiki 202 -> sent ---");

await ensureFunds(SCHOOL, 600);

await resetSmsLog();
const before = await walletBalance(SCHOOL);
const goodId = await queueSms("Dear Parent, Alice checked in at 07:42.");
const okRes = await callFn({ notification_id: goodId });
const okJson = await okRes.json();
check("the function answers 200 with success", okRes.status === 200 && okJson.success === true, JSON.stringify(okJson));

const good = await notif(goodId);
const log1 = await smsLog();
check("row is marked sent", good.status === "sent", good.status);
check("provider_ref is NaJiki's own smsId", good.provider_ref === log1[0]?.smsId, String(good.provider_ref));
check("sent_at is recorded", !!good.sent_at, String(good.sent_at));
check("provider_response is a real jsonb OBJECT, not a string",
  good.provider_response && typeof good.provider_response === "object" && !Array.isArray(good.provider_response),
  JSON.stringify(good.provider_response));
check("the message really reached NaJiki", log1.length === 1 && log1[0].body.to === "+256772123456", `messages=${log1.length}`);
check("NaJiki got applicationCode and the platform senderId",
  log1[0]?.body.applicationCode === "school" && log1[0]?.body.senderId === "SMARTSKOOLZ",
  `${log1[0]?.body.applicationCode}/${log1[0]?.body.senderId}`);
check("no unsupported field is sent (dropped local smsId)",
  log1[0]?.body.smsId === undefined, JSON.stringify(Object.keys(log1[0]?.body ?? {})));
check("Idempotency-Key is the wallet reference (sms_<notificationId>)",
  log1[0]?.idempotencyKey === "sms_" + goodId, String(log1[0]?.idempotencyKey));

const after = await walletBalance(SCHOOL);
check("wallet was charged the platform price exactly once", before - after === PRICE, `${before} -> ${after}`);
check("exactly one debit transaction exists", (await debitCount(goodId)) === 1, String(await debitCount(goodId)));

const again = await (await callFn({ notification_id: goodId })).json();
const after2 = await walletBalance(SCHOOL);
check("re-dispatching a sent row is a no-op", again.skipped === true, JSON.stringify(again));
check("no second message and no second charge",
  (await smsLog()).length === 1 && after2 === after, `messages=${(await smsLog()).length} balance=${after2}`);

// The DB-webhook payload shape must work too.
const hookId = await queueSms("Dear Parent, Bob checked out at 17:10.", { recipient: "+256772123499" });
const hookRes = await (await callFn({ type: "INSERT", record: { id: hookId } })).json();
check("a webhook-shaped payload {record:{id}} is dispatched", hookRes.success === true, JSON.stringify(hookRes));
check("the webhook row is sent", (await notif(hookId)).status === "sent");

// Bearer is what the deployment uses; the header alias must work as well.
const aliasId = await queueSms("Alias header test.", { recipient: "+256772123498" });
const aliasRes = await callFn({ notification_id: aliasId }, { headers: { "x-dispatch-secret": DISPATCH }, auth: false });
check("x-dispatch-secret is accepted as an alternative", (await aliasRes.json()).success === true);

console.log("\n--- 3. A school can never make the platform pay ---");

const poorSchool = SB.school || SCHOOL_B;
await q("DELETE FROM public.transactions WHERE wallet_id IN (SELECT id FROM public.wallets WHERE tenant_id=$1 OR school_id=$1)", [poorSchool]);
await q("UPDATE public.wallets SET balance=0 WHERE tenant_id=$1 OR school_id=$1", [poorSchool]);
const POOR_TO = "+256772999001";
const poorId = await queueSms("Fees reminder for term 2.", { school: poorSchool, recipient: POOR_TO });
const poorBefore = await walletBalance(poorSchool);
const poorRes = await (await callFn({ notification_id: poorId })).json();
const poor = await notif(poorId);
check("an unfunded school's SMS is marked failed, not sent", poor.status === "failed", poor.status);
check("nothing was sent to NaJiki on its behalf",
  (await smsLog()).filter((m) => m.body?.to === POOR_TO).length === 0);
check("its wallet was not driven negative", (await walletBalance(poorSchool)) === poorBefore, String(await walletBalance(poorSchool)));
check("the failure reason names the wallet outcome", String(poor.provider_response?.reason || "").includes("wallet_"),
  JSON.stringify(poor.provider_response));
check("the caller is told it did not send", poorRes.success === false, JSON.stringify(poorRes));

console.log("\n--- 4. Retry policy: transient failures requeue, permanent ones stop ---");

await ensureFunds(SCHOOL, 600);

await resetSmsLog();
const retryId = await queueSms("Transient fault [LAB_SMS_503] please retry.");
const balBeforeRetry = await walletBalance(SCHOOL);
await callFn({ notification_id: retryId });
const retry1 = await notif(retryId);
check("a 503 from the gateway leaves the row pending", retry1.status === "pending", retry1.status);
check("the attempt counter is persisted in provider_response", retry1.provider_response?.attempts === 1,
  JSON.stringify(retry1.provider_response));
check("the row is marked as already charged", retry1.provider_response?.charged === true,
  JSON.stringify(retry1.provider_response));
check("the first failure charged the school exactly once", balBeforeRetry - (await walletBalance(SCHOOL)) === PRICE,
  String(balBeforeRetry - (await walletBalance(SCHOOL))));

await callFn({ notification_id: retryId });
const retry2 = await notif(retryId);
check("a second failure increments the counter", retry2.provider_response?.attempts === 2,
  JSON.stringify(retry2.provider_response));
check("a retry does not charge twice", (await debitCount(retryId)) === 1, String(await debitCount(retryId)));

// Charged rows get the wider cap (10) because the money is already gone.
await callFn({ notification_id: retryId });
const retry3 = await notif(retryId);
check("still retrying at attempt 3 because money was taken",
  retry3.status === "pending" && retry3.provider_response?.attempts === 3,
  `${retry3.status} ${JSON.stringify(retry3.provider_response)}`);

await q("UPDATE school.notifications SET provider_response=$2 WHERE id=$1",
  [retryId, JSON.stringify({ reason: "Upstream unavailable", attempts: 9, charged: true, claimed_at: null })]);
await callFn({ notification_id: retryId });
const retry4 = await notif(retryId);
check("a charged row that cannot be delivered fails visibly, not silently",
  retry4.status === "failed" && String(retry4.provider_response?.reason || "").startsWith("charged_undelivered:"),
  `${retry4.status} ${JSON.stringify(retry4.provider_response)}`);
check("and it never charged a second time", (await debitCount(retryId)) === 1, String(await debitCount(retryId)));

// 409 is NaJiki's idempotency conflict: retrying the same key cannot succeed.
await resetSmsLog();
const conflictId = await queueSms("Conflict attempt one [LAB_SMS_503].");
await callFn({ notification_id: conflictId });                 // 503, logs the key
await q("UPDATE school.notifications SET message=$2 WHERE id=$1", [conflictId, "A totally different message"]);
await callFn({ notification_id: conflictId });                 // same key, new body -> 409
const conflict = await notif(conflictId);
check("a 409 idempotency conflict is permanent, not retried",
  conflict.status === "failed" && String(conflict.provider_response?.reason || "").includes("idempotency_conflict"),
  `${conflict.status} ${JSON.stringify(conflict.provider_response)}`);
check("the permanent failure is labelled as already charged",
  String(conflict.provider_response?.reason || "").startsWith("charged_undelivered:"),
  String(conflict.provider_response?.reason));

// An uncharged row stops at 3, and the attempt guard prevents a 4th send.
await resetSmsLog();
const permId = await queueSms("Never works [LAB_SMS_503] at all.");
await q("UPDATE school.notifications SET provider_response=$2 WHERE id=$1",
  [permId, JSON.stringify({ reason: "Upstream unavailable", attempts: 3, charged: false, claimed_at: null })]);
await callFn({ notification_id: permId });
const perm = await notif(permId);
check("a row that already used its budget is not attempted again",
  perm.status === "failed" && String(perm.provider_response?.reason || "").startsWith("retry_exhausted:"),
  `${perm.status} ${JSON.stringify(perm.provider_response)}`);
check("and the gateway was not called", (await smsLog()).length === 0, `messages=${(await smsLog()).length}`);

console.log("\n--- 5. Bad data never costs money or spams the gateway ---");

await resetSmsLog();
const balBeforeBad = await walletBalance(SCHOOL);
const BAD_TO = "12345";
const badPhone = await queueSms("Invalid recipient.", { recipient: BAD_TO });
await callFn({ notification_id: badPhone });
const bad = await notif(badPhone);
check("an invalid phone number is failed without charging",
  bad.status === "failed" && (await walletBalance(SCHOOL)) === balBeforeBad,
  `${bad.status} ${JSON.stringify(bad.provider_response?.reason)}`);
check("and it never reaches NaJiki", (await smsLog()).filter((m) => m.body?.to === BAD_TO).length === 0);

const oversize = await queueSms("A".repeat(2000), { recipient: "+256772123457" });
await callFn({ notification_id: oversize });
const over = await notif(oversize);
check("an over-length message is failed without charging", over.status === "failed" &&
  String(over.provider_response?.reason || "").startsWith("invalid_notification:"),
  `${over.status} ${String(over.provider_response?.reason)}`);

const notSms = await queueSms("Email channel row.", { channel: "email", recipient: "+256772123458" });
await callFn({ notification_id: notSms });
check("a non-sms row is skipped, never charged or sent",
  (await notif(notSms)).status === "pending" && (await smsLog()).length === 0,
  (await notif(notSms)).status);

console.log("\n--- 6. Sweep: retries due work and rescues rows stuck in `sending` ---");

await ensureFunds(SCHOOL, 600);

await resetSmsLog();
const balBeforeSweep = await walletBalance(SCHOOL);
// A row a dead worker left behind 30 minutes ago.
const staleId = await queueSms("Left behind by a dead worker.", {
  recipient: "+256772123470", status: "sending",
  providerResponse: { claimed_at: new Date(Date.now() - 30 * 60_000).toISOString(), attempts: 0, charged: false },
});
// A row another live worker is sending right now.
const liveId = await queueSms("Owned by a live worker.", {
  recipient: "+256772123471", status: "sending",
  providerResponse: { claimed_at: new Date().toISOString(), attempts: 0, charged: false },
});
// Ordinary queued work.
const pendingId = await queueSms("Queued work for the sweep.", { recipient: "+256772123472" });

const sweep = await (await callFn({ retry_sweep: true })).json();
check("the sweep reclaims a stale claim", (await notif(staleId)).status === "sent", (await notif(staleId)).status);
check("the sweep leaves a live claim alone", (await notif(liveId)).status === "sending", (await notif(liveId)).status);
check("the sweep sends pending work", (await notif(pendingId)).status === "sent", (await notif(pendingId)).status);
check("it reports what it did", Number(sweep.sent) >= 2, JSON.stringify(sweep));
check("the live row was not charged", (await debitCount(liveId)) === 0, String(await debitCount(liveId)));
check("the stale row was charged exactly once", (await debitCount(staleId)) === 1, String(await debitCount(staleId)));
check("balance moved by two messages only", balBeforeSweep - (await walletBalance(SCHOOL)) === PRICE * 2,
  String(balBeforeSweep - (await walletBalance(SCHOOL))));

// Clean up the row we deliberately left "live" so it cannot leak into later runs.
await q("UPDATE school.notifications SET status='failed' WHERE id=$1", [liveId]);

// A sweep with a tiny time budget must stop cleanly and strand nothing.
const tight = await startFn({ SMS_BATCH_BUDGET_MS: "1" }, { port: FN_PORT + 2 });
await resetSmsLog();
const budgetIds = [];
for (let i = 0; i < 3; i++) budgetIds.push(await queueSms(`Budget test ${i}.`, { recipient: "+25677212348" + i }));
const tightRes = await fetch(`http://127.0.0.1:${FN_PORT + 2}/`, {
  method: "POST", headers: { Authorization: `Bearer ${DISPATCH}`, "Content-Type": "application/json" },
  body: JSON.stringify({ retry_sweep: true }),
});
const tightJson = await tightRes.json();
const stillSending = Number((await q(
  "SELECT count(*) AS c FROM school.notifications WHERE id = ANY($1::uuid[]) AND status='sending'", [budgetIds]))[0].c);
const stillPending = Number((await q(
  "SELECT count(*) AS c FROM school.notifications WHERE id = ANY($1::uuid[]) AND status='pending'", [budgetIds]))[0].c);
check("out of time is a clean stop, not a crash", tightRes.status === 200, `HTTP ${tightRes.status} ${JSON.stringify(tightJson)}`);
check("no row is left stranded in `sending`", stillSending === 0, String(stillSending));
check("every unreached row is still queued", stillPending === 3, `${stillPending}/3`);
tight.p.kill("SIGKILL");

// Those rows are still deliverable afterwards.
await callFn({ retry_sweep: true });
const recovered = Number((await q(
  "SELECT count(*) AS c FROM school.notifications WHERE id = ANY($1::uuid[]) AND status='sent'", [budgetIds]))[0].c);
check("released rows are delivered by the next sweep", recovered === 3, `${recovered}/3`);

console.log("\n--- 7. NaJiki's delivery report finds what the function stored ---");

await ensureFunds(SCHOOL, 600);

await resetSmsLog();
const deliverId = await queueSms("Delivery report target.", { recipient: "+256772123480" });
await callFn({ notification_id: deliverId });
const deliverRow = await notif(deliverId);
const deliverBody = JSON.stringify({
  eventType: "SMS_DELIVERY_UPDATE",
  smsId: deliverRow.provider_ref,
  reference: deliverRow.provider_response?.reference,
  status: "delivered",
  providerId: "ATXid_" + crypto.randomBytes(4).toString("hex"),
  recipient: "+256772123480",
  applicationCode: "school",
});
const delivered = await fetch(BASE + "/api/webhooks/najiki", {
  method: "POST", body: deliverBody, headers: signWebhook(WEBHOOK_SECRET, deliverBody),
});
const deliveredStatus = (await q("SELECT status FROM school.notifications WHERE id=$1", [deliverId]))[0].status;
check("the app's webhook accepts their delivery report", delivered.status === 200, `HTTP ${delivered.status}`);
check("and matches the row through provider_ref", deliveredStatus === "sent", deliveredStatus);

console.log("\n--- 8. Nothing above touched the Next.js app for sending ---");
const appUp = await fetch(BASE + "/login").then((r) => r.status === 200).catch(() => false);
check("the app is up and never handled a send", appUp);

await db.end();
stopAll();
console.log(`\n=== SMS EDGE E2E [${LABEL}]: ${fail === 0 ? "ALL CHECKS PASSED" : fail + " FAILED"} ===`);
process.exit(fail === 0 ? 0 : 1);
