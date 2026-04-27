const express = require('express');
const mysql = require('mysql2/promise');
const { PKPass } = require('passkit-generator');
const fs = require('fs');
const path = require('path');
const http2 = require('http2');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const { GoogleAuth } = require('google-auth-library');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(cors());

// ─── إعدادات قابلة للتعديل ─────────────────────────────────────────────────
const CONFIG = {
  // Apple Wallet
  passTypeIdentifier: 'pass.com.drrose.loyalty',
  teamIdentifier: 'FUWS48W4JP',
  authenticationToken: 'drrose2024securetoken5678',
  webServiceURL: 'https://dr-rose-loyalty-production.up.railway.app/',

  // APNs
  apnsKeyId: '77B9MGGJBA',
  apnsTeamId: 'FUWS48W4JP',

  // Google Wallet
  issuerId: 'XXXXXXXXXXXXXXXXXX',                      // ← Google Wallet Issuer ID
  classId: 'XXXXXXXXXXXXXXXXXX.dr_rose_loyalty',       // ← ISSUER_ID.اسم_الكلاس

  // DB
  db: {
    host: 'auth-db1904.hstgr.io',
    user: 'u565452571_hassan',
    password: 'DrRose@2008R',
    database: 'u565452571_dr_rose_loyalt',
  },

  // Admin
  adminPassword: 'DrRose@Admin2024',

  // رابط السيرفر
  serverURL: 'https://dr-rose-loyalty-production.up.railway.app',
};
// ──────────────────────────────────────────────────────────────────────────────

// ─── قاعدة البيانات ──────────────────────────────────────────────────────────
let pool;
async function getDB() {
  if (!pool) {
    pool = mysql.createPool({
      ...CONFIG.db,
      waitForConnections: true,
      connectionLimit: 10,
    });
  }
  return pool;
}

// ─── مسارات الملفات ──────────────────────────────────────────────────────────
const PASS_MODEL  = path.join(__dirname, 'pass.pass');
const CERTS_DIR   = path.join(__dirname, 'certs');
const CUPS_DIR    = path.join(__dirname, 'images');
const PASS_JSON   = path.join(PASS_MODEL, 'pass.json');
const APNS_KEY    = path.join(CERTS_DIR, `AuthKey_${CONFIG.apnsKeyId}.p8`);
const SETTINGS_FILE = path.join(__dirname, 'pass-settings.json');

// ─── إعدادات البطاقة (قابلة للتعديل من لوحة الأدمن) ─────────────────────────
function loadPassSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  }
  return {
    backgroundColor:  'rgb(250,245,248)',
    foregroundColor:  'rgb(70,35,55)',
    labelColor:       'rgb(180,120,150)',
    logoText:         'DR ROSE',
    organizationName: 'Dr Rose',
    description:      'بطاقة ولاء د. روز للورد',
    rewardText:       'خصم 50% على فاتورتك أو بوكيه مجاني 💐 بعد كل 5 زيارات',
    stripMode:        'single',   // 'single' = صورة واحدة | 'per-visit' = لكل زيارة
  };
}

function savePassSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

// ─── multer لرفع الصور ────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('الملف يجب أن يكون صورة'));
  },
});

// ─── الشهادات ────────────────────────────────────────────────────────────────
function getCerts() {
  return {
    wwdr:       fs.readFileSync(path.join(CERTS_DIR, 'wwdr.pem')),
    signerCert: fs.readFileSync(path.join(CERTS_DIR, 'pass.pem')),
    signerKey:  fs.readFileSync(path.join(CERTS_DIR, 'pass.key')),
  };
}

// ─── منطق صور الزيارات ───────────────────────────────────────────────────────
// 0-4 زيارات → 0.png..4.png | 5 → 5.png (اكتملت الدورة)
function getStripFiles(visits) {
  const n = Math.min(visits, 5);
  return {
    'strip.png':   fs.readFileSync(path.join(CUPS_DIR, `${n}.png`)),
    'strip@2x.png': fs.readFileSync(path.join(CUPS_DIR, `${n}@2x.png`)),
  };
}

// ─── بناء بطاقة Apple Wallet ────────────────────────────────────────────────
async function makePass(customer) {
  const S = loadPassSettings();

  // 1. تحديث pass.json بالإعدادات الحالية
  const passJson = JSON.parse(fs.readFileSync(PASS_JSON, 'utf8'));
  passJson.serialNumber    = String(customer.customer_number);
  passJson.backgroundColor = S.backgroundColor;
  passJson.foregroundColor = S.foregroundColor;
  passJson.labelColor      = S.labelColor;
  passJson.logoText        = S.logoText;
  passJson.organizationName = S.organizationName;
  passJson.description     = S.description;
  fs.writeFileSync(PASS_JSON, JSON.stringify(passJson, null, 2));

  // 2. حساب الزيارات
  const visitsCycle = customer.visits % 5;
  const remaining   = customer.status === 'free_pending' ? 0 : 5 - visitsCycle;

  // 3. رسالة الإشعار
  let notifValue = customer.last_notification_sent || '';
  if (customer.notification_msg && customer.notification_msg !== customer.last_notification_sent) {
    notifValue = customer.notification_msg;
  }

  // 4. بناء البطاقة
  const pass = await PKPass.from(
    { model: PASS_MODEL, certificates: getCerts() },
    { serialNumber: String(customer.customer_number) }
  );

  pass.setBarcodes({
    message: String(customer.customer_number),
    format: 'PKBarcodeFormatQR',
    messageEncoding: 'iso-8859-1',
    altText: String(customer.customer_number),
  });

  // الحقول — مشابهة لتصميم AK SPA
  if (customer.status === 'free_pending') {
    // عندها مكافأة
    pass.secondaryFields.push(
      { key: 'collected', label: 'طوابع تم جمعها', value: '5 مكافآت 🎁', textAlignment: 'PKTextAlignmentRight' },
      { key: 'remaining', label: 'الطوابع حتى المكافأة', value: '0 طوابع',   textAlignment: 'PKTextAlignmentLeft'  }
    );
  } else {
    pass.secondaryFields.push(
      { key: 'collected', label: 'طوابع تم جمعها',      value: `${visitsCycle} مكافآت`, textAlignment: 'PKTextAlignmentRight' },
      { key: 'remaining', label: 'الطوابع حتى المكافأة', value: `${remaining} طوابع`,    textAlignment: 'PKTextAlignmentLeft'  }
    );
  }

  pass.auxiliaryFields.push(
    { key: 'customerName', label: 'العميل', value: customer.name, textAlignment: 'PKTextAlignmentRight' }
  );

  pass.backFields.push(
    { key: 'freeEarned',  label: 'مكافآت مكتسبة',  value: String(customer.free_visits) },
    { key: 'totalVisits', label: 'إجمالي الزيارات', value: String(customer.visits) },
    { key: 'cycleStart',  label: 'بداية الدورة',    value: customer.cycle_start ? new Date(customer.cycle_start).toLocaleDateString('ar-SA') : '' },
    { key: 'lastVisit',   label: 'آخر زيارة',       value: customer.last_visit  ? new Date(customer.last_visit).toLocaleDateString('ar-SA')  : '' },
    { key: 'reward',      label: 'المكافأة',         value: S.rewardText },
    { key: 'updated',     label: 'آخر تحديث',       value: new Date().toLocaleString('ar-SA') },
    { key: 'notification', label: 'رسالة',           value: notifValue, changeMessage: '%@' }
  );

  // 6. صورة الشريط — single أو per-visit
  if (S.stripMode === 'per-visit') {
    const n = Math.min(customer.visits % 5, 5);
    const p1 = path.join(CUPS_DIR, `${n}.png`);
    const p2 = path.join(CUPS_DIR, `${n}@2x.png`);
    pass.addBuffer('strip.png',    fs.existsSync(p1) ? fs.readFileSync(p1) : fs.readFileSync(path.join(PASS_MODEL, 'strip.png')));
    pass.addBuffer('strip@2x.png', fs.existsSync(p2) ? fs.readFileSync(p2) : fs.readFileSync(path.join(PASS_MODEL, 'strip@2x.png')));
  } else {
    pass.addBuffer('strip.png',    fs.readFileSync(path.join(PASS_MODEL, 'strip.png')));
    pass.addBuffer('strip@2x.png', fs.readFileSync(path.join(PASS_MODEL, 'strip@2x.png')));
  }

  return pass.getAsBuffer();
}

// ─── بطاقة موقوفة ────────────────────────────────────────────────────────────
async function makeRevokedPass(customer) {
  const passJson = JSON.parse(fs.readFileSync(PASS_JSON, 'utf8'));
  passJson.serialNumber = String(customer.customer_number);
  fs.writeFileSync(PASS_JSON, JSON.stringify(passJson, null, 2));

  const pass = await PKPass.from(
    { model: PASS_MODEL, certificates: getCerts() },
    { serialNumber: String(customer.customer_number) }
  );

  pass.setBarcodes({
    message: 'تواصل مع المتجر',
    format: 'PKBarcodeFormatQR',
    messageEncoding: 'utf-8',
  });

  pass.secondaryFields.push(
    { key: 'status',       label: 'الحالة', value: '🚫 موقوفة', textAlignment: 'PKTextAlignmentRight' },
    { key: 'customerName', label: 'الاسم',  value: customer.name, textAlignment: 'PKTextAlignmentLeft' }
  );

  pass.auxiliaryFields.push(
    { key: 'reason', label: 'السبب', value: customer.revoke_reason || '', textAlignment: 'PKTextAlignmentCenter' }
  );

  pass.backFields.push(
    { key: 'freeEarned',   label: 'مكافآت مكتسبة', value: String(customer.free_visits) },
    { key: 'lastVisit',    label: 'آخر زيارة',       value: customer.last_visit ? new Date(customer.last_visit).toLocaleDateString('ar-SA') : '' },
    { key: 'updated',      label: 'آخر تحديث',       value: new Date().toLocaleString('ar-SA') },
    { key: 'notification', label: 'رسالة',            value: customer.last_notification_sent || '', changeMessage: '%@' }
  );

  // صورة الشريط — الورد مع تعتيم
  pass.addBuffer('strip.png',    fs.readFileSync(path.join(PASS_MODEL, 'strip.png')));
  pass.addBuffer('strip@2x.png', fs.readFileSync(path.join(PASS_MODEL, 'strip@2x.png')));

  return pass.getAsBuffer();
}

// ─── APNs Push ───────────────────────────────────────────────────────────────
async function sendPush(pushToken) {
  try {
    const apnsKey = fs.readFileSync(APNS_KEY, 'utf8');
    const jwtToken = jwt.sign({}, apnsKey, {
      algorithm: 'ES256',
      keyid: CONFIG.apnsKeyId,
      issuer: CONFIG.apnsTeamId,
      expiresIn: '1h',
    });

    const client = http2.connect('https://api.push.apple.com');

    return new Promise((resolve, reject) => {
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${pushToken}`,
        ':scheme': 'https',
        ':authority': 'api.push.apple.com',
        'authorization': `bearer ${jwtToken}`,
        'apns-topic': CONFIG.passTypeIdentifier,
        'apns-push-type': 'background',
        'content-type': 'application/json',
      });

      req.write(JSON.stringify({ aps: {} }));
      req.end();

      let status = 0;
      req.on('response', (headers) => { status = headers[':status']; });
      req.on('data', () => {});
      req.on('end', () => {
        client.close();
        resolve(status);
      });
      req.on('error', (err) => { client.close(); reject(err); });
    });
  } catch (err) {
    console.error('APNs error:', err.message);
    return null;
  }
}

// ─── Google Wallet ────────────────────────────────────────────────────────────
const googleCredentials = JSON.parse(
  fs.existsSync(path.join(__dirname, 'google-credentials.json'))
    ? fs.readFileSync(path.join(__dirname, 'google-credentials.json'), 'utf8')
    : '{}'
);

async function getGoogleToken() {
  const auth = new GoogleAuth({
    credentials: googleCredentials,
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

function getGooglePassObject(customer) {
  const totalVisits = customer.visits % 5;
  const heroIdx = Math.min(totalVisits, 5);
  return {
    id: `${CONFIG.classId}.customer_${customer.customer_number}`,
    classId: CONFIG.classId,
    state: customer.revoked ? 'INACTIVE' : 'ACTIVE',
    loyaltyPoints: {
      balance: { string: `${totalVisits}/5` },
      label: 'الزيارات',
    },
    accountId: String(customer.customer_number),
    accountName: customer.name,
    barcode: {
      type: 'QR_CODE',
      value: String(customer.customer_number),
      alternateText: String(customer.customer_number),
    },
    heroImage: {
      sourceUri: { uri: `${CONFIG.serverURL}/images/${heroIdx}.png` },
      contentDescription: { defaultValue: { language: 'ar', value: `${heroIdx} كوب` } },
    },
    textModulesData: [
      {
        id: 'status',
        header: 'الحالة',
        body: customer.status === 'free_pending' ? '🎁 خصم 50% على فاتورتك القادمة!' : 'عادي',
      },
      {
        id: 'city',
        header: 'المدينة',
        body: customer.city || '',
      },
    ],
  };
}

async function updateGooglePass(customer) {
  try {
    const token = await getGoogleToken();
    const objectId = `${CONFIG.classId}.customer_${customer.customer_number}`;
    const url = `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/${encodeURIComponent(objectId)}`;

    const checkRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    const body = getGooglePassObject(customer);

    if (checkRes.status === 200) {
      await fetch(url, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      await fetch(
        `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
    }
  } catch (err) {
    console.error('Google Wallet update error:', err.message);
  }
}

// ─── helper: تحديث pass_updated_at وإرسال Push لكل أجهزة العميل ─────────────
async function triggerAppleUpdate(db, customer) {
  await db.execute(
    'UPDATE loyalty_customers SET pass_updated_at = NOW() WHERE id = ?',
    [customer.id]
  );
  const [devices] = await db.execute(
    `SELECT wd.push_token
     FROM wallet_registrations wr
     JOIN wallet_devices wd ON wd.device_id = wr.device_id
     WHERE wr.pass_serial = ?`,
    [String(customer.customer_number)]
  );
  for (const d of devices) {
    if (d.push_token) await sendPush(d.push_token);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Apple Wallet WebService Endpoints
// ═══════════════════════════════════════════════════════════════════════════════

// تسجيل جهاز
app.post('/v1/devices/:deviceId/registrations/:passTypeId/:serial', async (req, res) => {
  try {
    const { deviceId, serial } = req.params;
    const { pushToken } = req.body;
    const db = await getDB();

    await db.execute(
      'INSERT INTO wallet_devices (device_id, push_token) VALUES (?, ?) ON DUPLICATE KEY UPDATE push_token = ?',
      [deviceId, pushToken, pushToken]
    );
    await db.execute(
      'INSERT IGNORE INTO wallet_registrations (device_id, pass_serial, pass_type_id) VALUES (?, ?, ?)',
      [deviceId, serial, CONFIG.passTypeIdentifier]
    );

    // علّم had_apple
    await db.execute(
      'UPDATE loyalty_customers SET had_apple = 1 WHERE customer_number = ?',
      [serial]
    );

    res.status(201).json({ status: 'registered' });
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// حذف تسجيل جهاز
app.delete('/v1/devices/:deviceId/registrations/:passTypeId/:serial', async (req, res) => {
  try {
    const { deviceId, serial } = req.params;
    const db = await getDB();
    await db.execute(
      'DELETE FROM wallet_registrations WHERE device_id = ? AND pass_serial = ?',
      [deviceId, serial]
    );
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// قائمة serials للجهاز
app.get('/v1/devices/:deviceId/registrations/:passTypeId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const db = await getDB();
    const [rows] = await db.execute(
      'SELECT pass_serial FROM wallet_registrations WHERE device_id = ?',
      [deviceId]
    );
    if (!rows.length) return res.sendStatus(204);
    res.json({ serialNumbers: rows.map(r => r.pass_serial), lastUpdated: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// تحميل/تحديث البطاقة
app.get('/v1/passes/:passTypeId/:serial', async (req, res) => {
  try {
    const { serial } = req.params;
    const db = await getDB();
    const [[customer]] = await db.execute(
      'SELECT * FROM loyalty_customers WHERE customer_number = ?',
      [serial]
    );
    if (!customer) return res.sendStatus(404);

    // التحقق من If-Modified-Since
    const ifModified = req.headers['if-modified-since'];
    if (ifModified && customer.pass_updated_at) {
      const since = new Date(ifModified);
      const updated = new Date(customer.pass_updated_at);
      if (updated <= since) return res.sendStatus(304);
    }

    const buf = customer.revoked ? await makeRevokedPass(customer) : await makePass(customer);

    res.set({
      'Content-Type': 'application/vnd.apple.pkpass',
      'Last-Modified': new Date(customer.pass_updated_at || new Date()).toUTCString(),
    });
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// لوق Apple
app.get('/v1/log', (req, res) => {
  console.log('Apple Log:', JSON.stringify(req.body));
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  إدارة العملاء
// ═══════════════════════════════════════════════════════════════════════════════

// كل العملاء
app.get('/customers', async (req, res) => {
  try {
    const db = await getDB();
    const [rows] = await db.execute(
      `SELECT lc.*,
              (SELECT COUNT(*) FROM wallet_registrations wr WHERE wr.pass_serial = lc.customer_number) AS has_apple
       FROM loyalty_customers lc
       ORDER BY lc.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// تسجيل عميل جديد
app.post('/customer', async (req, res) => {
  try {
    const { name, phone, city } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'الاسم والجوال مطلوبان' });

    const db = await getDB();

    // تحقق من وجود العميل
    const [[existing]] = await db.execute('SELECT * FROM loyalty_customers WHERE phone = ?', [phone]);
    if (existing) return res.status(409).json({ error: 'العميل مسجّل مسبقاً', customer: existing });

    // رقم العميل التالي (يبدأ من 10000)
    const [[maxRow]] = await db.execute('SELECT MAX(customer_number) AS mx FROM loyalty_customers');
    const customerNumber = (maxRow.mx || 9999) + 1;

    await db.execute(
      'INSERT INTO loyalty_customers (customer_number, name, phone, city, visits, free_visits, status, cycle_start) VALUES (?, ?, ?, ?, 0, 0, "normal", NOW())',
      [customerNumber, name, phone, city || '']
    );

    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE phone = ?', [phone]);
    res.status(201).json(customer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// التحقق من وجود العميل
app.get('/check-customer/:phone', async (req, res) => {
  try {
    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE phone = ?', [req.params.phone]);
    if (!customer) return res.json({ exists: false });
    res.json({ exists: true, customer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// بيانات العميل + سجل الزيارات (بالجوال)
app.get('/customer-info/:phone', async (req, res) => {
  try {
    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE phone = ?', [req.params.phone]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });

    const [visits] = await db.execute(
      'SELECT * FROM visit_logs WHERE customer_id = ? ORDER BY visited_at DESC',
      [customer.id]
    );
    res.json({ ...customer, visit_logs: visits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// بيانات العميل (برقم البطاقة)
app.get('/customer-info-by-number/:n', async (req, res) => {
  try {
    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE customer_number = ?', [req.params.n]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });

    const [visits] = await db.execute(
      'SELECT * FROM visit_logs WHERE customer_id = ? ORDER BY visited_at DESC',
      [customer.id]
    );
    res.json({ ...customer, visit_logs: visits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  الزيارات
// ═══════════════════════════════════════════════════════════════════════════════

async function recordVisit(db, customer, orderNumber = '') {
  // لا تُسجَّل زيارتان في 6 ساعات
  if (customer.last_visit) {
    const diff = (Date.now() - new Date(customer.last_visit).getTime()) / 3600000;
    if (diff < 6) {
      return { success: false, reason: 'تم تسجيل زيارة مؤخراً، يرجى الانتظار 6 ساعات' };
    }
  }

  // إعادة ضبط الدورة إذا مرّت 240 يوماً (8 أشهر)
  if (customer.cycle_start) {
    const daysSince = (Date.now() - new Date(customer.cycle_start).getTime()) / 86400000;
    if (daysSince >= 240) {
      await db.execute(
        'UPDATE loyalty_customers SET visits = 0, status = "normal", cycle_start = NOW() WHERE id = ?',
        [customer.id]
      );
      customer.visits = 0;
      customer.status = 'normal';
    }
  }

  const newVisits = (customer.visits || 0) + 1;
  const visitNumber = newVisits;
  let newStatus = customer.status;
  let newFreeVisits = customer.free_visits || 0;
  let freeEarnedAt = customer.free_visit_earned_at;

  // كل 5 زيارات → مكافأة
  if (newVisits % 5 === 0) {
    newStatus = 'free_pending';
    newFreeVisits += 1;
    freeEarnedAt = new Date();
  }

  await db.execute(
    `UPDATE loyalty_customers
     SET visits = ?, status = ?, free_visits = ?, last_visit = NOW(),
         free_visit_earned_at = ?, pass_updated_at = NOW()
     WHERE id = ?`,
    [newVisits, newStatus, newFreeVisits, freeEarnedAt, customer.id]
  );

  await db.execute(
    'INSERT INTO visit_logs (customer_id, visit_number, order_number) VALUES (?, ?, ?)',
    [customer.id, visitNumber, orderNumber]
  );

  // تحديث Google Wallet
  const [[updated]] = await db.execute('SELECT * FROM loyalty_customers WHERE id = ?', [customer.id]);
  updateGooglePass(updated).catch(() => {});
  await triggerAppleUpdate(db, updated);

  return { success: true, visits: newVisits, status: newStatus, customer: updated };
}

// تسجيل زيارة بالجوال
app.post('/visit/:phone', async (req, res) => {
  try {
    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE phone = ?', [req.params.phone]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });
    if (customer.revoked) return res.status(403).json({ error: 'البطاقة موقوفة' });

    const result = await recordVisit(db, customer, req.body.orderNumber || '');
    if (!result.success) return res.status(429).json({ error: result.reason });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// تسجيل زيارة برقم البطاقة (للكاشير)
app.post('/visit-by-number/:number', async (req, res) => {
  try {
    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE customer_number = ?', [req.params.number]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });
    if (customer.revoked) return res.status(403).json({ error: 'البطاقة موقوفة' });

    const result = await recordVisit(db, customer, req.body.orderNumber || '');
    if (!result.success) return res.status(429).json({ error: result.reason });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// استبدال المكافأة (خصم 50% أو بوكيه مجاني) — بالجوال أو رقم البطاقة
async function redeemReward(db, customer, rewardType = 'discount') {
  // تحقق من مهلة 10 أيام
  if (customer.free_visit_earned_at) {
    const days = (Date.now() - new Date(customer.free_visit_earned_at).getTime()) / 86400000;
    if (days > 10) {
      await db.execute(
        'UPDATE loyalty_customers SET status = "normal", visits = 0, cycle_start = NOW(), pass_updated_at = NOW() WHERE id = ?',
        [customer.id]
      );
      const [[updated]] = await db.execute('SELECT * FROM loyalty_customers WHERE id = ?', [customer.id]);
      await triggerAppleUpdate(db, updated);
      updateGooglePass(updated).catch(() => {});
      return { expired: true };
    }
  }

  const rewardLabel = rewardType === 'bouquet' ? 'بوكيه مجاني 💐' : 'خصم 50%';

  await db.execute(
    `UPDATE loyalty_customers
     SET status = "normal", visits = 0, cycle_start = NOW(),
         free_visit_earned_at = NULL, pass_updated_at = NOW()
     WHERE id = ?`,
    [customer.id]
  );

  // سجّل في visit_logs نوع المكافأة
  await db.execute(
    'INSERT INTO visit_logs (customer_id, visit_number, order_number) VALUES (?, ?, ?)',
    [customer.id, 0, `مكافأة: ${rewardLabel}`]
  );

  const [[updated]] = await db.execute('SELECT * FROM loyalty_customers WHERE id = ?', [customer.id]);
  await triggerAppleUpdate(db, updated);
  updateGooglePass(updated).catch(() => {});
  return { success: true, customer: updated, rewardLabel };
}

app.post('/redeem-free/:phone', async (req, res) => {
  try {
    const { rewardType } = req.body; // 'discount' | 'bouquet'
    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE phone = ?', [req.params.phone]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });
    if (customer.status !== 'free_pending') return res.status(400).json({ error: 'لا يوجد مكافأة متاحة للاستبدال' });

    const result = await redeemReward(db, customer, rewardType);
    if (result.expired) return res.status(410).json({ error: 'انتهت مهلة الاستبدال (10 أيام)، تم تصفير الزيارات' });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// استبدال برقم البطاقة (للكاشير)
app.post('/redeem-by-number/:serial', async (req, res) => {
  try {
    const { rewardType } = req.body;
    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE customer_number = ?', [req.params.serial]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });
    if (customer.status !== 'free_pending') return res.status(400).json({ error: 'لا يوجد مكافأة متاحة للاستبدال' });

    const result = await redeemReward(db, customer, rewardType);
    if (result.expired) return res.status(410).json({ error: 'انتهت مهلة الاستبدال (10 أيام)، تم تصفير الزيارات' });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// حذف آخر زيارة (للتصحيح)
app.post('/remove-visit/:serial', async (req, res) => {
  try {
    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE customer_number = ?', [req.params.serial]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });
    if (customer.visits <= 0) return res.status(400).json({ error: 'لا توجد زيارات للحذف' });

    const newVisits = customer.visits - 1;
    await db.execute(
      'UPDATE loyalty_customers SET visits = ?, status = "normal", pass_updated_at = NOW() WHERE id = ?',
      [newVisits, customer.id]
    );

    await db.execute(
      'DELETE FROM visit_logs WHERE customer_id = ? ORDER BY visited_at DESC LIMIT 1',
      [customer.id]
    );

    const [[updated]] = await db.execute('SELECT * FROM loyalty_customers WHERE id = ?', [customer.id]);
    await triggerAppleUpdate(db, updated);
    updateGooglePass(updated).catch(() => {});

    res.json({ success: true, visits: newVisits });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  الإشعارات
// ═══════════════════════════════════════════════════════════════════════════════

async function sendNotifyToCustomer(db, customer, message) {
  // حدّث notification_msg
  await db.execute(
    'UPDATE loyalty_customers SET notification_msg = ?, pass_updated_at = NOW() WHERE id = ?',
    [message, customer.id]
  );

  const [[updated]] = await db.execute('SELECT * FROM loyalty_customers WHERE id = ?', [customer.id]);
  await triggerAppleUpdate(db, updated);

  // بعد الإرسال: حدّث last_notification_sent
  await db.execute(
    'UPDATE loyalty_customers SET last_notification_sent = ? WHERE id = ?',
    [message, customer.id]
  );

  return updated;
}

// إشعار لعميل واحد
app.post('/notify/:serial', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'الرسالة مطلوبة' });

    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE customer_number = ?', [req.params.serial]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });

    await sendNotifyToCustomer(db, customer, message);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// إشعار لمجموعة
app.post('/notify-batch', async (req, res) => {
  try {
    const { message, serials } = req.body;
    if (!message || !Array.isArray(serials)) return res.status(400).json({ error: 'message وserials مطلوبان' });

    const db = await getDB();
    let sentCount = 0;

    for (const serial of serials) {
      const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE customer_number = ?', [serial]);
      if (customer) {
        await sendNotifyToCustomer(db, customer, message);
        sentCount++;
      }
    }

    await db.execute(
      'INSERT INTO notification_logs (title, message, recipients, sent_count) VALUES (?, ?, ?, ?)',
      ['إشعار مجموعة', message, JSON.stringify(serials), sentCount]
    );

    res.json({ success: true, sentCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// إشعار لكل العملاء
app.post('/notify-all', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'الرسالة مطلوبة' });

    const db = await getDB();
    const [customers] = await db.execute('SELECT * FROM loyalty_customers WHERE revoked = 0');
    let sentCount = 0;

    for (const customer of customers) {
      await sendNotifyToCustomer(db, customer, message);
      sentCount++;
    }

    await db.execute(
      'INSERT INTO notification_logs (title, message, recipients, sent_count, registered_count) VALUES (?, ?, ?, ?, ?)',
      ['إشعار للكل', message, 'all', sentCount, customers.length]
    );

    res.json({ success: true, sentCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// سجل الإشعارات
app.get('/notification-logs', async (req, res) => {
  try {
    const db = await getDB();
    const [rows] = await db.execute('SELECT * FROM notification_logs ORDER BY created_at DESC LIMIT 200');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push بدون رسالة (تحديث تصميم)
app.post('/push-all', async (req, res) => {
  try {
    const db = await getDB();
    const [customers] = await db.execute('SELECT * FROM loyalty_customers WHERE revoked = 0');
    let count = 0;
    for (const c of customers) {
      await db.execute('UPDATE loyalty_customers SET pass_updated_at = NOW() WHERE id = ?', [c.id]);
      const [[updated]] = await db.execute('SELECT * FROM loyalty_customers WHERE id = ?', [c.id]);
      const [devices] = await db.execute(
        `SELECT wd.push_token FROM wallet_registrations wr
         JOIN wallet_devices wd ON wd.device_id = wr.device_id
         WHERE wr.pass_serial = ?`,
        [String(c.customer_number)]
      );
      for (const d of devices) {
        if (d.push_token) { await sendPush(d.push_token); count++; }
      }
    }
    res.json({ success: true, pushed: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push لعميل واحد
app.post('/push-customer/:serial', async (req, res) => {
  try {
    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE customer_number = ?', [req.params.serial]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });

    await db.execute('UPDATE loyalty_customers SET pass_updated_at = NOW() WHERE id = ?', [customer.id]);
    const [devices] = await db.execute(
      `SELECT wd.push_token FROM wallet_registrations wr
       JOIN wallet_devices wd ON wd.device_id = wr.device_id
       WHERE wr.pass_serial = ?`,
      [String(customer.customer_number)]
    );
    let count = 0;
    for (const d of devices) {
      if (d.push_token) { await sendPush(d.push_token); count++; }
    }
    res.json({ success: true, pushed: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  إدارة البطاقة
// ═══════════════════════════════════════════════════════════════════════════════

// تعليق البطاقة
app.post('/revoke/:serial', async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'سبب التعليق مطلوب' });

    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE customer_number = ?', [req.params.serial]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });

    await db.execute(
      'UPDATE loyalty_customers SET revoked = 1, revoke_reason = ?, pass_updated_at = NOW() WHERE id = ?',
      [reason, customer.id]
    );

    const [[updated]] = await db.execute('SELECT * FROM loyalty_customers WHERE id = ?', [customer.id]);
    await triggerAppleUpdate(db, updated);
    updateGooglePass(updated).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// فك التعليق
app.post('/unrevoke/:serial', async (req, res) => {
  try {
    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE customer_number = ?', [req.params.serial]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });

    await db.execute(
      'UPDATE loyalty_customers SET revoked = 0, revoke_reason = NULL, pass_updated_at = NOW() WHERE id = ?',
      [customer.id]
    );

    const [[updated]] = await db.execute('SELECT * FROM loyalty_customers WHERE id = ?', [customer.id]);
    await triggerAppleUpdate(db, updated);
    updateGooglePass(updated).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// تعديل اسم العميل
app.post('/update-name/:serial', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'الاسم مطلوب' });

    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE customer_number = ?', [req.params.serial]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });

    await db.execute(
      'UPDATE loyalty_customers SET name = ?, pass_updated_at = NOW() WHERE id = ?',
      [name, customer.id]
    );

    const [[updated]] = await db.execute('SELECT * FROM loyalty_customers WHERE id = ?', [customer.id]);
    await triggerAppleUpdate(db, updated);
    updateGooglePass(updated).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Google Wallet
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/google-pass/:phone', async (req, res) => {
  try {
    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE phone = ?', [req.params.phone]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });

    await updateGooglePass(customer);

    const objectId = `${CONFIG.classId}.customer_${customer.customer_number}`;
    const payload = {
      iss: googleCredentials.client_email,
      aud: 'google',
      typ: 'savetowallet',
      iat: Math.floor(Date.now() / 1000),
      payload: {
        loyaltyObjects: [{ id: objectId }],
      },
    };

    const token = jwt.sign(payload, googleCredentials.private_key, { algorithm: 'RS256' });
    res.redirect(`https://pay.google.com/gp/v/save/${token}`);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  الملفات الثابتة
// ═══════════════════════════════════════════════════════════════════════════════

// تحميل بطاقة Apple (للعميل مباشرة)
app.get('/pass/:phone', async (req, res) => {
  try {
    const db = await getDB();
    const [[customer]] = await db.execute('SELECT * FROM loyalty_customers WHERE phone = ?', [req.params.phone]);
    if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });

    const buf = customer.revoked ? await makeRevokedPass(customer) : await makePass(customer);
    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// صور الكوبات
app.get('/images/:file', (req, res) => {
  const filePath = path.join(CUPS_DIR, req.params.file);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);
  res.sendFile(filePath);
});

// صورة البانر الرئيسية
app.get('/banner.png', (req, res) => {
  const filePath = path.join(PASS_MODEL, 'strip.png');
  if (!fs.existsSync(filePath)) return res.sendStatus(404);
  res.sendFile(filePath);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Auth الأدمن
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/auth', (req, res) => {
  const { password } = req.body;
  if (password === CONFIG.adminPassword) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  إعدادات البطاقة
// ═══════════════════════════════════════════════════════════════════════════════

// قراءة الإعدادات الحالية
app.get('/admin/settings', (req, res) => {
  res.json(loadPassSettings());
});

// حفظ الإعدادات النصية والألوان
app.post('/admin/settings', (req, res) => {
  try {
    const current = loadPassSettings();
    const allowed = ['backgroundColor','foregroundColor','labelColor','logoText','organizationName','description','rewardText','stripMode'];
    const updated = { ...current };
    allowed.forEach(k => { if (req.body[k] !== undefined) updated[k] = req.body[k]; });
    savePassSettings(updated);
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// رفع صورة strip عامة
app.post('/admin/upload-strip', upload.fields([
  { name: 'strip', maxCount: 1 },
  { name: 'strip2x', maxCount: 1 },
]), (req, res) => {
  try {
    if (req.files['strip'])   fs.writeFileSync(path.join(PASS_MODEL, 'strip.png'),    req.files['strip'][0].buffer);
    if (req.files['strip2x']) fs.writeFileSync(path.join(PASS_MODEL, 'strip@2x.png'), req.files['strip2x'][0].buffer);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// رفع صورة لزيارة محددة (0-5)
app.post('/admin/upload-strip/:n', upload.fields([
  { name: 'strip', maxCount: 1 },
  { name: 'strip2x', maxCount: 1 },
]), (req, res) => {
  try {
    const n = parseInt(req.params.n);
    if (isNaN(n) || n < 0 || n > 5) return res.status(400).json({ error: 'رقم الزيارة يجب أن يكون بين 0 و 5' });
    if (req.files['strip'])   fs.writeFileSync(path.join(CUPS_DIR, `${n}.png`),    req.files['strip'][0].buffer);
    if (req.files['strip2x']) fs.writeFileSync(path.join(CUPS_DIR, `${n}@2x.png`), req.files['strip2x'][0].buffer);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  تشغيل السيرفر
// ═══════════════════════════════════════════════════════════════════════════════

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`د. روز للورد — Loyalty Server running on port ${PORT}`);
});
