// Ломбардын бүртгэлийн сервер (Cloudflare Worker).
// Сайтын файлууд public/ хавтаснаас, өгөгдөл нь Cloudflare D1 (env.DB)-ээс ирнэ.
// Бүх /api/ хүсэлт APP_PASSWORD нууц үгээр хамгаалагдсан.

// Үнэгүй хувилбарт нэг хүсэлтэд 50 хүртэл query ажиллуулж болно. Нөөцтэй байлгахын тулд 40.
const MAX_STATEMENTS = 40;
// D1-д нэг query 100 хүртэл параметртэй байж болно.
const CUSTOMER_ROWS_PER_INSERT = 33; // 3 параметр x 33 = 99
const LOAN_ROWS_PER_INSERT = 16; // 6 параметр x 16 = 96
const IDS_PER_DELETE = 100;
const MAX_ENTITY_BYTES = 500_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS customers (
     id TEXT PRIMARY KEY,
     data TEXT NOT NULL,
     updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS loans (
     id TEXT PRIMARY KEY,
     ticket_no INTEGER NOT NULL,
     customer_id TEXT,
     status TEXT,
     data TEXT NOT NULL,
     updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS loans_ticket_no ON loans (ticket_no)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `INSERT OR IGNORE INTO meta (key, value) VALUES ('next_ticket', '1')`,
];

let schemaReady = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    try {
      if (!env.DB) return json({ error: 'no_db', message: 'D1 binding "DB" is missing' }, 500);
      const denied = await checkPassword(request, env);
      if (denied) return denied;
      await ensureSchema(env);

      switch (request.method + ' ' + url.pathname) {
        case 'GET /api/data':
          return json(await readAll(env));
        case 'GET /api/rev':
          return json({ rev: await readRev(env) });
        case 'POST /api/sync':
          return json(await sync(env, await readBody(request)));
        case 'POST /api/ticket':
          return json(await allocateTicket(env));
        case 'PUT /api/ticket':
          return json(await setNextTicket(env, await readBody(request)));
        case 'POST /api/wipe':
          return json(await wipe(env));
        default:
          return json({ error: 'not_found' }, 404);
      }
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

function newRev() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function checkPassword(request, env) {
  const secret = env.APP_PASSWORD;
  if (!secret) return json({ error: 'not_configured', message: 'APP_PASSWORD secret is not set' }, 503);
  const header = request.headers.get('authorization') || '';
  let given = '';
  if (header.startsWith('Bearer ')) {
    try {
      given = decodeURIComponent(header.slice(7));
    } catch {
      given = '';
    }
  }
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(String(secret))),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  if (!given || diff !== 0) {
    await new Promise((r) => setTimeout(r, 500)); // таах оролдлогыг удаашруулна
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

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

/* ---------------- унших ---------------- */

async function readAll(env) {
  const [customers, loans, settings, next, rev] = await env.DB.batch([
    env.DB.prepare(`SELECT data FROM customers`),
    env.DB.prepare(`SELECT data FROM loans ORDER BY ticket_no`),
    env.DB.prepare(`SELECT value FROM meta WHERE key = 'settings'`),
    env.DB.prepare(`SELECT value FROM meta WHERE key = 'next_ticket'`),
    env.DB.prepare(`SELECT value FROM meta WHERE key = 'rev'`),
  ]);
  return {
    settings: settings.results[0] ? JSON.parse(settings.results[0].value) : null,
    nextTicket: Number(next.results[0] ? next.results[0].value : 1) || 1,
    customers: customers.results.map((r) => JSON.parse(r.data)),
    loans: loans.results.map((r) => JSON.parse(r.data)),
    rev: rev.results[0] ? rev.results[0].value : '0',
  };
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

// body: { reset?, settings?, upsert: {customers, loans}, delete: {customers, loans} }
async function sync(env, body) {
  if (!body || typeof body !== 'object') throw fail(400, 'bad_body');
  const now = Date.now();
  const up = body.upsert || {};
  const del = body.delete || {};
  const customers = (Array.isArray(up.customers) ? up.customers : []).map((c) => cleanEntity(c, 'customer'));
  const loans = (Array.isArray(up.loans) ? up.loans : []).map((l) => cleanEntity(l, 'loan'));
  const delCustomers = cleanIds(del.customers);
  const delLoans = cleanIds(del.loans);
  const st = [];

  if (body.reset === true) {
    st.push(env.DB.prepare(`DELETE FROM customers`));
    st.push(env.DB.prepare(`DELETE FROM loans`));
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
        `INSERT INTO loans (id, ticket_no, customer_id, status, data, updated_at) VALUES ${part
          .map(() => '(?, ?, ?, ?, ?, ?)')
          .join(', ')}
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
  for (const part of chunk(delCustomers, IDS_PER_DELETE)) {
    st.push(env.DB.prepare(`DELETE FROM customers WHERE id IN (${part.map(() => '?').join(', ')})`).bind(...part));
  }
  for (const part of chunk(delLoans, IDS_PER_DELETE)) {
    st.push(env.DB.prepare(`DELETE FROM loans WHERE id IN (${part.map(() => '?').join(', ')})`).bind(...part));
  }
  if (body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)) {
    const s = Object.assign({}, body.settings);
    delete s.nextTicket;
    st.push(
      env.DB.prepare(
        `INSERT INTO meta (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(JSON.stringify(s))
    );
  }
  if (!st.length) return { ok: true, rev: await readRev(env) };
  if (st.length + 1 > MAX_STATEMENTS) throw fail(413, 'too_many', 'Send fewer records per request');
  const rev = revStatement(env);
  st.push(rev);
  await env.DB.batch(st);
  return { ok: true, written: customers.length + loans.length, deleted: delCustomers.length + delLoans.length };
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

async function setNextTicket(env, body) {
  const next = Math.trunc(Number(body && body.next));
  if (!Number.isFinite(next) || next < 1 || next > 1e9) throw fail(400, 'bad_next', 'Invalid ticket number');
  const max = await env.DB.prepare(`SELECT COALESCE(MAX(ticket_no), 0) AS m FROM loans`).first();
  const value = Math.max(next, (max ? Number(max.m) : 0) + 1);
  await env.DB.prepare(`UPDATE meta SET value = ? WHERE key = 'next_ticket'`).bind(String(value)).run();
  return { nextTicket: value };
}

async function wipe(env) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM customers`),
    env.DB.prepare(`DELETE FROM loans`),
    env.DB.prepare(`UPDATE meta SET value = '1' WHERE key = 'next_ticket'`),
    revStatement(env),
  ]);
  return { ok: true };
}
