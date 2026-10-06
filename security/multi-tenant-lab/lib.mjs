// Shared helpers for the multi-tenant attack harness.
import fs from 'fs';
export const SHIM = 'http://127.0.0.1:54321';

export async function setupUsers() {
  await fetch(SHIM + '/__users', { method: 'POST', body: JSON.stringify({
    'adminA@lab.io': { id: 'aaaaaaaa-0000-4000-8000-0000000000a1', email: 'adminA@lab.io', password: 'Passw0rd!' },
    'adminB@lab.io': { id: 'bbbbbbbb-0000-4000-8000-0000000000a1', email: 'adminB@lab.io', password: 'Passw0rd!' },
    'teacherA@lab.io': { id: 'aaaaaaaa-0000-4000-8000-0000000000a2', email: 'teacherA@lab.io', password: 'Passw0rd!' },
  }) });
}
export async function sessionCookie(email) {
  const s = await (await fetch(SHIM + '/__session', { method: 'POST', body: JSON.stringify({ email }) })).json();
  return 'sb-127-auth-token=base64-' + Buffer.from(JSON.stringify(s)).toString('base64url');
}

// Map exported action name -> [{id, file, page}] from the server reference manifest.
export function actionIds(appDir) {
  const m = JSON.parse(fs.readFileSync(appDir + '/.next/server/server-reference-manifest.json', 'utf8'));
  const out = {};
  for (const [id, info] of Object.entries(m.node || {})) {
    // Production builds: numeric moduleIds, but the name/file are listed directly.
    if (info.exportedName) {
      for (const worker of Object.keys(info.workers || {})) (out[info.exportedName] = out[info.exportedName] || []).push({ id, file: info.filename, page: worker });
      continue;
    }
    for (const [worker, w] of Object.entries(info.workers || {})) {
      const q = decodeURIComponent((w.moduleId.split('?actions=')[1] || '').split('&')[0].replace(/!$/, ''));
      let list = [];
      try { list = JSON.parse(q); } catch { continue; }
      for (const [file, acts] of list) for (const a of acts) {
        if (a.id !== id) continue;
        (out[a.exportedName] = out[a.exportedName] || []).push({ id, file: file.replace(appDir + '/', ''), page: worker });
      }
    }
  }
  return out;
}

// Call a server action with JSON-serialisable args (React Flight "encodeReply" for plain values).
const esc = (v) => typeof v === 'string' ? (v.startsWith('$') ? '$' + v : v) : Array.isArray(v) ? v.map(esc) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, esc(x)])) : v;
export async function callAction(base, page, id, args, cookie) {
  let body, headers = { 'Next-Action': id, Accept: 'text/x-component', Origin: base, cookie };
  const fdIdx = args.findIndex((a) => a instanceof FormData);
  if (fdIdx >= 0) {
    // FormData argument: fields are prefixed with the reference id, root row last.
    const fd = new FormData();
    for (const [k, v] of args[fdIdx].entries()) fd.append('_1_' + k, v);
    const root = args.map((a, i) => (i === fdIdx ? '$K1' : esc(a)));
    fd.append('0', JSON.stringify(root));
    body = fd;
  } else {
    body = JSON.stringify(esc(args));
    headers['Content-Type'] = 'text/plain;charset=UTF-8';
  }
  const res = await fetch(base + page, { method: 'POST', body, headers, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, text, value: parseFlight(text) };
}
function parseFlight(text) {
  const lines = text.split('\n');
  const root = lines.find((l) => l.startsWith('0:'));
  if (!root) return undefined;
  try {
    const r = JSON.parse(root.slice(2));
    let v = r.a;
    if (typeof v === 'string' && v.startsWith('$@')) {
      const ref = v.slice(2);
      const row = lines.find((l) => l.startsWith(ref + ':'));
      v = row ? JSON.parse(row.slice(ref.length + 1)) : undefined;
    }
    return v;
  } catch { return undefined; }
}
