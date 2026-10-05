// PostgREST + GoTrue compatible shim over a real Postgres, for multi-tenant pentesting.
// Deliberately has NO row-level security: every request (anon, user or service) sees
// every tenant's rows, so only the application's own checks keep tenants apart.
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'pw', database: 'mtlab' });
const SECRET = 'lab-secret';
const USERS = {}; // email -> {id,password,email}
const LOG = [];

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, email, role) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ sub, email, role: role || 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  const s = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest('base64url');
  return h + '.' + p + '.' + s;
}
function verifyJwt(t) {
  const parts = (t || '').split('.');
  if (parts.length !== 3) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(parts[0] + '.' + parts[1]).digest('base64url');
  if (exp !== parts[2]) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { return null; }
}
const userObj = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: {}, user_metadata: {}, identities: [{ id: u.id }], created_at: new Date().toISOString() });
function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, headers || {}));
  res.end(body === undefined ? '' : JSON.stringify(body));
}
const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';

// ---------- catalog ----------
let CAT = null;
async function loadCatalog() {
  const cols = await pool.query("SELECT table_schema s, table_name t, column_name c, data_type d FROM information_schema.columns WHERE table_schema IN ('school','public')");
  const fks = await pool.query(`SELECT tc.table_schema s, tc.table_name t, kcu.column_name c, ccu.table_schema rs, ccu.table_name rt
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'`);
  CAT = {};
  for (const r of cols.rows) {
    CAT[r.s] = CAT[r.s] || {};
    CAT[r.s][r.t] = CAT[r.s][r.t] || { cols: {}, fks: [] };
    CAT[r.s][r.t].cols[r.c] = r.d;
  }
  for (const r of fks.rows) CAT[r.s][r.t].fks.push({ col: r.c, rs: r.rs, rt: r.rt });
}
async function ensureColumns(schema, table, obj) {
  const t = CAT[schema] && CAT[schema][table];
  if (!t) return;
  let changed = false;
  for (const k of Object.keys(obj)) {
    if (t.cols[k]) continue;
    const v = obj[k];
    const type = v !== null && typeof v === 'object' ? 'jsonb' : typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'numeric' : 'text';
    await pool.query('ALTER TABLE ' + qi(schema) + '.' + qi(table) + ' ADD COLUMN IF NOT EXISTS ' + qi(k) + ' ' + type);
    console.log('[shim] auto-added column ' + schema + '.' + table + '.' + k + ' ' + type);
    changed = true;
  }
  if (changed) await loadCatalog();
}

// ---------- parsing ----------
function splitTop(s) {
  const out = []; let depth = 0, cur = '', q = false;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && depth === 0 && ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
const SELECT_ITEM_RE = new RegExp('^(?:([A-Za-z0-9_]+):)?([A-Za-z0-9_*]+)(?:![A-Za-z0-9_]+)?(?:::[a-z]+)?(?:\\((.*)\\))?$');
function parseSelect(s) {
  return splitTop((s || '*').replace(/\s+/g, '')).map((item) => {
    const m = item.match(SELECT_ITEM_RE);
    if (!m) throw new Error('bad select item ' + item);
    return { alias: m[1] || m[2], name: m[2], sub: m[3] !== undefined ? parseSelect(m[3] || '*') : null };
  });
}
function unquote(v) { return v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v; }

// Build a WHERE fragment for one "col=op.value" condition.
function cond(col, expr, params, cols) {
  if (!cols[col]) throw Object.assign(new Error('column ' + col + ' does not exist'), { code: '42703' });
  let neg = false;
  if (expr.startsWith('not.')) { neg = true; expr = expr.slice(4); }
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot), val = expr.slice(dot + 1);
  const c = qi(col);
  let sql;
  const p = (v) => { params.push(v); return '$' + params.length; };
  switch (op) {
    case 'eq': sql = c + ' = ' + p(unquote(val)); break;
    case 'neq': sql = c + ' <> ' + p(unquote(val)); break;
    case 'gt': sql = c + ' > ' + p(unquote(val)); break;
    case 'gte': sql = c + ' >= ' + p(unquote(val)); break;
    case 'lt': sql = c + ' < ' + p(unquote(val)); break;
    case 'lte': sql = c + ' <= ' + p(unquote(val)); break;
    case 'like': sql = c + '::text LIKE ' + p(unquote(val).replace(/\*/g, '%')); break;
    case 'ilike': sql = c + '::text ILIKE ' + p(unquote(val).replace(/\*/g, '%')); break;
    case 'is': sql = c + ' IS ' + (val === 'null' ? 'NULL' : val === 'true' ? 'TRUE' : val === 'false' ? 'FALSE' : 'UNKNOWN'); break;
    case 'in': {
      const inner = val.replace(/^\(/, '').replace(/\)$/, '');
      const items = inner === '' ? [] : splitTop(inner).map(unquote);
      sql = c + ' = ANY(' + p(items) + ')';
      break;
    }
    default: throw new Error('unsupported operator ' + op);
  }
  return neg ? 'NOT (' + sql + ')' : sql;
}
// or=(a.eq.1,b.ilike.*x*,and(c.eq.2,d.eq.3))
function logicTree(kind, body, params, cols) {
  const inner = body.replace(/^\(/, '').replace(/\)$/, '');
  const parts = splitTop(inner).map((part) => {
    const lm = part.match(/^(not\.)?(and|or)\((.*)\)$/);
    if (lm) { const s = logicTree(lm[2], '(' + lm[3] + ')', params, cols); return lm[1] ? 'NOT ' + s : s; }
    const d = part.indexOf('.');
    return cond(part.slice(0, d), part.slice(d + 1), params, cols);
  });
  return '(' + (parts.length ? parts.join(kind === 'or' ? ' OR ' : ' AND ') : 'TRUE') + ')';
}
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
function buildWhere(sp, cols) {
  const params = [], where = [];
  for (const [k, v] of sp.entries()) {
    if (RESERVED.has(k)) continue;
    if (k.includes('.')) {
      // Filter on an embedded resource. PostgREST would filter the embed, not the parent;
      // we refuse loudly so a test never silently gets broader results than prod.
      throw new Error('embedded filter not supported by shim: ' + k);
    }
    if (k === 'or' || k === 'and') where.push(logicTree(k, v, params, cols));
    else if (k === 'not.or' || k === 'not.and') where.push('NOT ' + logicTree(k.slice(4), v, params, cols));
    else where.push(cond(k, v, params, cols));
  }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}
function buildOrder(order, cols) {
  if (!order) return '';
  const parts = order.split(',').map((o) => {
    const [col, ...mods] = o.split('.');
    if (col.includes('(') || !cols[col]) return null;
    let s = qi(col);
    if (mods.includes('desc')) s += ' DESC'; else s += ' ASC';
    if (mods.includes('nullsfirst')) s += ' NULLS FIRST';
    if (mods.includes('nullslast')) s += ' NULLS LAST';
    return s;
  }).filter(Boolean);
  return parts.length ? ' ORDER BY ' + parts.join(', ') : '';
}

// ---------- embedding ----------
function resolveEmbed(schema, table, item) {
  const t = CAT[schema][table];
  // alias:fk_col(...)  -> many-to-one via that column
  const fkByCol = t.fks.find((f) => f.col === item.name);
  if (fkByCol) return { kind: 'one', col: fkByCol.col, rs: fkByCol.rs, rt: fkByCol.rt };
  // table(...) -> many-to-one if we reference that table, else one-to-many
  const fkToTable = t.fks.filter((f) => f.rt === item.name && f.rs === schema);
  if (fkToTable.length === 1) return { kind: 'one', col: fkToTable[0].col, rs: schema, rt: item.name };
  const other = CAT[schema][item.name];
  if (other) {
    const back = other.fks.filter((f) => f.rt === table && f.rs === schema);
    if (back.length >= 1) return { kind: 'many', col: back[0].col, rs: schema, rt: item.name };
  }
  throw new Error('cannot resolve embed ' + item.name + ' on ' + table);
}
async function project(schema, table, rows, sel) {
  const out = rows.map(() => ({}));
  for (const item of sel) {
    if (item.name === '*' && !item.sub) {
      rows.forEach((r, i) => Object.assign(out[i], r));
      continue;
    }
    if (!item.sub) {
      rows.forEach((r, i) => { out[i][item.alias] = r[item.name] === undefined ? null : r[item.name]; });
      continue;
    }
    const e = resolveEmbed(schema, table, item);
    if (e.kind === 'one') {
      const ids = [...new Set(rows.map((r) => r[e.col]).filter((x) => x !== null && x !== undefined))];
      const ref = ids.length ? (await pool.query('SELECT * FROM ' + qi(e.rs) + '.' + qi(e.rt) + ' WHERE id = ANY($1)', [ids])).rows : [];
      const projected = await project(e.rs, e.rt, ref, item.sub);
      const byId = new Map(ref.map((r, i) => [String(r.id), projected[i]]));
      rows.forEach((r, i) => { out[i][item.alias] = r[e.col] == null ? null : byId.get(String(r[e.col])) || null; });
    } else {
      const ids = rows.map((r) => r.id);
      const ref = ids.length ? (await pool.query('SELECT * FROM ' + qi(e.rs) + '.' + qi(e.rt) + ' WHERE ' + qi(e.col) + ' = ANY($1)', [ids])).rows : [];
      const projected = await project(e.rs, e.rt, ref, item.sub);
      rows.forEach((r, i) => {
        out[i][item.alias] = ref.map((x, j) => (String(x[e.col]) === String(r.id) ? projected[j] : null)).filter(Boolean);
      });
    }
  }
  return out;
}

function pgError(res, e) {
  const code = e.code || 'PGRST000';
  const status = code === '23505' || code === '23503' || code === '23514' ? 409 : code === '42703' || code === '22P02' ? 400 : 400;
  return send(res, status, { code, message: e.message, details: e.detail || null, hint: null });
}

async function handleRpc(req, res, name, args, jwt) {
  if (name === 'auth_school_id') {
    if (!jwt || !jwt.sub) return send(res, 200, null);
    const r = await pool.query('SELECT school_id FROM school.staff_users WHERE auth_user_id = $1 LIMIT 1', [jwt.sub]);
    return send(res, 200, r.rows[0] ? r.rows[0].school_id : null);
  }
  // Every other RPC (fn_add_person, credit_wallet, ...) is "not deployed", which makes the
  // app use its own direct-table fallbacks: the path where app-level checks matter most.
  return send(res, 404, { code: 'PGRST202', message: 'Could not find the function ' + name + ' in the schema cache' });
}

async function handleRest(req, res, url, body) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const jwt = verifyJwt(auth);
  const schema = req.headers['accept-profile'] || req.headers['content-profile'] || 'public';
  const rest = url.pathname.slice('/rest/v1/'.length);
  if (rest.startsWith('rpc/')) LOG.push('RPC ' + rest.slice(4) + ' ' + body);
  if (rest.startsWith('rpc/')) return handleRpc(req, res, rest.slice(4), body ? JSON.parse(body) : {}, jwt);
  const table = rest;
  const t = CAT[schema] && CAT[schema][table];
  if (!t) return send(res, 404, { code: '42P01', message: 'relation "' + schema + '.' + table + '" does not exist' });
  const sp = url.searchParams;
  const prefer = req.headers.prefer || '';
  const sel = parseSelect(sp.get('select') || '*');
  const wantObject = (req.headers.accept || '').includes('vnd.pgrst.object');
  const fq = qi(schema) + '.' + qi(table);

  let rows;
  if (req.method === 'GET' || req.method === 'HEAD') {
    const w = buildWhere(sp, t.cols);
    let sql = 'SELECT * FROM ' + fq + w.sql + buildOrder(sp.get('order'), t.cols);
    const total = prefer.includes('count=') ? Number((await pool.query('SELECT count(*) FROM ' + fq + w.sql, w.params)).rows[0].count) : null;
    if (sp.get('limit')) sql += ' LIMIT ' + Number(sp.get('limit'));
    if (sp.get('offset')) sql += ' OFFSET ' + Number(sp.get('offset'));
    rows = (await pool.query(sql, w.params)).rows;
    const headers = {};
    const off = Number(sp.get('offset') || 0);
    headers['content-range'] = (rows.length ? off + '-' + (off + rows.length - 1) : '*') + '/' + (total === null ? '*' : total);
    if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
    const data = await project(schema, table, rows, sel);
    if (wantObject) {
      if (data.length !== 1) return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains ' + data.length + ' rows' });
      return send(res, 200, data[0], headers);
    }
    return send(res, 200, data, headers);
  }

  if (req.method === 'POST') {
    let payload = body ? JSON.parse(body) : {};
    const arr = Array.isArray(payload) ? payload : [payload];
    for (const o of arr) await ensureColumns(schema, table, o);
    const t2 = CAT[schema][table];
    const keys = [...new Set(arr.flatMap((o) => Object.keys(o)))].filter((k) => t2.cols[k]);
    const params = [];
    const values = arr.map((o) => '(' + keys.map((k) => {
      const v = o[k] === undefined ? null : o[k];
      params.push(v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v);
      return '$' + params.length;
    }).join(',') + ')');
    let sql = keys.length ? 'INSERT INTO ' + fq + ' (' + keys.map(qi).join(',') + ') VALUES ' + values.join(',') : 'INSERT INTO ' + fq + ' DEFAULT VALUES';
    if (prefer.includes('resolution=merge-duplicates')) {
      const oc = (sp.get('on_conflict') || 'id').split(',').map(qi).join(',');
      const upd = keys.map((k) => qi(k) + ' = EXCLUDED.' + qi(k)).join(',');
      sql += ' ON CONFLICT (' + oc + ') DO ' + (upd ? 'UPDATE SET ' + upd : 'NOTHING');
    } else if (prefer.includes('resolution=ignore-duplicates')) {
      sql += ' ON CONFLICT DO NOTHING';
    }
    rows = (await pool.query(sql + ' RETURNING *', params)).rows;
  } else if (req.method === 'PATCH') {
    const payload = body ? JSON.parse(body) : {};
    await ensureColumns(schema, table, payload);
    const t2 = CAT[schema][table];
    const w = buildWhere(sp, t2.cols);
    const params = w.params.slice();
    const sets = Object.keys(payload).filter((k) => t2.cols[k]).map((k) => {
      const v = payload[k];
      params.push(v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v);
      return qi(k) + ' = $' + params.length;
    });
    if (!sets.length) return send(res, 204);
    rows = (await pool.query('UPDATE ' + fq + ' SET ' + sets.join(',') + w.sql + ' RETURNING *', params)).rows;
  } else if (req.method === 'DELETE') {
    const w = buildWhere(sp, t.cols);
    rows = (await pool.query('DELETE FROM ' + fq + w.sql + ' RETURNING *', w.params)).rows;
  } else {
    return send(res, 405, {});
  }
  if (!prefer.includes('return=representation')) return send(res, req.method === 'POST' ? 201 : 204);
  const data = await project(schema, table, rows, sel);
  if (wantObject) {
    if (data.length !== 1) return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
    return send(res, req.method === 'POST' ? 201 : 200, data[0]);
  }
  return send(res, req.method === 'POST' ? 201 : 200, data);
}

function handleAuth(req, res, url, body) {
  const p = url.pathname;
  if (p === '/auth/v1/token') {
    const b = JSON.parse(body || '{}');
    if (url.searchParams.get('grant_type') === 'refresh_token') return send(res, 400, { code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
    const u = USERS[b.email];
    if (!u || u.password !== b.password) return send(res, 400, { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    return send(res, 200, sessionFor(u));
  }
  if (p === '/auth/v1/user') {
    const j = verifyJwt((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const u = j && Object.values(USERS).find((x) => x.id === j.sub);
    if (!u) return send(res, 401, { code: 'bad_jwt', msg: 'invalid JWT' });
    return send(res, 200, userObj(u));
  }
  if (p === '/auth/v1/logout') return send(res, 204);
  return send(res, 404, { msg: 'not implemented in shim: ' + p });
}
function sessionFor(u) {
  return { access_token: mintJwt(u.id, u.email), refresh_token: crypto.randomUUID(), expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user: userObj(u) };
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x');
    LOG.push(req.method + ' ' + url.pathname + url.search);
    try {
      if (url.pathname === '/__log') return send(res, 200, LOG.splice(0));
      if (url.pathname === '/__users') { Object.assign(USERS, JSON.parse(body)); return send(res, 200, Object.keys(USERS)); }
      if (url.pathname === '/__session') { const u = USERS[JSON.parse(body).email]; return send(res, 200, sessionFor(u)); }
      if (url.pathname === '/__reload') { await loadCatalog(); return send(res, 200, { ok: true }); }
      if (url.pathname.startsWith('/auth/v1/')) return handleAuth(req, res, url, body);
      if (url.pathname.startsWith('/rest/v1/')) return await handleRest(req, res, url, body);
      send(res, 404, {});
    } catch (e) {
      if (!e.code) console.error('[shim]', req.method, url.pathname + url.search, e.message);
      pgError(res, e);
    }
  });
}).listen(54321, '127.0.0.1', async () => { await loadCatalog(); console.log('shim on 54321'); });
