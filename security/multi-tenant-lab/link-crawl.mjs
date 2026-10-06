// Launch-readiness crawl: every page and link, per type of user.
// Follows redirects by hand (detects loops), follows every internal <a href>,
// checks static assets referenced by the pages. Usage: node link-crawl.mjs <base>
import { SHIM, sessionCookie } from './lib.mjs';
const BASE = process.argv[2] || 'http://127.0.0.1:3201';
await fetch(SHIM + '/__users', { method: 'POST', body: JSON.stringify({
  'adminA@lab.io': { id: 'aaaaaaaa-0000-4000-8000-0000000000a1', email: 'adminA@lab.io', password: 'Passw0rd!' },
  'adminB@lab.io': { id: 'bbbbbbbb-0000-4000-8000-0000000000a1', email: 'adminB@lab.io', password: 'Passw0rd!' },
  'teacherA@lab.io': { id: 'aaaaaaaa-0000-4000-8000-0000000000a2', email: 'teacherA@lab.io', password: 'Passw0rd!' },
  'noschool@lab.io': { id: 'dddddddd-0000-4000-8000-0000000000d1', email: 'noschool@lab.io', password: 'Passw0rd!' },
}) });
const cookieFor = (email) => sessionCookie(email);
const problems = [];
const show = (u) => new URL(u).pathname + new URL(u).search;
async function go(path, cookie) {
  const chain = [];
  let url = new URL(path, BASE).toString();
  const visited = new Set();
  for (let i = 0; i < 12; i++) {
    if (visited.has(url)) { chain.push('LOOP back to ' + show(url)); return { status: 'loop', chain }; }
    visited.add(url);
    const r = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    chain.push(r.status + ' ' + show(url));
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).toString(); continue; }
    const body = (r.headers.get('content-type') || '').includes('text/html') ? await r.text() : '';
    return { status: r.status, finalPath: show(url), chain, body };
  }
  return { status: 'too-many', chain };
}
const hrefs = (html) => [...html.matchAll(/href="([^"#]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))
  .filter((h) => h.startsWith('/') && !h.startsWith('//') && !h.startsWith('/_next/'));
const assets = (html) => [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:png|ico|svg|jpg|webp|json|webmanifest|css|js)(?:\?[^"]*)?)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

const CLS = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const personas = [
  { name: 'logged-out visitor', email: null, expect: { '/': '/login', '/login': '/login', '/signup': '/signup', '/dashboard': '/login', '/dashboard/people': '/login', '/dashboard/attendance': '/login', '/mark-attendance': '/login', ['/manual-attendance/' + CLS]: '/login' } },
  { name: 'school admin', email: 'adminA@lab.io', expect: { '/': '/dashboard', '/login': '/dashboard', '/signup': '/dashboard', '/dashboard': '/dashboard', '/dashboard/people': '/dashboard/people', '/dashboard/people?role=student': '/dashboard/people?role=student', '/dashboard/people?role=teacher': '/dashboard/people?role=teacher', '/dashboard/classes': '/dashboard/classes', '/dashboard/attendance': '/dashboard/attendance', '/dashboard/devices': '/dashboard/devices', '/mark-attendance': '/mark-attendance', ['/manual-attendance/' + CLS]: '/manual-attendance/' + CLS } },
  { name: 'teacher login (not an admin)', email: 'teacherA@lab.io', expect: { '/dashboard': null, '/': null, '/login?error=access_denied': null } },
  { name: 'account with no school', email: 'noschool@lab.io', expect: { '/dashboard': null, '/login': null, '/login?error=access_denied': null } },
];
for (const p of personas) {
  const cookie = p.email ? await cookieFor(p.email) : null;
  console.log(`\n=== ${p.name}`);
  const seen = new Set(); const queue = Object.keys(p.expect); const assetSet = new Set();
  while (queue.length) {
    const path = queue.shift(); if (seen.has(path)) continue; seen.add(path);
    if (path.startsWith('/api/logout')) continue; // would end the session mid-crawl (tested separately)
    const r = await go(path, cookie);
    const exp = p.expect[path];
    let bad = '';
    if (r.status === 'loop' || r.status === 'too-many') bad = 'REDIRECT LOOP';
    else if (r.status >= 500) bad = 'SERVER ERROR ' + r.status;
    else if (r.status === 404) bad = 'NOT FOUND';
    else if (exp && r.finalPath !== exp) bad = `lands on ${r.finalPath}, expected ${exp}`;
    if (!bad && r.body && /Application error|Unhandled Runtime Error|Internal Server Error/.test(r.body)) bad = 'ERROR PAGE RENDERED';
    console.log(`${bad ? 'PROBLEM' : 'ok     '} ${path}  ->  ${r.chain.join(' > ')}${bad ? '   <<< ' + bad : ''}`);
    if (bad) problems.push(`${p.name}: ${path}: ${bad} (${r.chain.join(' > ')})`);
    if (r.body && r.status === 200) {
      for (const h of hrefs(r.body)) {
        if (/\.(png|ico|svg|jpg|webp|json|webmanifest|js|css)(\?|$)/.test(h)) assetSet.add(h);
        else if (!seen.has(h)) queue.push(h);
      }
      for (const a of assets(r.body)) assetSet.add(a);
    }
  }
  let badAssets = 0;
  for (const a of assetSet) {
    const r = await fetch(new URL(a, BASE), { headers: cookie ? { cookie } : {} });
    if (r.status !== 200) { badAssets++; problems.push(`${p.name}: asset ${a} -> ${r.status}`); console.log('PROBLEM asset ' + a + ' -> ' + r.status); }
  }
  console.log(`pages visited: ${seen.size}, assets checked: ${assetSet.size}, broken assets: ${badAssets}`);
}
const nf = await go('/this-page-does-not-exist', null);
console.log(`\nunknown page: ${nf.chain.join(' > ')}  ${nf.body && nf.body.includes('href="/dashboard"') ? '(shows a link back to the dashboard)' : ''}`);
// Non-admin session: the access-denied page must expire the session cookie,
// otherwise the browser stays "logged in" and loops.
for (const email of ['teacherA@lab.io', 'noschool@lab.io']) {
  const r = await fetch(new URL('/login?error=access_denied', BASE), { redirect: 'manual', headers: { cookie: await cookieFor(email) } });
  const cleared = (r.headers.getSetCookie?.() || []).some((c) => c.startsWith('sb-') && /max-age=0|expires=thu, 01 jan 1970/i.test(c));
  console.log(`${r.status === 200 && cleared ? 'ok     ' : 'PROBLEM'} ${email}: access-denied page ${r.status}, session cookie cleared: ${cleared}`);
  if (!(r.status === 200 && cleared)) problems.push(`${email}: access-denied page did not clear the session (${r.status})`);
  const after = await go('/dashboard', null);   // what the browser does next, cookie gone
  console.log(`         then /dashboard -> ${after.chain.join(' > ')}`);
}
// A real admin opening a shared /login?error=access_denied link must NOT be
// logged out (no logout-by-link); they just go to the dashboard.
{
  const r = await fetch(new URL('/login?error=access_denied', BASE), { redirect: 'manual', headers: { cookie: await cookieFor('adminA@lab.io') } });
  const cleared = (r.headers.getSetCookie?.() || []).some((c) => c.startsWith('sb-') && /max-age=0|expires=thu, 01 jan 1970/i.test(c));
  const ok = r.status >= 300 && r.status < 400 && r.headers.get('location') === '/dashboard' && !cleared;
  console.log(`${ok ? 'ok     ' : 'PROBLEM'} real admin opening an access-denied link: ${r.status} -> ${r.headers.get('location')}, logged out: ${cleared}`);
  if (!ok) problems.push(`real admin opening access-denied link: ${r.status} -> ${r.headers.get('location')}, logged out: ${cleared}`);
}
// Sign Out button = form POST from the same site
const ck = await cookieFor('adminA@lab.io');
const lr = await fetch(new URL('/api/logout', BASE), { method: 'POST', redirect: 'manual', headers: { cookie: ck, origin: BASE, 'sec-fetch-site': 'same-origin' } });
const loOk = lr.status === 303 && (lr.headers.get('location') || '').endsWith('/login');
console.log(`${loOk ? 'ok     ' : 'PROBLEM'} Sign Out button: ${lr.status} -> ${lr.headers.get('location')}`);
if (!loOk) problems.push('Sign Out button: ' + lr.status);
console.log(`\n${problems.length ? 'PROBLEMS:\n- ' + problems.join('\n- ') : 'NO PROBLEMS FOUND'}`);
