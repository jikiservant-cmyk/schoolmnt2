// Adversarial stress test of the DEPLOYED sender (send-attendance-sms).
//
// The contract suite proves the happy path. This one tries to break it:
//
//   1. two workers dispatching the SAME notification at the same moment
//   2. a retry sweep and a single dispatch racing on the same row
//   3. a wallet that can only afford half the batch, hit by 10 parallel sends
//   4. a gateway that answers 200 with a failure payload
//   5. a gateway that answers 202 with no smsId
//   6. a gateway that is too slow (the function's own timeout path)
//   7. a message that is too long to ever be delivered (money hole?)
//   8. a school whose wallet is keyed by school_id, not tenant_id
//   9. malformed bodies and hostile payloads
//  10. delivery-report replay
//
// Usage: node sms-edge-stress-check.mjs [base] [appDir] [label]
// Env:   DENO_BIN, PORT_DENO (default 8000), SKIP_SEED=1
import crypto from "crypto";
import fs from "fs";
import pg from "pg";
import { execSync, spawn } from "child_process";
import net from "node:net";
import seedMod from "./seed.js";

const { IDS: { A: SA, B: SB } } = seedMod;
const SCHOOL = SA.school;
const SCHOOL_B = SB.school;
const [BASE = "http://127.0.0.1:3000", , LABEL = "run"] = process.argv.slice(2);
const SHIM = "http://127.0.0.1:54321";
const API_KEY = process.env.NAJIKI_API_KEY || "lab-najiki-secret";
const WEBHOOK_SECRET = process.env.NAJIKI_WEBHOOK_SECRET || "lab-dedicated-webhook-secret-123";
const DISPATCH = "lab-stress-" + crypto.randomBytes(6).toString("hex");
const PRICE = 30;
const FN_PORT = Number(process.env.PORT_DENO || 8000);
const DENO = process.env.DENO_BIN || "deno";
const FN_ENTRY = "/home/user/schoolmnt2/supabase/functions/send-attendance-sms/index.ts";

let fail = 0;
const check = (name, pass, detail = "") => {
  if (!pass) fail++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
};
const note = (msg) => console.log(`      ${msg}`);

try {
  execSync(`${DENO} --version`, { stdio: "ignore" });
} catch {
  console.log("\n=== SMS STRESS: SKIPPED (deno not installed) ===");
  process.exit(0);
}

if (!process.env.SKIP_SEED) {
  execSync("node seed.js", { cwd: "/home/user/mt-lab", stdio: "ignore", env: { ...process.env, RLS: "1" } });
}
await fetch(SHIM + "/__reload", { method: "POST" });

const db = new pg.Client({ host: "127.0.0.1", port: 54329, user: "postgres", password: "pw", database: "mtlab" });
await db.connect();
const q = async (s, p) => (await db.query(s, p)).rows;

// ---------------------------------------------------------------- harness ---
const waitPort = async (port, want, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const up = await new Promise((resolve) => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => { sock.destroy(); resolve(false); });
    });
    if (up === want) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
};

const procs = [];
const startFn = async (extraEnv = {}) => {
  const env = {
    ...process.env,
    SUPABASE_URL: SHIM,
    SUPABASE_SERVICE_ROLE_KEY: "lab-service-key",
    NAJIKI_DOMAIN: SHIM,
    NAJIKI_API_KEY: API_KEY,
    DISPATCH_SECRET: DISPATCH,
    SMS_COST: String(PRICE),
    NAJIKI_API_URL: "",
    ...extraEnv,
  };
  const p = spawn(DENO, ["run", "--allow-net", "--allow-env", FN_ENTRY], { env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  p.stdout.on("data", (d) => logs.push(String(d)));
  p.stderr.on("data", (d) => logs.push(String(d)));
  procs.push(p);
  if (!(await waitPort(FN_PORT, true))) throw new Error(`function did not start\n${logs.join("")}`);
  return { p, logs };
};
const stopAll = () => { for (const p of procs) { try { p.kill("SIGKILL"); } catch {} } };
process.on("exit", stopAll);

const callFn = (payload, headers = {}) =>
  fetch(`http://127.0.0.1:${FN_PORT}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DISPATCH}`, ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

const queueSms = async (message, opts = {}) => {
  const {
    school = SCHOOL, recipient = "+2567721234" + String(Math.floor(Math.random() * 90) + 10),
    status = "pending", retryCount = 0, nextRetryAt = null, providerResponse = null,
  } = opts;
  const rows = await q(
    `INSERT INTO school.notifications(school_id, channel, notification_type, message, status,
        recipient_phone_snapshot, recipient_type, dedupe_key, retry_count, next_retry_at, provider_response)
     VALUES ($1,'sms','attendance_check_in',$2,$3,$4,'parent',$5,$6,$7,$8) RETURNING id`,
    [school, message, status, recipient, "att:" + crypto.randomUUID(), retryCount, nextRetryAt,
      providerResponse === null ? null : JSON.stringify(providerResponse)],
  );
  return rows[0].id;
};
const notif = async (id) => (await q(
  "SELECT status, retry_count, next_retry_at, error, provider_response FROM school.notifications WHERE id=$1", [id]))[0];
const balance = async (school) => Number((await q(
  "SELECT coalesce(sum(balance),0) AS b FROM public.wallets WHERE tenant_id=$1 OR school_id=$1", [school]))[0].b);
const setBalance = async (school, v) =>
  q("UPDATE public.wallets SET balance=$2 WHERE tenant_id=$1 OR school_id=$1", [school, v]);
const debits = async (id) => Number((await q(
  "SELECT count(*) AS c FROM public.transactions WHERE reference=$1", ["sms:" + id]))[0].c);
const smsLog = async () => (await fetch(SHIM + "/__najiki/sms-log")).json();
const resetSmsLog = () => fetch(SHIM + "/__najiki/sms-log", { method: "DELETE" });
const realMessages = async () => (await smsLog()).filter((m) => !m.injected);
const makeDue = (id) => q("UPDATE school.notifications SET next_retry_at = now() - interval '1 minute' WHERE id=$1", [id]);

console.log("\n--- 1. Two workers, same notification, at the same moment ---");

await startFn();
await setBalance(SCHOOL, 1000);
await resetSmsLog();
const raceId = await queueSms("Race: Alice checked in.");
const racers = await Promise.all([callFn({ notification_id: raceId }), callFn({ notification_id: raceId })]);
const racerBodies = await Promise.all(racers.map((r) => r.json()));
const raceRow = await notif(raceId);
const raceMessages = (await realMessages()).filter((m) => String(m.body?.smsId) === raceId);
check("exactly one worker won the claim", racerBodies.filter((b) => b.success === true).length === 1,
  JSON.stringify(racerBodies));
check("the row ended sent", raceRow.status === "sent", raceRow.status);
check("the school was charged exactly once", (await debits(raceId)) === 1, String(await debits(raceId)));
check("the gateway received exactly one message", raceMessages.length === 1, `messages=${raceMessages.length}`);
check("balance moved by one price only", (await balance(SCHOOL)) === 1000 - PRICE, String(await balance(SCHOOL)));

console.log("\n--- 2. Sweep and single dispatch racing on the same row ---");

await setBalance(SCHOOL, 1000);
await resetSmsLog();
const mixedId = await queueSms("Race: sweep vs dispatch.");
const both = await Promise.all([
  callFn({ retry_sweep: true }),
  callFn({ notification_id: mixedId }),
]);
await Promise.all(both.map((r) => r.json().catch(() => ({}))));
const mixedRow = await notif(mixedId);
const mixedMessages = (await realMessages()).filter((m) => String(m.body?.smsId) === mixedId);
check("the row is sent once", mixedRow.status === "sent", mixedRow.status);
check("charged exactly once", (await debits(mixedId)) === 1, String(await debits(mixedId)));
check("one message only", mixedMessages.length === 1, `messages=${mixedMessages.length}`);

console.log("\n--- 3. A wallet that can only afford half the batch, 10 parallel sends ---");

await setBalance(SCHOOL, PRICE * 5);
await resetSmsLog();
const batch = [];
for (let i = 0; i < 10; i++) batch.push(await queueSms(`Batch ${i}.`));
await Promise.all(batch.map((id) => callFn({ notification_id: id })));
const batchRows = [];
for (const id of batch) batchRows.push(await notif(id));
const sent = batchRows.filter((r) => r.status === "sent").length;
const pendingOrFailed = batchRows.filter((r) => r.status !== "sent").length;
const endBalance = await balance(SCHOOL);
const paidRows = [];
for (const id of batch) paidRows.push(await debits(id));
check("exactly as many messages were sent as the wallet could pay for", sent === 5, `sent=${sent}`);
check("the rest were not sent", pendingOrFailed === 5, `not-sent=${pendingOrFailed}`);
check("the wallet never went negative", endBalance >= 0, String(endBalance));
check("it ended at zero, not below", endBalance === 0, String(endBalance));
check("no notification was charged twice", paidRows.every((c) => c <= 1), JSON.stringify(paidRows));
check("total debits equal total messages", paidRows.reduce((a, b) => a + b, 0) === sent,
  `${paidRows.reduce((a, b) => a + b, 0)} vs ${sent}`);

console.log("\n--- 4. Gateway answers 200, but the payload says it failed ---");

await setBalance(SCHOOL, 1000);
await resetSmsLog();
const liarId = await queueSms("Liars [LAB_SMS_200_ERROR] welcome.");
await callFn({ notification_id: liarId });
const liar = await notif(liarId);
check("a 200 with success:false is NOT recorded as sent", liar.status !== "sent",
  `${liar.status} / ${liar.error}`);
if (liar.status === "sent") note("FINDING: res.ok alone decides success, so the message is lost silently.");

console.log("\n--- 5. Gateway answers 202 with no smsId ---");

await setBalance(SCHOOL, 1000);
await resetSmsLog();
const bareId = await queueSms("Bare ack [LAB_SMS_NO_SMSID] here.");
await callFn({ notification_id: bareId });
const bare = await notif(bareId);
check("a 202 without an smsId is not treated as a delivered message", bare.status !== "sent",
  `${bare.status} / ${bare.error}`);
if (bare.status === "sent") note("FINDING: marked sent with no provider id to match a delivery report against.");

console.log("\n--- 6. Gateway too slow: the function's own timeout ---");

// A dedicated instance with a 1s timeout so the test does not wait 30s.
procs[procs.length - 1].kill("SIGKILL");
await waitPort(FN_PORT, false);
await startFn({ NAJIKI_TIMEOUT_MS: "1000" });
await setBalance(SCHOOL, 1000);
await resetSmsLog();
const slowId = await queueSms("Slow [LAB_SMS_SLOW] gateway.");
const slowStart = Date.now();
await callFn({ notification_id: slowId });
const slowElapsed = Date.now() - slowStart;
const slow = await notif(slowId);
check("the timeout is respected (well under the gateway's delay)",
  slowElapsed < 2400, `${slowElapsed}ms`);
check("a timed-out send stays pending for retry", slow.status === "pending", slow.status);
check("the failure is recorded as a provider error",
  /provider_timeout|fetch_error/.test(String(slow.error)), String(slow.error));
check("retry_count was incremented", Number(slow.retry_count) === 1, String(slow.retry_count));
check("and it was charged only once", (await debits(slowId)) === 1, String(await debits(slowId)));

procs[procs.length - 1].kill("SIGKILL");
await waitPort(FN_PORT, false);
await startFn();

console.log("\n--- 7. Content that can never be delivered ---");

await setBalance(SCHOOL, 1000);
await resetSmsLog();
const hugeId = await queueSms("X".repeat(2000));
await callFn({ notification_id: hugeId });
const huge = await notif(hugeId);
check("an over-length message is not silently charged forever",
  huge.status !== "sent" && (await debits(hugeId)) === 0,
  `status=${huge.status} debits=${await debits(hugeId)} error=${huge.error}`);
if ((await debits(hugeId)) > 0) note("FINDING: charged for a message the gateway can never accept.");

await resetSmsLog();
const emptyId = await queueSms("");
await callFn({ notification_id: emptyId });
const empty = await notif(emptyId);
check("an empty message is not charged", (await debits(emptyId)) === 0,
  `status=${empty.status} debits=${await debits(emptyId)}`);

console.log("\n--- 8. Wallet keyed by school_id, not tenant_id ---");

const schoolOnly = crypto.randomUUID();
await q("INSERT INTO public.wallets(id, tenant_id, school_id, balance, currency) VALUES ($1,NULL,$2,$3,'UGX')",
  [crypto.randomUUID(), schoolOnly, 1000]);
await resetSmsLog();
const soId = await queueSms("Wallet keyed by school_id.", { school: schoolOnly, recipient: "+256772124001" });
await callFn({ notification_id: soId });
const so = await notif(soId);
check("a school_id-keyed wallet is still found (the sender looks up tenant_id only)",
  so.status === "sent", `${so.status} / ${so.error}`);
if (so.status !== "sent") note("FINDING: wallet lookup is tenant_id-only, so these schools can never send SMS.");

console.log("\n--- 9. Hostile and malformed payloads ---");

await resetSmsLog();
const malformed = await callFn("{not json");
check("malformed JSON is rejected without a crash", malformed.status >= 400 && malformed.status < 500,
  `HTTP ${malformed.status}`);
const weird = await callFn({ notification_id: { $ne: null } });
check("a non-string notification id is refused", weird.status === 400, `HTTP ${weird.status}`);
const injection = await callFn({ notification_id: "' OR 1=1 --" });
check("a SQL-ish id is treated as an id, not a query", injection.status === 200, `HTTP ${injection.status}`);
const bigId = await callFn({ notification_id: "x".repeat(5000) });
check("a 5000-char id does not 500", bigId.status < 500, `HTTP ${bigId.status}`);

console.log("\n--- 10. Delivery reports, replayed ---");

await setBalance(SCHOOL, 1000);
await resetSmsLog();
const delId = await queueSms("Delivery replay target.", { recipient: "+256772124002" });
await callFn({ notification_id: delId });
const sign = (body) => {
  const t = Date.now();
  const v = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  return { "Content-Type": "application/json", "x-najiki-signature": `t=${t},v=${v}` };
};
const evt = JSON.stringify({ eventType: "SMS_DELIVERY_UPDATE", smsId: delId, status: "delivered", recipient: "+256772124002" });
const r1 = await fetch(BASE + "/api/webhooks/najiki", { method: "POST", body: evt, headers: sign(evt) });
const r2 = await fetch(BASE + "/api/webhooks/najiki", { method: "POST", body: evt, headers: sign(evt) });
const delRow = await notif(delId);
check("a delivery report is accepted", r1.status === 200, `HTTP ${r1.status}`);
check("a replayed delivery report is accepted (idempotent)", r2.status === 200, `HTTP ${r2.status}`);
check("the row stays sent", delRow.status === "sent", delRow.status);
check("and is not charged again", (await debits(delId)) === 1, String(await debits(delId)));

console.log("\n--- 11. Money taken but nothing delivered: marked, and refundable ---");

await setBalance(SCHOOL, 1000);
await resetSmsLog();
// Charge succeeds, then the gateway keeps failing until the cap.
const lostId = await queueSms("Never lands [LAB_SMS_503] at all.", { retryCount: 4 });
await callFn({ notification_id: lostId });
const lost = await notif(lostId);
check("a terminal failure after a charge is marked charged_undelivered",
  lost.status === "failed" && String(lost.error).startsWith("charged_undelivered:"),
  `${lost.status} / ${lost.error}`);
check("the charge really happened", (await debits(lostId)) === 1, String(await debits(lostId)));

// An uncharged terminal failure must NOT carry that marker.
const poorId2 = await queueSms("No money here.", { retryCount: 4, school: SCHOOL_B, recipient: "+256772999555" });
await q("UPDATE public.wallets SET balance=0 WHERE tenant_id=$1 OR school_id=$1", [SCHOOL_B]);
await callFn({ notification_id: poorId2 });
const poor2 = await notif(poorId2);
check("an uncharged terminal failure carries no charge marker",
  poor2.status === "failed" && !String(poor2.error).startsWith("charged_undelivered:"),
  `${poor2.status} / ${poor2.error}`);

// Refund it, exactly once.
const balBeforeRefund = await balance(SCHOOL);
const refund1 = (await q("SELECT public.refund_sms_charge($1) AS r", [lostId]))[0].r;
const refund2 = (await q("SELECT public.refund_sms_charge($1) AS r", [lostId]))[0].r;
check("the refund credits the school", refund1.outcome === "refunded" && refund1.amount === PRICE,
  JSON.stringify(refund1));
check("the money is back on the wallet", (await balance(SCHOOL)) === balBeforeRefund + PRICE,
  `${balBeforeRefund} -> ${await balance(SCHOOL)}`);
check("refunding twice is refused", refund2.outcome === "duplicate", JSON.stringify(refund2));
check("a second refund does not credit again", (await balance(SCHOOL)) === balBeforeRefund + PRICE,
  String(await balance(SCHOOL)));
const noCharge = (await q("SELECT public.refund_sms_charge($1) AS r", [poorId2]))[0].r;
check("refunding a never-charged row is a no-op", noCharge.outcome === "no_charge", JSON.stringify(noCharge));

console.log("\n--- 12. Backoff honours the gateway, and the sweep has a budget ---");

await setBalance(SCHOOL, 1000);
await resetSmsLog();
const backoffId = await queueSms("Rate limited [LAB_SMS_429] hard.");
await callFn({ notification_id: backoffId });
const backoff = await notif(backoffId);
const dueInSec = (new Date(backoff.next_retry_at).getTime() - Date.now()) / 1000;
check("Retry-After (2 s) is honoured instead of a flat 3 minutes",
  dueInSec > 0 && dueInSec <= 30, `${dueInSec.toFixed(1)}s`);

const beforeBudget = procs[procs.length - 1];
beforeBudget.kill("SIGKILL");
await waitPort(FN_PORT, false);
const budgetFn = await startFn({ SMS_SWEEP_BUDGET_MS: "1" });
await setBalance(SCHOOL, 1000);
await resetSmsLog();
const budgetIds = [];
for (let i = 0; i < 4; i++) budgetIds.push(await queueSms(`Sweep budget ${i}.`));
const budgetRes = await (await callFn({ retry_sweep: true })).json();
check("the sweep stops early instead of running into the platform timeout",
  budgetRes.stopped_early === true && Number(budgetRes.dispatched) <= 1, JSON.stringify(budgetRes));
const stillPending = Number((await q(
  "SELECT count(*) AS c FROM school.notifications WHERE id = ANY($1::uuid[]) AND status='pending'", [budgetIds]))[0].c);
check("the rows it did not reach are still queued", stillPending >= 3, `${stillPending}/4`);
budgetFn.p.kill("SIGKILL");
const reallyClosed = await waitPort(FN_PORT, false);
check("the budgeted function is really gone before the restart", reallyClosed, String(reallyClosed));
const fresh = await startFn({ SMS_SWEEP_BUDGET_MS: "45000" });
const drained = await (await callFn({ retry_sweep: true })).json();
check("with a normal budget the next sweep runs to completion",
  drained.stopped_early === false && Number(drained.dispatched) === 4,
  `${JSON.stringify(drained)} pid=${fresh.p.pid} ${fresh.logs.join("").slice(-300)}`);
const sentAfter = Number((await q(
  "SELECT count(*) AS c FROM school.notifications WHERE id = ANY($1::uuid[]) AND status='sent'", [budgetIds]))[0].c);
check("the rows the budgeted sweep skipped are delivered by the next one", sentAfter === 4, `${sentAfter}/4`);

await db.end();
stopAll();
console.log(`\n=== SMS STRESS [${LABEL}]: ${fail === 0 ? "ALL CHECKS PASSED" : fail + " FAILED"} ===`);
process.exit(fail === 0 ? 0 : 1);
