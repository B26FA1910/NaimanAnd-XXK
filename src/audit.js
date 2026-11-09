// Засварын түүх: хэн, хэзээ, юуг өөрчилсөнийг хүний ойлгох өгүүлбэрээр бичнэ.

const money = (n) => String(Math.round(+n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '₮';
const date = (iso) => (iso ? String(iso).replace(/-/g, '/') : '');
const tno = (l) => '№' + String(l && l.ticketNo != null ? l.ticketNo : '').padStart(4, '0');
const val = (v) => (v === undefined || v === null || v === '' ? 'Хоосон' : String(v));
const METHOD = { cash: 'бэлэн', bank: 'данс' };
const method = (m) => METHOD[m] || METHOD.cash;

function fieldChanges(prev, next, fields, fmt = {}) {
  const out = [];
  for (const [k, label] of fields) {
    const a = prev ? prev[k] : undefined;
    const b = next ? next[k] : undefined;
    if (String(a ?? '') !== String(b ?? '')) {
      const f = fmt[k] || val;
      out.push(`${label} өөрчлөв ${f(a)}->${f(b)}`);
    }
  }
  return out;
}

export function personName(c) {
  if (!c) return '';
  return c.lastName ? `${String(c.lastName).trim().charAt(0)}.${c.firstName || ''}` : c.firstName || '';
}

/* ---------------- харилцагч ---------------- */

const CUSTOMER_FIELDS = [
  ['lastName', 'Овог'],
  ['firstName', 'Нэр'],
  ['regNo', 'Регистр дугаар'],
  ['phone', 'Утасны дугаар'],
  ['phone2', 'Нэмэлт гар утас'],
  ['address', 'Хаяг'],
  ['note', 'Тэмдэглэл'],
];

export function describeCustomer(prev, next) {
  if (!prev) return [`Харилцагч бүртгэв: ${personName(next)}${next.regNo ? ' (' + next.regNo + ')' : ''}`];
  if (!next) return [`Харилцагч устгав: ${personName(prev)}${prev.regNo ? ' (' + prev.regNo + ')' : ''}`];
  return fieldChanges(prev, next, CUSTOMER_FIELDS).map((t) => `${personName(next)}: ${t}`);
}

/* ---------------- зээл ---------------- */

function itemsOf(l, idHint) {
  if (Array.isArray(l.items)) return l.items;
  if (l.item && (l.item.name || l.item.category)) return [{ ...l.item, id: idHint || 'legacy' }];
  return [];
}

const ITEM_FIELDS = [
  ['category', 'Ангилал'],
  ['name', 'Тайлбар'],
  ['serial', 'Сериал'],
  ['weight', 'Жин'],
  ['purity', 'Сорьц'],
  ['est', 'Үнэлгээ'],
];

function eventText(e) {
  if (e.type === 'payment') return `төлөлт ${money(e.amount)} (${method(e.method)})`;
  if (e.type === 'extend') return `${e.req || e.days} хоногоор сунгав, шинэ хугацаа ${date(e.newDue)}`;
  if (e.type === 'redeem') return 'төлж хааж барьцааг олгов';
  if (e.type === 'forfeit') return 'барьцааг хураав';
  return '';
}

export function describeLoan(prev, next) {
  const l = next || prev;
  const T = tno(l);
  if (!prev) return [`${T} зээл олгов ${money(next.principal)} (${method(next.method)}), ${itemsOf(next).map((i) => i.name).filter(Boolean).join(', ')}`];
  if (!next) return [`${T} тасалбар устгав (${money(prev.principal)})`];
  const out = [];
  for (const t of fieldChanges(prev, next, [
    ['principal', 'Зээлийн дүн'],
    ['rate', 'Сарын хүү'],
    ['termDays', 'Хугацаа'],
    ['startDate', 'Олгосон огноо'],
    ['customerId', 'Харилцагч'],
    ['method', 'Олгосон хэлбэр'],
    ['note', 'Тэмдэглэл'],
  ], {
    principal: money,
    rate: (v) => val(v) + '%',
    termDays: (v) => val(v) + ' хоног',
    startDate: date,
    customerId: () => '',
    method: (v) => method(v),
  })) out.push(`${T} ${t.replace(' ->', '').replace(/Харилцагч өөрчлөв.*/, 'Харилцагч сольсон')}`);

  const nItems = itemsOf(next);
  const pItems = itemsOf(prev, nItems[0] && nItems[0].id);
  const pMap = new Map(pItems.map((i) => [i.id, i]));
  const nMap = new Map(nItems.map((i) => [i.id, i]));
  for (const i of nItems) {
    const p = pMap.get(i.id);
    if (!p) out.push(`${T} барьцаа нэмэв: ${i.name || ''}${i.est ? ' (' + money(i.est) + ')' : ''}`);
    else
      for (const t of fieldChanges(p, i, ITEM_FIELDS, { est: money }))
        out.push(`${T} барьцаа "${i.name || p.name || ''}" ${t}`);
  }
  for (const p of pItems) if (!nMap.has(p.id)) out.push(`${T} барьцаа хасав: ${p.name || ''}`);

  const pe = new Map((prev.events || []).map((e) => [e.id, e]));
  const ne = new Map((next.events || []).map((e) => [e.id, e]));
  for (const e of next.events || []) {
    const p = pe.get(e.id);
    if (!p) {
      if (e.type !== 'issue') out.push(`${T} ${eventText(e)}${e.date ? ' ' + date(e.date) : ''}`);
    } else if (e.type === 'payment' && (p.amount !== e.amount || p.date !== e.date || (p.method || 'cash') !== (e.method || 'cash'))) {
      out.push(`${T} төлөлт өөрчлөв ${money(p.amount)} ${date(p.date)}->${money(e.amount)} ${date(e.date)}`);
    } else if (e.type === 'issue' && p.date !== e.date) {
      /* олгосон огноо дээр бичигдсэн */
    }
  }
  for (const p of prev.events || []) {
    if (ne.has(p.id)) continue;
    if (p.type === 'payment') out.push(`${T} төлөлт устгав ${money(p.amount)} ${date(p.date)}`);
    else if (p.type === 'extend') out.push(`${T} сунгалт устгав`);
    else if (p.type === 'redeem' || p.type === 'forfeit') out.push(`${T} зээлийг дахин нээв`);
  }
  return out;
}

/* ---------------- гүйлгээ ---------------- */

const TXN_TYPE = { income: 'Орлого', expense: 'Зардал', transfer: 'Шилжүүлэлт' };
const ACCOUNT = { cash: 'Бэлэн', bank: 'Данс' };

function txnLabel(t) {
  if (t.type === 'transfer') return `Шилжүүлэлт ${ACCOUNT[t.from] || ''}->${ACCOUNT[t.to] || ''} ${money(t.amount)}`;
  return `${TXN_TYPE[t.type] || 'Гүйлгээ'}: ${t.category || ''} ${money(t.amount)}${t.desc ? ' "' + t.desc + '"' : ''}`;
}

export function describeTxn(prev, next) {
  if (!prev) return [`${txnLabel(next)} бүртгэв`];
  if (!next) return [`${txnLabel(prev)} устгав`];
  return fieldChanges(prev, next, [
    ['amount', 'Дүн'],
    ['category', 'Ангилал'],
    ['desc', 'Утга'],
    ['date', 'Огноо'],
    ['account', 'Данс'],
  ], { amount: money, date, account: (v) => ACCOUNT[v] || val(v) }).map((t) => `${txnLabel(next)}: ${t}`);
}

/* ---------------- хар жагсаалт ---------------- */

export function describeBlacklist(prev, next) {
  const b = next || prev;
  const who = `${b.regNo || ''}${b.name ? ' ' + b.name : ''}`.trim();
  if (!prev) return [`Хар жагсаалтад нэмэв: ${who} (${b.category || ''})`];
  if (!next) return [`Хар жагсаалтаас устгав: ${who}`];
  const out = fieldChanges(prev, next, [
    ['regNo', 'Регистр'],
    ['name', 'Нэр'],
    ['category', 'Ангилал'],
    ['note', 'Тайлбар'],
  ]).map((t) => `Хар жагсаалт ${who}: ${t}`);
  if ((prev.status || 'active') !== (next.status || 'active'))
    out.push(`Хар жагсаалт ${who}: ${next.status === 'inactive' ? 'идэвхгүй болгов' : 'идэвхжүүлэв'}`);
  return out;
}

/* ---------------- тохиргоо ---------------- */

const SETTINGS_FIELDS = [
  ['shopName', 'Ломбардын нэр'],
  ['phone', 'Утас'],
  ['address', 'Хаяг'],
  ['defaultRate', 'Үндсэн хүү'],
  ['defaultTerm', 'Үндсэн хугацаа'],
  ['badAfterDays', 'Муу зээл болох хоног'],
  ['terms', 'Тасалбарын нөхцөл'],
  ['smsEnabled', 'SMS сануулга'],
  ['smsRepeatDays', 'SMS давтамж'],
  ['smsLatin', 'SMS латинаар'],
  ['smsTemplate', 'SMS загвар'],
];

export function describeSettings(prev, next) {
  prev = prev || {};
  const out = fieldChanges(prev, next, SETTINGS_FIELDS, {
    terms: () => '',
    smsTemplate: () => '',
  }).map((t) => 'Тохиргоо: ' + t.replace(/ ->$/, ''));
  if (JSON.stringify(prev.categories || null) !== JSON.stringify(next.categories || null)) out.push('Тохиргоо: Барьцааны ангилал өөрчлөв');
  if (JSON.stringify(prev.txnCategories || null) !== JSON.stringify(next.txnCategories || null)) out.push('Тохиргоо: Гүйлгээний ангилал өөрчлөв');
  const po = prev.opening || {}, no = next.opening || {};
  if (po.date !== no.date || +po.cash !== +no.cash || +po.bank !== +no.bank)
    out.push(`Эхний үлдэгдэл өөрчлөв: ${date(no.date)} бэлэн ${money(no.cash)}, данс ${money(no.bank)}`);
  return out;
}

export function auditRows(user, now, kind, ref, texts) {
  return texts.filter(Boolean).map((t) => [now, user ? user.id : null, user ? user.username : '', kind, ref == null ? '' : String(ref), String(t).slice(0, 500)]);
}
