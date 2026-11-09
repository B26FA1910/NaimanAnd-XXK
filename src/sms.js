// Хугацаа хэтэрсэн зээлийн харилцагчид автоматаар SMS илгээх.
// SMS үйлчилгээ: MessagePro (CallPro). Cloudflare дээр SMS_API_KEY, SMS_FROM нууц утгуудыг нэмнэ.

const DEFAULT_ENDPOINT = 'https://api.callpro.mn/messagepro';
const MAX_SENDS_PER_RUN = 15; // үнэгүй хувилбарын нэг удаагийн 50 хүсэлтийн хязгаарт багтаана
const MAX_SENDS_PER_DUE = 5; // нэг хугацаанд хамгийн ихдээ 5 SMS
const MAX_FAILS_PER_DUE = 3; // 3 удаа бүтэлгүйтвэл дахин оролдохгүй

export const DEFAULT_SMS_TEMPLATE =
  '{SHOP}: Сайн байна уу, {NAME}. Таны {TICKET} зээлийн хугацаа {DUE}-нд дууссан. Төлөх дүн {AMOUNT}. Утас: {PHONE}';

/* ---------------- огноо, тооцоо (хуудсан дээрхтэй ижил) ---------------- */

const pad = (n) => String(n).padStart(2, '0');
const toUTC = (iso) => {
  const p = iso.split('-').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2]);
};
const addDays = (iso, n) => {
  const x = new Date(toUTC(iso) + n * 864e5);
  return x.getUTCFullYear() + '-' + pad(x.getUTCMonth() + 1) + '-' + pad(x.getUTCDate());
};
const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 864e5);

// Улаанбаатарын өнөөдрийн огноо (UTC+8)
export function ubToday(now = Date.now()) {
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
}

function events(l) {
  return (Array.isArray(l.events) ? l.events : [])
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.at || 0) - (b.at || 0)));
}

export function dueOf(l) {
  const ext = events(l)
    .filter((e) => e.type === 'extend')
    .reduce((s, e) => s + (+e.days || 0), 0);
  return addDays(l.startDate, (+l.termDays || 0) + ext);
}

// Өнөөдрийн байдлаарх өр: хүү үлдэгдэл дээр хоног тутам (сарын хүү / 30), төлбөр эхлээд хүүнд орно
export function owedOn(l, asOf) {
  const r = (+l.rate || 0) / 100 / 30;
  let bal = +l.principal || 0,
    acc = 0,
    last = l.startDate;
  for (const p of events(l).filter((e) => e.type === 'payment')) {
    acc = Math.round(acc + bal * r * Math.max(0, diffDays(last, p.date)));
    if (p.date > last) last = p.date;
    let a = +p.amount || 0;
    const ti = Math.min(a, acc);
    acc -= ti;
    a -= ti;
    const tp = Math.min(a, bal);
    bal -= tp;
  }
  acc = Math.round(acc + bal * r * Math.max(0, diffDays(last, asOf)));
  return bal + acc;
}

/* ---------------- текст ---------------- */

const fmtMoney = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '₮';
const fmtDate = (iso) => (iso ? iso.replace(/-/g, '.') : '');

export function renderSms(template, v) {
  return String(template || DEFAULT_SMS_TEMPLATE).replace(/\{(SHOP|NAME|TICKET|DUE|DAYS|AMOUNT|PHONE|ITEM)\}/g, (_, k) =>
    v[k] == null ? '' : String(v[k])
  );
}

const LAT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'ye', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', ө: 'u', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ү: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sh', ъ: 'i', ы: 'y', ь: 'i', э: 'e', ю: 'yu', я: 'ya',
};
// Кирилл үсгийг латинаар бичнэ: 160 тэмдэгт нэг SMS-д багтаж, хямд тусна
export function toLatin(s) {
  return String(s)
    .replace(/№\s*/g, 'No.')
    .replace(/₮/g, ' tug')
    .replace(/[«»“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[Ѐ-ӿ]/g, (ch) => {
      const lo = ch.toLowerCase();
      const t = LAT[lo];
      if (t === undefined) return '';
      return ch === lo ? t : t.charAt(0).toUpperCase() + t.slice(1);
    });
}

export function smsVars(l, c, settings, today) {
  const due = dueOf(l);
  return {
    SHOP: settings.shopName || 'Ломбард',
    NAME: (c && (c.firstName || c.lastName)) || '',
    TICKET: '№' + String(l.ticketNo).padStart(4, '0'),
    DUE: fmtDate(due),
    DAYS: Math.max(0, diffDays(due, today)),
    AMOUNT: fmtMoney(owedOn(l, today)),
    PHONE: settings.phone || '',
    ITEM: (Array.isArray(l.items) ? l.items.map((i) => i.name).filter(Boolean).join(', ') : l.item && l.item.name) || '',
  };
}

export function buildText(settings, vars) {
  const t = renderSms(settings.smsTemplate, vars).replace(/\s+/g, ' ').trim();
  return settings.smsLatin === false ? t : toLatin(t);
}

// 99112233, 9911-2233, +976 9911 2233 -> 99112233
export function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('976')) d = d.slice(3);
  return /^[5-9]\d{7}$/.test(d) ? d : null;
}

/* ---------------- SMS илгээх ---------------- */

export function smsConfigured(env) {
  return !!(env.SMS_API_KEY && env.SMS_FROM);
}

export async function sendSms(env, to, text) {
  const endpoint = String(env.SMS_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const url = endpoint + '/send?' + new URLSearchParams({ key: env.SMS_API_KEY, from: env.SMS_FROM, to, text });
  let res, body = '';
  try {
    res = await fetch(url, { headers: { 'x-api-key': env.SMS_API_KEY } });
    body = await res.text();
  } catch (e) {
    return { ok: false, info: 'Холболтын алдаа: ' + String((e && e.message) || e).slice(0, 150) };
  }
  let result = '', id = null;
  try {
    const j = JSON.parse(body);
    const r = Array.isArray(j) ? j[0] : j;
    if (r && typeof r === 'object') {
      result = String(r.Result ?? r.result ?? r.status ?? '');
      id = r['Message ID'] ?? r.message_id ?? r.id ?? null;
    }
  } catch {
    /* хариу JSON биш */
  }
  const ok = res.ok && (!result || /success|ok|sent|accepted/i.test(result));
  return {
    ok,
    info: ok ? (id != null ? 'ID ' + id : 'Илгээсэн') : ('HTTP ' + res.status + ' ' + (result || body).slice(0, 180)).trim(),
  };
}

/* ---------------- өдөр бүрийн ажил ---------------- */

export async function runOverdueSms(env, opts = {}) {
  const now = opts.now || Date.now();
  const today = ubToday(now);
  const [settingsR, loansR, custR, logR] = await env.DB.batch([
    env.DB.prepare(`SELECT value FROM meta WHERE key = 'settings'`),
    env.DB.prepare(`SELECT data FROM loans WHERE status = 'active'`),
    env.DB.prepare(
      `SELECT id, data FROM customers WHERE id IN (SELECT customer_id FROM loans WHERE status = 'active')`
    ),
    env.DB.prepare(
      `SELECT loan_id, due, status, created_at FROM sms_log
       WHERE loan_id IN (SELECT id FROM loans WHERE status = 'active') ORDER BY created_at, id`
    ),
  ]);
  const settings = settingsR.results[0] ? JSON.parse(settingsR.results[0].value) : {};
  if (!settings.smsEnabled) return { ok: true, enabled: false, sent: 0 };
  if (!smsConfigured(env)) return { ok: false, configured: false, sent: 0 };

  const repeat = Math.max(0, Math.trunc(+settings.smsRepeatDays || 0));
  const customers = new Map(custR.results.map((r) => [r.id, JSON.parse(r.data)]));
  const hist = new Map();
  for (const g of logR.results) {
    const k = g.loan_id + '|' + g.due;
    const h = hist.get(k) || { sent: 0, lastSent: null, fails: 0, skipped: false, today: false };
    const day = ubToday(Number(g.created_at));
    if (g.status === 'sent') {
      h.sent++;
      if (!h.lastSent || day > h.lastSent) h.lastSent = day;
      h.fails = 0;
    } else if (g.status === 'failed') h.fails++;
    else if (g.status === 'skipped') h.skipped = true;
    if (day === today && g.status !== 'failed') h.today = true;
    hist.set(k, h);
  }

  const due = [];
  for (const row of loansR.results) {
    const l = JSON.parse(row.data);
    const d = dueOf(l);
    const over = diffDays(d, today);
    if (over < 1) continue;
    const h = hist.get(l.id + '|' + d) || { sent: 0, lastSent: null, fails: 0, skipped: false, today: false };
    if (h.skipped || h.today || h.fails >= MAX_FAILS_PER_DUE || h.sent >= MAX_SENDS_PER_DUE) continue;
    if (h.sent > 0 && !(repeat > 0 && diffDays(h.lastSent, today) >= repeat)) continue;
    due.push({ l, d, over });
  }
  due.sort((a, b) => b.over - a.over || a.l.ticketNo - b.l.ticketNo);

  const batch = due.slice(0, MAX_SENDS_PER_RUN);
  const logs = [];
  let sent = 0, failed = 0, skipped = 0;
  for (const { l, d } of batch) {
    const c = customers.get(l.customerId);
    const phone = normalizePhone(c && c.phone);
    const text = buildText(settings, smsVars(l, c, settings, today));
    if (!phone) {
      skipped++;
      logs.push([l.id, l.ticketNo, d, (c && c.phone) || '', text, 'skipped', 'Утасны дугаар буруу', now]);
      continue;
    }
    const r = await sendSms(env, phone, text);
    if (r.ok) sent++;
    else failed++;
    logs.push([l.id, l.ticketNo, d, phone, text, r.ok ? 'sent' : 'failed', r.info, now]);
  }
  if (logs.length) await insertLogs(env, logs);
  return { ok: true, enabled: true, checked: loansR.results.length, overdue: due.length, sent, failed, skipped, remaining: due.length - batch.length };
}

export async function insertLogs(env, rows) {
  const st = [];
  for (let i = 0; i < rows.length; i += 12) {
    const part = rows.slice(i, i + 12); // 8 параметр x 12 = 96
    st.push(
      env.DB.prepare(
        `INSERT INTO sms_log (loan_id, ticket_no, due, phone, text, status, info, created_at) VALUES ${part
          .map(() => '(?, ?, ?, ?, ?, ?, ?, ?)')
          .join(', ')}`
      ).bind(...part.flat().map((v) => (v === undefined ? null : v)))
    );
  }
  await env.DB.batch(st);
}
