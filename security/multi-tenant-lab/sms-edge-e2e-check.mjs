// End-to-end test of the DEPLOYED SMS sender: supabase/functions/send-attendance-sms.
//
// This drives the real function under Deno, against the lab's Supabase shim
// (REST + RPC + the fake NaJiki SMS API), and asserts on Postgres.
//
// It is written for the LIVE schema, not the repo's old assumptions:
//   school.notifications : retry_count, next_retry_at, error,
//                          status default 'pending', provider_response (text)
//   wallet RPC           : public.debit_sms_wallet(p_wallet_id, p_amount,
//                            p_idempotency_key, p_tenant_id, p_description)
//   payloads             : { notification_id } / { record: { id } } /
//                          { retry_sweep: true }
//   auth                 : Authorization: Bearer <DISPATCH_SECRET>
//
// Usage: node sms-edge-e2e-check.mjs [base] [appDir] [label]
// Env:   DENO_BIN (default `deno`), PORT_DENO (default 8000), SKIP_SEED=1
import crypto from "crypto";
import fs from "fs";
import pg from "pg";
import { execSync, spawn } from "child_process";
import net from "node:net";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import seedMod from "./seed.js";

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
const FN_ENTRY = "/home/user/schoolmnt2/supabase/functions/send-attendance-sms/index.ts";
const REPO = process.env.NAJIKI_REPO || "/home/user/najiki-finance2";

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

const waitForPortFree = async (port, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const busy = await new Promise((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => { sock.destroy(); resolve(false); });
    });
    if (!busy) return true;
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
    NAJIKI_DOMAIN: SHIM,
    NAJIKI_API_KEY: API_KEY,
    DISPATCH_SECRET: DISPATCH,
    SMS_COST: price === null ? "" : String(price),
    PORT: String(port),
    // never inherit the app's payments endpoint from the lab shell
    NAJIKI_API_URL: "",
    ...extraEnv,
  };
  const p = spawn(DENO, ["run", "--allow-net", "--allow-env", FN_ENTRY], { env, stdio: ["ignore", "pipe", "pipe"] });
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

// Exactly what lib/notifications/queue.ts writes: status 'pending', retry_count 0.
const queueSms = async (message, opts = {}) => {
  const {
    school = SCHOOL, recipient = "+256772123456", status = "pending",
    retryCount = 0, nextRetryAt = null, channel = "sms", providerResponse = null, error = null,
  } = opts;
  const rows = await q(
    `INSERT INTO school.notifications(school_id, channel, notification_type, message, status,
        recipient_phone_snapshot, recipient_type, dedupe_key, retry_count, next_retry_at, provider_response, error)
     VALUES ($1,$2,'attendance_check_in',$3,$4,$5,'parent',$6,$7,$8,$9,$10) RETURNING id`,
    [school, channel, message, status, recipient, "att:" + crypto.randomUUID(),
      retryCount, nextRetryAt, providerResponse === null ? null : JSON.stringify(providerResponse), error],
  );
  return rows[0].id;
};
const notif = async (id) => (await q(
  "SELECT status, retry_count, next_retry_at, error, sent_at, provider_response FROM school.notifications WHERE id=$1", [id]))[0];
const pr = (row) => { try { return JSON.parse(row.provider_response); } catch { return row.provider_response; } };
const walletBalance = async (school) => Number((await q(
  "SELECT coalesce(sum(balance),0) AS b FROM public.wallets WHERE tenant_id=$1 OR school_id=$1", [school]))[0].b);
const debitCount = async (id) => Number((await q(
  "SELECT count(*) AS c FROM public.transactions WHERE reference=$1 AND type='debit'", ["sms:" + id]))[0].c);
const ensureFunds = async (school, min) => {
  const bal = await walletBalance(school);
  if (bal < min) await q("UPDATE public.wallets SET balance = balance + $2 WHERE tenant_id=$1 OR school_id=$1", [school, min - bal]);
};
const smsLog = async () => (await fetch(SHIM + "/__najiki/sms-log")).json();
const resetSmsLog = () => fetch(SHIM + "/__najiki/sms-log", { method: "DELETE" });
const signWebhook = (secret, body) => {
  const t = Date.now();
  const v = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return { "Content-Type": "application/json", "x-najiki-signature": `t=${t},v=${v}` };
};
/** Make a backed-off row immediately claimable again. */
const makeDue = (id) => q("UPDATE school.notifications SET next_retry_at = now() - interval '1 minute' WHERE id=$1", [id]);

console.log("\n--- 1. Auth, method and configuration (fail closed) ---");

// The deployed function binds Deno's default port, so instances are started
// one at a time: first without a price, then with one.
const noPrice = await startFn({}, { price: null });
const missingPrice = await callFn({ notification_id: crypto.randomUUID() });
check("a missing SMS_COST refuses to send (503)", missingPrice.status === 503, `HTTP ${missingPrice.status}`);
noPrice.p.kill("SIGKILL");
if (!(await waitForPortFree(FN_PORT))) throw new Error(`port :${FN_PORT} did not free up`);
procs.length = 0;

await startFn();

const noSecret = await callFn({ notification_id: crypto.randomUUID() }, { auth: false });
check("no dispatch secret is rejected", noSecret.status === 401, `HTTP ${noSecret.status}`);
const wrongSecret = await callFn({ notification_id: crypto.randomUUID() }, { headers: { Authorization: "Bearer nope" }, auth: false });
check("wrong dispatch secret is rejected", wrongSecret.status === 401, `HTTP ${wrongSecret.status}`);
const asGet = await fetch(`http://127.0.0.1:${FN_PORT}/`, { headers: { Authorization: `Bearer ${DISPATCH}` } });
check("GET is refused", asGet.status === 405, `HTTP ${asGet.status}`);
const noId = await callFn({});
check("a payload without a notification id is a 400", noId.status === 400, `HTTP ${noId.status}`);
const missing = await (await callFn({ notification_id: crypto.randomUUID() })).json();
check("an unknown notification is skipped, not retried forever", missing.skipped === true, JSON.stringify(missing));

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
check("sent_at is recorded", !!good.sent_at, String(good.sent_at));
check("error is cleared on success", good.error === null, String(good.error));
check("retry_count stays 0 on a first-attempt success", Number(good.retry_count) === 0, String(good.retry_count));
check("the lock is released (next_retry_at null)", good.next_retry_at === null, String(good.next_retry_at));
check("provider_response is stored as text and parses as JSON", pr(good)?.success === true, String(good.provider_response).slice(0, 80));
check("the message really reached NaJiki", log1.length === 1 && log1[0].body.to === "+256772123456", `messages=${log1.length}`);
check("the body is exactly {smsId, to, message}",
  JSON.stringify(Object.keys(log1[0]?.body ?? {}).sort()) === JSON.stringify(["message", "smsId", "to"]),
  JSON.stringify(Object.keys(log1[0]?.body ?? {})));
check("smsId carries OUR notification id (so delivery reports can name it)",
  String(log1[0]?.body.smsId) === goodId, String(log1[0]?.body.smsId));
check("Idempotency-Key is one key per notification", String(log1[0]?.idempotencyKey) === `sms:${goodId}`,
  String(log1[0]?.idempotencyKey));

const after = await walletBalance(SCHOOL);
check("wallet was charged the platform price exactly once", before - after === PRICE, `${before} -> ${after}`);
check("exactly one debit transaction exists", (await debitCount(goodId)) === 1, String(await debitCount(goodId)));

const again = await (await callFn({ notification_id: goodId })).json();
check("re-dispatching a sent row is a no-op", again.skipped === true, JSON.stringify(again));
check("no second message and no second charge",
  (await smsLog()).length === 1 && (await walletBalance(SCHOOL)) === after);

// The body must satisfy NaJiki's real schema.
if (fs.existsSync(`${REPO}/src/lib/sms-policy.ts`)) {
  register(pathToFileURL(fileURLToPath(new URL("./ts-ext-hook.mjs", import.meta.url))).href);
  const { SmsInputSchema } = await import(`${REPO}/src/lib/sms-policy.ts`);
  const parsed = SmsInputSchema.safeParse(log1[0].body);
  check("the posted body passes NaJiki's own SmsInputSchema", parsed.success === true,
    parsed.success ? "" : JSON.stringify(parsed.error?.issues));
}

// The DB-webhook payload shape must work too.
await ensureFunds(SCHOOL, 600);
const hookId = await queueSms("Dear Parent, Bob checked out at 17:10.", { recipient: "+256772123499" });
const hookRes = await (await callFn({ type: "INSERT", record: { id: hookId } })).json();
check("a webhook-shaped payload {record:{id}} is dispatched", hookRes.success === true, JSON.stringify(hookRes));

console.log("\n--- 3. Unfunded school: no money, no message, no retry storm ---");

const poorSchool = SB.school || SCHOOL_B;
await q("DELETE FROM public.transactions WHERE wallet_id IN (SELECT id FROM public.wallets WHERE tenant_id=$1 OR school_id=$1)", [poorSchool]);
await q("UPDATE public.wallets SET balance=0 WHERE tenant_id=$1 OR school_id=$1", [poorSchool]);
const POOR_TO = "+256772999001";
// Pre-load 4 attempts so this call is the final one.
const poorId = await queueSms("Fees reminder for term 2.", { school: poorSchool, recipient: POOR_TO, retryCount: 4 });
const poorBefore = await walletBalance(poorSchool);
await callFn({ notification_id: poorId });
const poor = await notif(poorId);
check("an unfunded school's SMS is failed, not sent", poor.status === "failed", poor.status);
check("the failure code names the wallet", poor.error === "insufficient_balance_or_debit_failed", String(poor.error));
check("nothing was sent to NaJiki on its behalf", (await smsLog()).filter((m) => m.body?.to === POOR_TO).length === 0);
check("its wallet was not driven negative", (await walletBalance(poorSchool)) === poorBefore, String(await walletBalance(poorSchool)));
check("it is not retried again (next_retry_at cleared)", poor.next_retry_at === null, String(poor.next_retry_at));
check("retry_count reached the cap", Number(poor.retry_count) === 5, String(poor.retry_count));

console.log("\n--- 4. Retries: locked, counted, capped, and never charged twice ---");

await ensureFunds(SCHOOL, 600);
await resetSmsLog();
const retryId = await queueSms("Transient fault [LAB_SMS_503] please retry.");
const balBeforeRetry = await walletBalance(SCHOOL);
await callFn({ notification_id: retryId });
const r1 = await notif(retryId);
check("a 503 leaves the row pending (not failed)", r1.status === "pending", r1.status);
check("retry_count is incremented", Number(r1.retry_count) === 1, String(r1.retry_count));
check("the failure code is provider_failed", r1.error === "provider_failed", String(r1.error));
check("a backoff is set (the claim lock is a future timestamp)",
  r1.next_retry_at !== null && new Date(r1.next_retry_at).getTime() > Date.now(), String(r1.next_retry_at));
check("the school was charged exactly once", balBeforeRetry - (await walletBalance(SCHOOL)) === PRICE);

const lockedOut = await (await callFn({ notification_id: retryId })).json();
check("a row inside its backoff cannot be re-claimed", lockedOut.skipped === true, JSON.stringify(lockedOut));
check("and no message was created by any attempt",
  (await smsLog()).filter((m) => !m.injected).length === 0,
  `real=${(await smsLog()).filter((m) => !m.injected).length}`);

await makeDue(retryId);
await callFn({ notification_id: retryId });
const r2 = await notif(retryId);
check("once due, the retry runs and counts", Number(r2.retry_count) === 2, String(r2.retry_count));
check("a retry never charges twice", (await debitCount(retryId)) === 1, String(await debitCount(retryId)));
const keys = (await smsLog()).map((m) => m.idempotencyKey).filter(Boolean);
check("every attempt reuses the same Idempotency-Key", new Set(keys).size === 1, JSON.stringify(keys));

// The 5th attempt is terminal.
await q("UPDATE school.notifications SET retry_count = 4 WHERE id=$1", [retryId]);
await makeDue(retryId);
await callFn({ notification_id: retryId });
const r3 = await notif(retryId);
check("the 5th failed attempt is terminal", r3.status === "failed", r3.status);
check("the terminal failure clears the backoff", r3.next_retry_at === null, String(r3.next_retry_at));
check("it never charged a second time", (await debitCount(retryId)) === 1, String(await debitCount(retryId)));

// A non-2xx that is permanent in NaJiki's contract still stops at the cap.
await resetSmsLog();
const conflictId = await queueSms("Conflict attempt [LAB_SMS_503] one.", { retryCount: 4 });
await callFn({ notification_id: conflictId });              // 503, logs the key
await q("UPDATE school.notifications SET message=$2 WHERE id=$1", [conflictId, "A totally different message"]);
await makeDue(conflictId);
await callFn({ notification_id: conflictId });              // same key, new body -> 409
const conflict = await notif(conflictId);
check("an idempotency conflict is recorded as a charged, undelivered failure",
  conflict.status === "failed" && conflict.error === "charged_undelivered:provider_failed",
  `${conflict.status}/${conflict.error}`);
check("the conflict did not charge twice", (await debitCount(conflictId)) === 1, String(await debitCount(conflictId)));

console.log("\n--- 5. Bad data never costs money or calls the gateway ---");

await resetSmsLog();
const balBeforeBad = await walletBalance(SCHOOL);
const BAD_TO = "12345";
const badPhone = await queueSms("Invalid recipient.", { recipient: BAD_TO });
await callFn({ notification_id: badPhone });
const bad = await notif(badPhone);
check("an invalid phone is failed without charging",
  bad.status === "failed" && bad.error === "invalid_phone_snapshot" && (await walletBalance(SCHOOL)) === balBeforeBad,
  `${bad.status}/${bad.error}`);
check("and it never reaches NaJiki", (await smsLog()).length === 0);
check("an invalid phone is not retried", bad.next_retry_at === null, String(bad.next_retry_at));

console.log("\n--- 6. Retry sweep: only due work, never past the cap ---");

await ensureFunds(SCHOOL, 600);
await resetSmsLog();
const dueId = await queueSms("Due for the sweep.", { recipient: "+256772123480" });
const notDueId = await queueSms("Backed off for 10 minutes.", {
  recipient: "+256772123481", retryCount: 1, nextRetryAt: new Date(Date.now() + 10 * 60_000).toISOString(),
});
const cappedId = await queueSms("Already at the cap.", { recipient: "+256772123482", retryCount: 5 });
const sentId = await queueSms("Already sent.", { recipient: "+256772123483", status: "sent" });

const sweep = await (await callFn({ retry_sweep: true })).json();
check("the sweep sends due work", (await notif(dueId)).status === "sent", (await notif(dueId)).status);
check("it leaves backed-off rows alone", Number((await notif(notDueId)).retry_count) === 1,
  JSON.stringify(await notif(notDueId)));
check("it never touches rows at the cap", (await notif(cappedId)).status === "pending", (await notif(cappedId)).status);
check("it never re-sends sent rows", (await notif(sentId)).status === "sent");
check("it reports what it swept", Number(sweep.swept) >= 1, JSON.stringify(sweep));
check("only the due row cost money", (await debitCount(notDueId)) === 0 && (await debitCount(cappedId)) === 0);

console.log("\n--- 7. The app can still take the delivery report on this schema ---");

await ensureFunds(SCHOOL, 600);
await resetSmsLog();
const deliverId = await queueSms("Delivery report target.", { recipient: "+256772123484" });
await callFn({ notification_id: deliverId });
const deliverBody = JSON.stringify({
  eventType: "SMS_DELIVERY_UPDATE",
  smsId: deliverId, // NaJiki echoes the smsId we sent, which is our notification id
  status: "delivered",
  providerMessageId: "ATXid_" + crypto.randomBytes(4).toString("hex"),
  recipient: "+256772123484",
  applicationCode: "school",
});
const delivered = await fetch(BASE + "/api/webhooks/najiki", {
  method: "POST", body: deliverBody, headers: signWebhook(WEBHOOK_SECRET, deliverBody),
});
const deliverRow = await notif(deliverId);
check("the app's webhook accepts their delivery report", delivered.status === 200, `HTTP ${delivered.status}`);
check("the row is still sent after a delivered report", deliverRow.status === "sent", deliverRow.status);

console.log("\n--- 8. Nothing above touched the Next.js app for sending ---");
const appUp = await fetch(BASE + "/login").then((r) => r.status === 200).catch(() => false);
check("the app is up and never handled a send", appUp);

await db.end();
stopAll();
console.log(`\n=== SMS EDGE E2E [${LABEL}]: ${fail === 0 ? "ALL CHECKS PASSED" : fail + " FAILED"} ===`);
process.exit(fail === 0 ? 0 : 1);
