// Ажилтны нэвтрэлт: нууц үгийг PBKDF2-оор хэшилж хадгална, нэвтэрсний дараа 30 хоногийн session токен олгоно.

// Үнэгүй хувилбарын нэг хүсэлтийн 10ms CPU хязгаарт багтах түвшин (~3ms)
const ITERATIONS = 20000;
const SESSION_DAYS = 30;
const CACHE_MS = 60_000;

const enc = new TextEncoder();
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${toHex(salt)}$${toHex(await pbkdf2(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password, stored) {
  const [alg, it, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2' || !it || !salt || !hash) return false;
  return sameBytes(await pbkdf2(String(password), fromHex(salt), Number(it)), fromHex(hash));
}

export async function sha256Hex(s) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

// APP_PASSWORD-тэй тэнцүү эсэхийг цагийн хувьд тэгш харьцуулна
export async function equalsSecret(given, secret) {
  // Хуулж буулгахад орсон эхний, сүүлийн хоосон зайг тооцохгүй
  given = String(given || '').trim(); secret = String(secret || '').trim();
  if (!given || !secret) return false;
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(secret)]);
  return sameBytes(fromHex(a), fromHex(b));
}

export function newToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export function cleanUsername(u) {
  return String(u || '').trim().toLowerCase();
}

export function validUsername(u) {
  return /^[a-z0-9._-]{3,32}$/.test(u);
}

export function publicUser(u) {
  return u ? { id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active } : null;
}

/* ---------------- session ---------------- */

const cache = new Map(); // token hash -> { user, exp, at }

export async function createSession(env, user) {
  const token = newToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).bind(
      await sha256Hex(token),
      user.id,
      now,
      now + SESSION_DAYS * 864e5
    ),
    env.DB.prepare(`UPDATE users SET last_login = ? WHERE id = ?`).bind(now, user.id),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now),
  ]);
  return token;
}

export async function sessionUser(env, request) {
  const h = request.headers.get('authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  const token = h.slice(7).trim();
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const th = await sha256Hex(token);
  const now = Date.now();
  const c = cache.get(th);
  if (c && now - c.at < CACHE_MS && c.exp > now) return { ...c.user, tokenHash: th };
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.name, u.role, u.active, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  )
    .bind(th, now)
    .first();
  if (!row || !row.active) {
    cache.delete(th);
    return null;
  }
  const user = publicUser(row);
  cache.set(th, { user, exp: row.expires_at, at: now });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return { ...user, tokenHash: th };
}

export async function endSession(env, tokenHash) {
  cache.delete(tokenHash);
  await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
}

export function forgetUserSessions(userId) {
  for (const [k, v] of cache) if (v.user.id === userId) cache.delete(k);
}
