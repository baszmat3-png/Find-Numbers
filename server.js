'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
// مسار سري للوحة التحكم (مثال: ADMIN_PATH=panel-x7k29qd) — بدونه تبقى اللوحة معطّلة تمامًا
const ADMIN_PATH = (process.env.ADMIN_PATH || '').replace(/^\/+|\/+$/g, '');
const ADMIN_PATH_OK = /^[A-Za-z0-9_-]{8,64}$/.test(ADMIN_PATH);
if (ADMIN_PATH && !ADMIN_PATH_OK) console.warn('ADMIN_PATH غير صالح (8-64 حرفًا: حروف وأرقام و - _ فقط). اللوحة معطّلة.');

/* ---------- التخزين: PostgreSQL على Render، وملف JSON محليًا ---------- */
let store;

if (DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  store = {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        phone TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await pool.query('ALTER TABLE contacts ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE');
    },
    async list(all = false) {
      const r = await pool.query(
        all
          ? 'SELECT id, name, role, phone, hidden FROM contacts ORDER BY id DESC LIMIT 10000'
          : 'SELECT id, name, role, phone FROM contacts WHERE hidden = FALSE ORDER BY id DESC LIMIT 10000'
      );
      return r.rows;
    },
    async addMany(list) {
      await pool.query(
        'INSERT INTO contacts (name, role, phone) SELECT * FROM unnest($1::text[], $2::text[], $3::text[])',
        [list.map((c) => c.name), list.map((c) => c.role), list.map((c) => c.phone)]
      );
    },
    async setHidden(id, hidden) {
      const r = await pool.query('UPDATE contacts SET hidden = $1 WHERE id = $2', [!!hidden, id]);
      return r.rowCount > 0;
    },
    async add(c) {
      const r = await pool.query(
        'INSERT INTO contacts (name, role, phone) VALUES ($1,$2,$3) RETURNING id, name, role, phone, hidden',
        [c.name, c.role, c.phone]
      );
      return r.rows[0];
    },
    async update(id, c) {
      const r = await pool.query(
        'UPDATE contacts SET name=$1, role=$2, phone=$3 WHERE id=$4 RETURNING id, name, role, phone, hidden',
        [c.name, c.role, c.phone, id]
      );
      return r.rows[0] || null;
    },
    async remove(id) {
      const r = await pool.query('DELETE FROM contacts WHERE id = $1', [id]);
      return r.rowCount > 0;
    },
  };
} else {
  const dir = path.join(__dirname, 'data');
  const file = path.join(dir, 'contacts.json');
  let rows = [];
  let nextId = 1;
  const save = () => fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  store = {
    async init() {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(file)) rows = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
      nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
      console.log('تنبيه: DATABASE_URL غير موجود، يتم الحفظ في data/contacts.json (للتجربة المحلية فقط)');
    },
    async list(all = false) {
      const out = rows.slice().reverse();
      if (all) return out.map((r) => ({ ...r, hidden: !!r.hidden }));
      return out.filter((r) => !r.hidden).map(({ hidden, ...x }) => x);
    },
    async setHidden(id, hidden) {
      const r = rows.find((x) => x.id === id);
      if (!r) return false;
      r.hidden = !!hidden;
      save();
      return true;
    },
    async add(c) { const r = { id: nextId++, ...c, hidden: false }; rows.push(r); save(); return r; },
    async addMany(list) { list.forEach((c) => rows.push({ id: nextId++, ...c, hidden: false })); save(); },
    async update(id, c) {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      Object.assign(r, c);
      save();
      return r;
    },
    async remove(id) {
      const n = rows.length;
      rows = rows.filter((r) => r.id !== id);
      save();
      return rows.length < n;
    },
  };
}

/* ---------- حماية بسيطة من الإساءة (حد للطلبات لكل IP) ---------- */
function limiter(max, windowMs) {
  const hits = new Map(); // عدّاد مستقل لكل مسار
  setInterval(() => {
    const now = Date.now();
    for (const [ip, r] of hits) if (now - r.t > windowMs) hits.delete(ip);
  }, 600000).unref();
  return (req, res, next) => {
    const now = Date.now();
    const rec = hits.get(req.ip) || { n: 0, t: now };
    if (now - rec.t > windowMs) { rec.n = 0; rec.t = now; }
    rec.n++;
    hits.set(req.ip, rec);
    if (rec.n > max) return res.status(429).json({ error: 'طلبات كثيرة، حاول لاحقًا' });
    next();
  };
}

// توحيد رقم الهاتف إلى الصيغة الدولية: +9647501234567 (الافتراضي العراق +964)
function normalizePhone(raw) {
  let t = String(raw == null ? '' : raw)
    .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632)
    .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 1776)
    .replace(/[\s\-().]/g, '');
  if (t.startsWith('00')) t = '+' + t.slice(2);
  else if (t.startsWith('0')) t = '+964' + t.replace(/^0+/, '');
  else if (!t.startsWith('+')) t = t.startsWith('964') ? '+' + t : '+964' + t;
  return /^\+[1-9]\d{7,14}$/.test(t) ? t : '';
}

/* ---------- التطبيق ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const smallJson = express.json({ limit: '10kb' });
const bigJson = express.json({ limit: '2mb' });
app.use((req, res, next) => (req.path.endsWith('/import') ? next() : smallJson(req, res, next)));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.send('ok'));

/* ---------- التزامن الفوري (Server-Sent Events) ---------- */
const sseClients = new Set();
function broadcast() {
  for (const r of sseClients) { try { r.write('event: change\ndata: 1\n\n'); } catch (e) { sseClients.delete(r); } }
}
setInterval(() => { for (const r of sseClients) { try { r.write(': ping\n\n'); } catch (e) { sseClients.delete(r); } } }, 25000).unref();
app.get('/api/events', (req, res) => {
  if (sseClients.size >= 3000) return res.status(503).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/contacts', async (req, res) => {
  try { res.json(await store.list()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/contacts', limiter(20, 60 * 60 * 1000), async (req, res) => {
  const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const name = clean(req.body.name, 80);
  const role = clean(req.body.role, 80);
  if (!name || !role || !clean(req.body.phone, 30)) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
  const phone = normalizePhone(clean(req.body.phone, 30));
  if (!phone) return res.status(400).json({ error: 'رقم الهاتف غير صالح' });
  try { const c = await store.add({ name, role, phone }); broadcast(); res.status(201).json(c); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- لوحة التحكم (للمسؤول فقط عبر ADMIN_KEY) ---------- */
const crypto = require('crypto');
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const authFails = new Map();
setInterval(() => { const now = Date.now(); for (const [ip, f] of authFails) if (now - f.t > 900000) authFails.delete(ip); }, 600000).unref();
function adminAuth(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'لم يتم ضبط ADMIN_KEY على الخادم' });
  const now = Date.now();
  let f = authFails.get(req.ip);
  if (f && now - f.t > 900000) f = null;
  if (f && f.n >= 10) return res.status(429).json({ error: 'محاولات كثيرة، حاول بعد 15 دقيقة' });
  if (!safeEqual(req.get('x-admin-key') || '', ADMIN_KEY)) {
    f = f || { n: 0, t: now };
    f.n++;
    authFails.set(req.ip, f);
    return res.status(403).json({ error: 'مفتاح المسؤول غير صحيح' });
  }
  next();
}
const cleanField = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
function validContact(body) {
  const name = cleanField(body.name, 80), role = cleanField(body.role, 80), rawPhone = cleanField(body.phone, 30);
  if (!name || !rawPhone) return { error: 'الاسم والرقم مطلوبان' };
  const phone = normalizePhone(rawPhone);
  if (!phone) return { error: 'رقم الهاتف غير صالح' };
  return { c: { name, role, phone } };
}
const idOf = (req) => { const n = parseInt(req.params.id, 10); return Number.isInteger(n) ? n : null; };

// لا يوجد أي رابط عام للوحة: تُفتح فقط عبر المسار السري، وأي مسار آخر (مثل /admin) يعطي 404
if (ADMIN_PATH_OK) {
  app.get('/' + ADMIN_PATH, (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'views', 'admin.html'));
  });
}

app.get('/api/admin/check', adminAuth, (req, res) => res.json({ ok: true }));

// كل الأسماء بما فيها المخفية (للمسؤول فقط)
app.get('/api/admin/contacts', adminAuth, async (req, res) => {
  try { res.json(await store.list(true)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); }
});

// إخفاء/إظهار جهة اتصال عن الزوار
app.patch('/api/admin/contacts/:id/hidden', adminAuth, async (req, res) => {
  const id = idOf(req);
  if (id === null) return res.status(400).json({ error: 'معرّف غير صالح' });
  if (typeof req.body.hidden !== 'boolean') return res.status(400).json({ error: 'قيمة غير صالحة' });
  try {
    const ok = await store.setHidden(id, req.body.hidden);
    if (!ok) return res.status(404).json({ error: 'غير موجود' });
    broadcast();
    res.json({ id, hidden: req.body.hidden });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/admin/contacts', adminAuth, async (req, res) => {
  const v = validContact(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  try { const c = await store.add(v.c); broadcast(); res.status(201).json(c); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.put('/api/admin/contacts/:id', adminAuth, async (req, res) => {
  const id = idOf(req);
  if (id === null) return res.status(400).json({ error: 'معرّف غير صالح' });
  const v = validContact(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const r = await store.update(id, v.c);
    if (!r) return res.status(404).json({ error: 'غير موجود' });
    broadcast();
    res.json(r);
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.delete('/api/admin/contacts/:id', adminAuth, async (req, res) => {
  const id = idOf(req);
  if (id === null) return res.status(400).json({ error: 'معرّف غير صالح' });
  try { const deleted = await store.remove(id); broadcast(); res.json({ deleted }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); }
});

// توافق مع المسار القديم للحذف
app.delete('/api/contacts/:id', adminAuth, async (req, res) => {
  const id = idOf(req);
  if (id === null) return res.status(400).json({ error: 'معرّف غير صالح' });
  try { const deleted = await store.remove(id); broadcast(); res.json({ deleted }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- استيراد جهات الاتصال (ملف Excel / CSV / VCF يُحلَّل في المتصفح ثم يُرسل هنا) ---------- */
function makeImport(max) {
  return async (req, res) => {
    const list = req.body && req.body.contacts;
    if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'لا توجد جهات اتصال للاستيراد' });
    if (list.length > max) return res.status(413).json({ error: 'الحد الأقصى ' + max + ' جهة اتصال في المرة الواحدة' });
    try {
      const seen = new Set((await store.list(true)).map((c) => normalizePhone(c.phone) || c.phone));
      let duplicates = 0, invalid = 0;
      const fresh = [];
      for (const it of list) {
        const name = cleanField(it && it.name, 80);
        const role = cleanField(it && it.role, 80);
        const phone = normalizePhone(cleanField(it && it.phone, 30));
        if (!name || !phone) { invalid++; continue; }
        if (seen.has(phone)) { duplicates++; continue; }
        seen.add(phone);
        fresh.push({ name, role, phone });
      }
      if (fresh.length) { await store.addMany(fresh); broadcast(); }
      res.json({ added: fresh.length, duplicates, invalid });
    } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ في الخادم' }); }
  };
}
// للجميع: حد 5 عمليات استيراد في الساعة و1000 جهة في كل مرة
app.post('/api/contacts/import', limiter(5, 60 * 60 * 1000), bigJson, makeImport(1000));
// للمسؤول: حتى 10000 جهة
app.post('/api/admin/contacts/import', adminAuth, bigJson, makeImport(10000));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'حجم البيانات كبير جدًا' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'طلب غير صالح' });
  console.error(err);
  res.status(500).json({ error: 'خطأ في الخادم' });
});

store.init()
  .then(() => app.listen(PORT, () => console.log('يعمل على المنفذ ' + PORT)))
  .catch((e) => { console.error('فشل التهيئة:', e); process.exit(1); });
