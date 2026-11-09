// Ломбардын бүртгэлийн сервер (Cloudflare Worker).
// Сайтын файлууд public/ хавтаснаас, өгөгдөл нь Cloudflare D1 (env.DB)-ээс ирнэ.
// Ажилтан бүр өөрийн нэр, нууц үгээр нэвтэрнэ. APP_PASSWORD нь зөвхөн анхны админыг үүсгэх, сэргээхэд хэрэглэгдэнэ.

import { runOverdueSms, sendSms, smsConfigured, normalizePhone, insertLogs } from './sms.js';
import {
  hashPassword, verifyPassword, equalsSecret, createSession, sessionUser, endSession,
  forgetUserSessions, cleanUsername, validUsername, publicUser, newToken,
} from './auth.js';
import { describeCustomer, describeLoan, describeTxn, describeBlacklist, describeSettings, auditRows } from './audit.js';

// Үнэгүй хувилбарт нэг хүсэлтэд 50 хүртэл query ажиллуулж болно. Нөөцтэй байлгахын тулд 40.
const MAX_STATEMENTS = 40;
const CUSTOMER_ROWS_PER_INSERT = 33; // 3 параметр x 33 = 99
const LOAN_ROWS_PER_INSERT = 16; // 6 параметр x 16 = 96
const DOC_ROWS_PER_INSERT = 25; // 4 параметр x 25 = 100
const AUDIT_ROWS_PER_INSERT = 16; // 6 параметр x 16 = 96
const IDS_PER_QUERY = 90;
const MAX_ENTITY_BYTES = 500_000;
const AUDIT_DETAIL_LIMIT = 40; // үүнээс олон бичлэгтэй бол нэгтгэсэн нэг мөр бичнэ
const DOC_KINDS = ['txns', 'blacklist'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS loans (
     id TEXT PRIMARY KEY, ticket_no INTEGER NOT NULL, customer_id TEXT, status TEXT,
     data TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS loans_ticket_no ON loans (ticket_no)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `INSERT OR IGNORE INTO meta (key, value) VALUES ('next_ticket', '1')`,
  `CREATE TABLE IF NOT EXISTS sms_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT, loan_id TEXT, ticket_no INTEGER, due TEXT, phone TEXT,
     text TEXT, status TEXT, info TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sms_log_loan ON sms_log (loan_id, due)`,
  `CREATE TABLE IF NOT EXISTS docs (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, id))`,
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT, role TEXT NOT NULL, pass TEXT NOT NULL,
     active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_login INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT, username TEXT,
     kind TEXT, ref TEXT, text TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS audit_at ON audit (at)`,
];

let schemaReady = null;

export default {
  // Cloudflare өдөр бүр 10:00-17:00 цагийн хооронд цаг тутам ажиллуулна (wrangler.jsonc > triggers)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ensureSchema(env).then(() => runOverdueSms(env)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    try {
      if (!env.DB) return json({ error: 'no_db', message: 'D1 binding "DB" is missing' }, 500);
      await ensureSchema(env);
      const route = request.method + ' ' + url.pathname;

      // Нэвтрэхээс өмнөх хүсэлтүүд
      switch (route) {
        case 'GET /api/auth/state':
          return json(await authState(env));
        case 'POST /api/auth/setup':
          return json(await setupAdmin(env, await readBody(request)));
        case 'POST /api/auth/login':
          return json(await login(env, await readBody(request)));
        case 'POST /api/auth/reset':
          return json(await resetAdmin(env, await readBody(request)));
      }

      const user = await sessionUser(env, request);
      if (!user) return json({ error: 'unauthorized' }, 401);
      const admin = () => {
        if (user.role !== 'admin') throw fail(403, 'forbidden', 'Зөвхөн админ хийх боломжтой');
      };

      switch (route) {
        case 'POST /api/auth/logout':
          await endSession(env, user.tokenHash);
          return json({ ok: true });
        case 'POST /api/auth/password':
          return json(await changeOwnPassword(env, user, await readBody(request)));
        case 'GET /api/data':
          return await readAll(env, user);
        case 'GET /api/rev':
          return json({ rev: await readRev(env) });
        case 'POST /api/sync':
          return json(await sync(env, user, await readBody(request)));
        case 'POST /api/ticket':
          return json(await allocateTicket(env));
        case 'PUT /api/ticket':
          admin();
          return json(await setNextTicket(env, user, await readBody(request)));
        case 'POST /api/wipe':
          admin();
          return json(await wipe(env, user));
        case 'POST /api/sms/run':
          admin();
          return json(await runOverdueSms(env));
        case 'POST /api/sms/test':
          admin();
          return json(await testSms(env, await readBody(request)));
        case 'GET /api/audit':
          return json(await readAudit(env, url.searchParams));
        case 'GET /api/users':
          admin();
          return json(await listUsers(env));
        case 'POST /api/users':
          admin();
          return json(await createUser(env, user, await readBody(request)));
      }
      const m = url.pathname.match(/^\/api\/users\/([\w-]+)$/);
      if (m && request.method === 'PUT') {
        admin();
        return json(await updateUser(env, user, m[1], await readBody(request)));
      }
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: e.code || 'server', message: String((e && e.message) || e) }, e.status || 500);
    }
  },
};

/* ---------------- туслах ---------------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function fail(status, code, message) {
  const e = new Error(message || code);
  e.status = status;
  e.code = code;
  return e;
}

async function readBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > 20_000_000) throw fail(413, 'too_large', 'Request body is too large');
  try {
    return await request.json();
  } catch {
    throw fail(400, 'bad_json', 'Request body must be JSON');
  }
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const marks = (n) => Array(n).fill('?').join(', ');
const newRev = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

async function readRev(env) {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'rev'`).first();
  return row ? row.value : '0';
}

function revStatement(env) {
  return env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('rev', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(newRev());
}

function auditStatements(env, rows) {
  return chunk(rows, AUDIT_ROWS_PER_INSERT).map((part) =>
    env.DB.prepare(
      `INSERT INTO audit (at, user_id, username, kind, ref, text) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`
    ).bind(...part.flat())
  );
}

async function writeAudit(env, user, kind, ref, texts) {
  const rows = auditRows(user, Date.now(), kind, ref, texts);
  if (rows.length) await env.DB.batch(auditStatements(env, rows));
}

/* ---------------- нэвтрэлт ---------------- */

async function countUsers(env) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
  return r ? Number(r.n) : 0;
}

async function authState(env) {
  return { hasUsers: (await countUsers(env)) > 0, secretSet: !!env.APP_PASSWORD };
}

function checkNewPassword(p) {
  if (typeof p !== 'string' || p.length < 6) throw fail(400, 'weak_password', 'Нууц үг дор хаяж 6 тэмдэгт байна');
  if (p.length > 200) throw fail(400, 'weak_password', 'Нууц үг хэт урт байна');
}

async function setupAdmin(env, body) {
  if (!env.APP_PASSWORD) throw fail(503, 'not_configured', 'APP_PASSWORD тохируулаагүй байна');
  if ((await countUsers(env)) > 0) throw fail(409, 'already_setup', 'Админ аль хэдийн үүссэн байна');
  if (!(await equalsSecret(body && body.secret, env.APP_PASSWORD))) {
    await sleep(500);
    throw fail(401, 'bad_secret', 'Cloudflare дээрх APP_PASSWORD буруу байна');
  }
  const username = cleanUsername(body.username);
  if (!validUsername(username)) throw fail(400, 'bad_username', 'Нэвтрэх нэр 3-32 латин үсэг, тоо байна');
  checkNewPassword(body.password);
  const u = { id: newToken().slice(0, 16), username, name: String(body.name || username).trim().slice(0, 60), role: 'admin' };
  await env.DB.prepare(`INSERT INTO users (id, username, name, role, pass, active, created_at) VALUES (?, ?, ?, 'admin', ?, 1, ?)`)
    .bind(u.id, u.username, u.name, await hashPassword(body.password), Date.now())
    .run();
  await writeAudit(env, u, 'user', u.username, [`Анхны админ үүсгэв: ${u.name} (${u.username})`]);
  return { token: await createSession(env, u), user: publicUser({ ...u, active: 1 }) };
}

async function login(env, body) {
  const username = cleanUsername(body && body.username);
  const row = username
    ? await env.DB.prepare(`SELECT id, username, name, role, pass, active FROM users WHERE username = ?`).bind(username).first()
    : null;
  const ok = row && row.active && (await verifyPassword(body.password, row.pass));
  if (!ok) {
    await sleep(500); // таах оролдлогыг удаашруулна
    throw fail(401, 'bad_login', 'Нэвтрэх нэр эсвэл нууц үг буруу байна');
  }
  return { token: await createSession(env, row), user: publicUser(row) };
}

// Админ нууц үгээ мартвал: APP_PASSWORD-оор баталгаажуулаад шинэ нууц үг тавина
async function resetAdmin(env, body) {
  if (!env.APP_PASSWORD) throw fail(503, 'not_configured', 'APP_PASSWORD тохируулаагүй байна');
  if (!(await equalsSecret(body && body.secret, env.APP_PASSWORD))) {
    await sleep(500);
    throw fail(401, 'bad_secret', 'Cloudflare дээрх APP_PASSWORD буруу байна');
  }
  const username = cleanUsername(body.username);
  checkNewPassword(body.password);
  const row = await env.DB.prepare(`SELECT id, username, name, role, active FROM users WHERE username = ?`).bind(username).first();
  if (!row || row.role !== 'admin') throw fail(404, 'no_admin', 'Ийм нэртэй админ олдсонгүй');
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET pass = ?, active = 1 WHERE id = ?`).bind(await hashPassword(body.password), row.id),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(row.id),
  ]);
  forgetUserSessions(row.id);
  await writeAudit(env, row, 'user', row.username, [`Админы нууц үгийг APP_PASSWORD-оор сэргээв: ${row.username}`]);
  return { token: await createSession(env, row), user: publicUser({ ...row, active: 1 }) };
}

async function changeOwnPassword(env, user, body) {
  const row = await env.DB.prepare(`SELECT pass FROM users WHERE id = ?`).bind(user.id).first();
  if (!row || !(await verifyPassword(body && body.current, row.pass))) {
    await sleep(500);
    throw fail(400, 'bad_password', 'Одоогийн нууц үг буруу байна');
  }
  checkNewPassword(body.next);
  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET pass = ? WHERE id = ?`).bind(await hashPassword(body.next), user.id),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`).bind(user.id, user.tokenHash),
  ]);
  await writeAudit(env, user, 'user', user.username, ['Өөрийн нууц үгээ солив']);
  return { ok: true };
}

/* ---------------- ажилтан ---------------- */

async function listUsers(env) {
  const r = await env.DB.prepare(`SELECT id, username, name, role, active, created_at, last_login FROM users ORDER BY created_at`).all();
  return { users: r.results.map((u) => ({ ...publicUser(u), createdAt: u.created_at, lastLogin: u.last_login })) };
}

const ROLE = { admin: 'Админ', staff: 'Ажилтан' };

async function createUser(env, actor, body) {
  const username = cleanUsername(body && body.username);
  if (!validUsername(username)) throw fail(400, 'bad_username', 'Нэвтрэх нэр 3-32 латин үсэг, тоо, цэг, зураас байна');
  const role = body.role === 'admin' ? 'admin' : 'staff';
  checkNewPassword(body.password);
  const exists = await env.DB.prepare(`SELECT id FROM users WHERE username = ?`).bind(username).first();
  if (exists) throw fail(409, 'username_taken', 'Ийм нэвтрэх нэр бүртгэлтэй байна');
  const u = { id: newToken().slice(0, 16), username, name: String(body.name || username).trim().slice(0, 60), role };
  await env.DB.prepare(`INSERT INTO users (id, username, name, role, pass, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
    .bind(u.id, u.username, u.name, u.role, await hashPassword(body.password), Date.now())
    .run();
  await writeAudit(env, actor, 'user', username, [`Хэрэглэгч нэмэв: ${u.name} (${username}), ${ROLE[role]}`]);
  return { user: publicUser({ ...u, active: 1 }) };
}

async function updateUser(env, actor, id, body) {
  const row = await env.DB.prepare(`SELECT id, username, name, role, active FROM users WHERE id = ?`).bind(id).first();
  if (!row) throw fail(404, 'no_user', 'Хэрэглэгч олдсонгүй');
  const next = {
    name: body.name !== undefined ? String(body.name).trim().slice(0, 60) || row.username : row.name,
    role: body.role === 'admin' || body.role === 'staff' ? body.role : row.role,
    active: body.active !== undefined ? (body.active ? 1 : 0) : row.active,
  };
  if (row.role === 'admin' && row.active && (next.role !== 'admin' || !next.active)) {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`).first();
    if (Number(r.n) <= 1) throw fail(400, 'last_admin', 'Сүүлийн идэвхтэй админыг өөрчлөх боломжгүй');
  }
  const st = [env.DB.prepare(`UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?`).bind(next.name, next.role, next.active, id)];
  const texts = [];
  if (next.name !== row.name) texts.push(`${row.username}: Нэр өөрчлөв ${row.name}->${next.name}`);
  if (next.role !== row.role) texts.push(`${row.username}: Эрх өөрчлөв ${ROLE[row.role]}->${ROLE[next.role]}`);
  if (next.active !== row.active) texts.push(`${row.username}: ${next.active ? 'идэвхжүүлэв' : 'идэвхгүй болгов'}`);
  if (body.password) {
    checkNewPassword(body.password);
    st.push(env.DB.prepare(`UPDATE users SET pass = ? WHERE id = ?`).bind(await hashPassword(body.password), id));
    texts.push(`${row.username}: нууц үгийг шинэчлэв`);
  }
  if (body.password || !next.active || next.role !== row.role) {
    st.push(env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id));
    forgetUserSessions(id);
  }
  await env.DB.batch(st);
  await writeAudit(env, actor, 'user', row.username, texts);
  return { user: publicUser({ ...row, ...next }) };
}

/* ---------------- унших ---------------- */

// Мөр бүрийг задлахгүйгээр хариуг шууд угсарна: үнэгүй хувилбарын 10ms CPU хязгаарт хэмнэлттэй
async function readAll(env, user) {
  const [customers, loans, settings, next, rev, sms, docs, users] = await env.DB.batch([
    env.DB.prepare(`SELECT data FROM customers`),
    env.DB.prepare(`SELECT data FROM loans ORDER BY ticket_no`),
    env.DB.prepare(`SELECT value FROM meta WHERE key = 'settings'`),
    env.DB.prepare(`SELECT value FROM meta WHERE key = 'next_ticket'`),
    env.DB.prepare(`SELECT value FROM meta WHERE key = 'rev'`),
    env.DB.prepare(`SELECT loan_id, ticket_no, due, phone, text, status, info, created_at FROM sms_log ORDER BY id DESC LIMIT 300`),
    env.DB.prepare(`SELECT kind, data FROM docs`),
    env.DB.prepare(`SELECT id, username, name, role, active FROM users ORDER BY created_at`),
  ]);
  const byKind = Object.fromEntries(DOC_KINDS.map((k) => [k, []]));
  for (const r of docs.results) if (byKind[r.kind]) byKind[r.kind].push(r.data);
  const body =
    '{"settings":' + (settings.results[0] ? settings.results[0].value : 'null') +
    ',"nextTicket":' + (Number(next.results[0] ? next.results[0].value : 1) || 1) +
    ',"rev":' + JSON.stringify(rev.results[0] ? rev.results[0].value : '0') +
    ',"me":' + JSON.stringify(publicUser(user)) +
    ',"users":' + JSON.stringify(users.results.map(publicUser)) +
    ',"smsConfigured":' + smsConfigured(env) +
    ',"sms":' + JSON.stringify(sms.results) +
    ',"customers":[' + customers.results.map((r) => r.data).join(',') + ']' +
    ',"loans":[' + loans.results.map((r) => r.data).join(',') + ']' +
    DOC_KINDS.map((k) => `,"${k}":[` + byKind[k].join(',') + ']').join('') +
    '}';
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

async function readAudit(env, p) {
  const limit = Math.min(200, Math.max(1, Math.trunc(+p.get('limit') || 50)));
  const offset = Math.max(0, Math.trunc(+p.get('offset') || 0));
  const where = [];
  const args = [];
  const kind = p.get('kind');
  if (kind) { where.push('kind = ?'); args.push(kind); }
  const u = p.get('user');
  if (u) { where.push('username = ?'); args.push(u); }
  const day = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? Date.parse(s + 'T00:00:00+08:00') : null);
  const from = day(p.get('from'));
  if (from) { where.push('at >= ?'); args.push(from); }
  const to = day(p.get('to'));
  if (to) { where.push('at < ?'); args.push(to + 864e5); }
  const q = String(p.get('q') || '').trim().replace(/[%_]/g, '').slice(0, 40);
  if (q) { where.push('text LIKE ?'); args.push('%' + q + '%'); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const [rows, total] = await env.DB.batch([
    env.DB.prepare(`SELECT id, at, username, kind, ref, text FROM audit ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM audit ${w}`).bind(...args),
  ]);
  return { rows: rows.results, total: Number(total.results[0].n) };
}

/* ---------------- бичих ---------------- */

function cleanEntity(o, kind) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw fail(400, 'bad_' + kind, 'Invalid ' + kind);
  const id = o.id;
  if (typeof id !== 'string' || !id || id.length > 80) throw fail(400, 'bad_' + kind, 'Invalid ' + kind + ' id');
  const data = JSON.stringify(o);
  if (data.length > MAX_ENTITY_BYTES) throw fail(413, 'too_large', kind + ' ' + id + ' is too large');
  return { id, data, o };
}

function cleanIds(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((id) => typeof id === 'string' && id && id.length <= 80);
}

const arr = (v) => (Array.isArray(v) ? v : []);

// body: { reset?, settings?, upsert: {customers, loans, txns, blacklist}, delete: {...} }
async function sync(env, user, body) {
  if (!body || typeof body !== 'object') throw fail(400, 'bad_body');
  const isAdmin = user.role === 'admin';
  const now = Date.now();
  const up = body.upsert || {};
  const del = body.delete || {};
  const customers = arr(up.customers).map((c) => cleanEntity(c, 'customer'));
  const loans = arr(up.loans).map((l) => cleanEntity(l, 'loan'));
  const docs = DOC_KINDS.flatMap((k) => arr(up[k]).map((d) => ({ kind: k, ...cleanEntity(d, k) })));
  const dels = {
    customers: cleanIds(del.customers),
    loans: cleanIds(del.loans),
    ...Object.fromEntries(DOC_KINDS.map((k) => [k, cleanIds(del[k])])),
  };
  const delCount = Object.values(dels).reduce((s, l) => s + l.length, 0);
  if (delCount && !isAdmin) throw fail(403, 'forbidden', 'Устгах эрх зөвхөн админд байна');
  if (body.reset === true && !isAdmin) throw fail(403, 'forbidden', 'Зөвхөн админ хийх боломжтой');
  const settings = body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings) && isAdmin ? { ...body.settings } : null;
  if (settings) {
    delete settings.nextTicket;
    delete settings.lastBackup;
  }

  // ---- засварын түүх: өмнөх утгыг уншиж харьцуулна ----
  const audit = [];
  const total = customers.length + loans.length + docs.length + delCount;
  if (body.reset === true) {
    audit.push(...auditRows(user, now, 'system', '', [`Нөөцөөс сэргээв / бүх өгөгдлийг шинэчлэв (${customers.length} харилцагч, ${loans.length} зээл, ${docs.length} бусад бичлэг)`]));
  } else if (total > AUDIT_DETAIL_LIMIT) {
    audit.push(...auditRows(user, now, 'system', '', [`Бөөнөөр шинэчлэв: ${customers.length} харилцагч, ${loans.length} зээл, ${docs.length} бусад бичлэг`]));
  } else if (total || settings) {
    const reads = [];
    const cIds = [...customers.map((c) => c.id), ...dels.customers];
    const lIds = [...loans.map((l) => l.id), ...dels.loans];
    const dIds = [...docs.map((d) => d.kind + '|' + d.id), ...DOC_KINDS.flatMap((k) => dels[k].map((id) => k + '|' + id))];
    for (const part of chunk(cIds, IDS_PER_QUERY)) reads.push(['c', env.DB.prepare(`SELECT id, data FROM customers WHERE id IN (${marks(part.length)})`).bind(...part)]);
    for (const part of chunk(lIds, IDS_PER_QUERY)) reads.push(['l', env.DB.prepare(`SELECT id, data FROM loans WHERE id IN (${marks(part.length)})`).bind(...part)]);
    for (const part of chunk(dIds, IDS_PER_QUERY)) reads.push(['d', env.DB.prepare(`SELECT kind || '|' || id AS id, data FROM docs WHERE kind || '|' || id IN (${marks(part.length)})`).bind(...part)]);
    if (settings) reads.push(['s', env.DB.prepare(`SELECT 'settings' AS id, value AS data FROM meta WHERE key = 'settings'`)]);
    const prev = { c: new Map(), l: new Map(), d: new Map(), s: new Map() };
    if (reads.length) {
      const res = await env.DB.batch(reads.map((r) => r[1]));
      res.forEach((r, i) => r.results.forEach((row) => prev[reads[i][0]].set(row.id, JSON.parse(row.data))));
    }
    const add = (kind, ref, texts) => audit.push(...auditRows(user, now, kind, ref, texts));
    for (const c of customers) add('customer', c.o.regNo || '', describeCustomer(prev.c.get(c.id), c.o));
    for (const id of dels.customers) if (prev.c.has(id)) add('customer', prev.c.get(id).regNo || '', describeCustomer(prev.c.get(id), null));
    for (const l of loans) add('loan', l.o.ticketNo, describeLoan(prev.l.get(l.id), l.o));
    for (const id of dels.loans) if (prev.l.has(id)) add('loan', prev.l.get(id).ticketNo, describeLoan(prev.l.get(id), null));
    const dDescribe = { txns: describeTxn, blacklist: describeBlacklist };
    const dKind = { txns: 'txn', blacklist: 'blacklist' };
    for (const d of docs) add(dKind[d.kind], d.kind === 'blacklist' ? d.o.regNo : '', dDescribe[d.kind](prev.d.get(d.kind + '|' + d.id), d.o));
    for (const k of DOC_KINDS)
      for (const id of dels[k]) {
        const p = prev.d.get(k + '|' + id);
        if (p) add(dKind[k], k === 'blacklist' ? p.regNo : '', dDescribe[k](p, null));
      }
    if (settings) add('settings', '', describeSettings(prev.s.get('settings'), settings));
  }

  // ---- бичих ----
  const st = [];
  if (body.reset === true) {
    st.push(env.DB.prepare(`DELETE FROM customers`));
    st.push(env.DB.prepare(`DELETE FROM loans`));
    st.push(env.DB.prepare(`DELETE FROM docs`));
    st.push(env.DB.prepare(`UPDATE meta SET value = '1' WHERE key = 'next_ticket'`));
  }
  for (const part of chunk(customers, CUSTOMER_ROWS_PER_INSERT)) {
    st.push(
      env.DB.prepare(
        `INSERT INTO customers (id, data, updated_at) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      ).bind(...part.flatMap((c) => [c.id, c.data, now]))
    );
  }
  for (const part of chunk(loans, LOAN_ROWS_PER_INSERT)) {
    st.push(
      env.DB.prepare(
        `INSERT INTO loans (id, ticket_no, customer_id, status, data, updated_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}
         ON CONFLICT(id) DO UPDATE SET ticket_no = excluded.ticket_no, customer_id = excluded.customer_id,
           status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`
      ).bind(
        ...part.flatMap((l) => [
          l.id,
          Number.isFinite(+l.o.ticketNo) ? Math.trunc(+l.o.ticketNo) : 0,
          typeof l.o.customerId === 'string' ? l.o.customerId : null,
          typeof l.o.status === 'string' ? l.o.status : 'active',
          l.data,
          now,
        ])
      )
    );
  }
  for (const part of chunk(docs, DOC_ROWS_PER_INSERT)) {
    st.push(
      env.DB.prepare(
        `INSERT INTO docs (kind, id, data, updated_at) VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}
         ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      ).bind(...part.flatMap((d) => [d.kind, d.id, d.data, now]))
    );
  }
  for (const part of chunk(dels.customers, IDS_PER_QUERY)) st.push(env.DB.prepare(`DELETE FROM customers WHERE id IN (${marks(part.length)})`).bind(...part));
  for (const part of chunk(dels.loans, IDS_PER_QUERY)) st.push(env.DB.prepare(`DELETE FROM loans WHERE id IN (${marks(part.length)})`).bind(...part));
  for (const k of DOC_KINDS)
    for (const part of chunk(dels[k], IDS_PER_QUERY - 1))
      st.push(env.DB.prepare(`DELETE FROM docs WHERE kind = ? AND id IN (${marks(part.length)})`).bind(k, ...part));
  if (settings) {
    st.push(
      env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(
        JSON.stringify(settings)
      )
    );
  }
  if (!st.length) return { ok: true, ignored: body.settings && !settings ? ['settings'] : [] };
  st.push(...auditStatements(env, audit));
  st.push(revStatement(env));
  if (st.length > MAX_STATEMENTS) throw fail(413, 'too_many', 'Send fewer records per request');
  await env.DB.batch(st);
  return {
    ok: true,
    written: customers.length + loans.length + docs.length,
    deleted: delCount,
    ignored: body.settings && !settings ? ['settings'] : [],
  };
}

// Шинэ тасалбарын дугаарыг давхардахгүйгээр олгоно.
async function allocateTicket(env) {
  const max = await env.DB.prepare(`SELECT COALESCE(MAX(ticket_no), 0) AS m FROM loans`).first();
  const row = await env.DB.prepare(
    `UPDATE meta SET value = CAST(MAX(CAST(value AS INTEGER), ?) + 1 AS TEXT)
     WHERE key = 'next_ticket' RETURNING CAST(value AS INTEGER) - 1 AS n`
  )
    .bind((max ? Number(max.m) : 0) + 1)
    .first();
  if (!row) throw fail(500, 'ticket', 'Could not allocate ticket number');
  return { ticketNo: Number(row.n), nextTicket: Number(row.n) + 1 };
}

async function setNextTicket(env, user, body) {
  const next = Math.trunc(Number(body && body.next));
  if (!Number.isFinite(next) || next < 1 || next > 1e9) throw fail(400, 'bad_next', 'Invalid ticket number');
  const max = await env.DB.prepare(`SELECT COALESCE(MAX(ticket_no), 0) AS m FROM loans`).first();
  const value = Math.max(next, (max ? Number(max.m) : 0) + 1);
  await env.DB.prepare(`UPDATE meta SET value = ? WHERE key = 'next_ticket'`).bind(String(value)).run();
  if (!body.silent) await writeAudit(env, user, 'settings', '', [`Тохиргоо: Дараагийн тасалбарын дугаар ${value}`]);
  return { nextTicket: value };
}

async function wipe(env, user) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM customers`),
    env.DB.prepare(`DELETE FROM loans`),
    env.DB.prepare(`DELETE FROM docs`),
    env.DB.prepare(`UPDATE meta SET value = '1' WHERE key = 'next_ticket'`),
    ...auditStatements(env, auditRows(user, Date.now(), 'system', '', ['Бүх харилцагч, зээл, гүйлгээг устгав'])),
    revStatement(env),
  ]);
  return { ok: true };
}

async function testSms(env, body) {
  if (!smsConfigured(env)) throw fail(400, 'sms_not_configured', 'SMS_API_KEY, SMS_FROM тохируулаагүй байна');
  const phone = normalizePhone(body && body.to);
  if (!phone) throw fail(400, 'bad_phone', 'Утасны дугаар буруу байна');
  const text = String((body && body.text) || '').trim().slice(0, 480);
  if (!text) throw fail(400, 'bad_text', 'Мессежийн текст хоосон байна');
  const r = await sendSms(env, phone, text);
  await insertLogs(env, [[null, null, null, phone, text, r.ok ? 'test' : 'failed', r.info, Date.now()]]);
  return { ok: r.ok, info: r.info };
}
