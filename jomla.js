// ─── متجر الجملة (JomlaStore) — نسخة مبنية على متجر التجزئة، منتجات وسلة منفصلة ──
// ملاحظة: لا يوجد حالياً منطق حسابات تجار/موافقة إدارية — هذا يُضاف لاحقاً فوق هذي النسخة.
const crypto = require('crypto');
const multer = require('multer');
const { scrapeProductUrl, scrapeCollectionUrl, downloadImageAsBuffer } = require('./store-scraper');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('الملف يجب أن يكون صورة'));
  },
});

const CHEVRON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(name) {
  const base = String(name || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^ء-ي٠-٩a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'product';
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

module.exports = function registerJomlaStore(app, getDB, CONFIG) {

  // ─── جداول متجر الجملة ───────────────────────────────────────────────────
  async function ensureJomlaTables() {
    const db = await getDB();
    await db.execute(`
      CREATE TABLE IF NOT EXISTS jomla_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL UNIQUE,
        description TEXT,
        sort_order INT DEFAULT 0,
        active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS jomla_products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category_id INT NULL,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL UNIQUE,
        description TEXT,
        price DECIMAL(10,2) NOT NULL DEFAULT 0,
        compare_at_price DECIMAL(10,2) NULL,
        currency VARCHAR(10) DEFAULT 'SAR',
        status ENUM('draft','published') DEFAULT 'draft',
        source_url VARCHAR(1000) NULL,
        meta_title VARCHAR(255) NULL,
        meta_description VARCHAR(500) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_status (status),
        INDEX idx_category (category_id),
        FOREIGN KEY (category_id) REFERENCES jomla_categories(id) ON DELETE SET NULL
      )
    `);
    // شارة الحالة تحت اسم المنتج — مثل "زهور متفتحة" أو "باقي 3 فقط" أو "ينفد بسرعة" (نص حر يديره الأدمن)
    await db.execute(`ALTER TABLE jomla_products ADD COLUMN IF NOT EXISTS stock_note VARCHAR(60) NULL`).catch(() => {});
    await db.execute(`
      CREATE TABLE IF NOT EXISTS jomla_product_images (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        image_data LONGBLOB NOT NULL,
        mime_type VARCHAR(50) DEFAULT 'image/jpeg',
        sort_order INT DEFAULT 0,
        is_primary TINYINT(1) DEFAULT 0,
        source_url VARCHAR(1000) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_product (product_id),
        FOREIGN KEY (product_id) REFERENCES jomla_products(id) ON DELETE CASCADE
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS jomla_carts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        cart_token VARCHAR(64) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS jomla_cart_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        cart_id INT NOT NULL,
        product_id INT NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_cart_product (cart_id, product_id),
        FOREIGN KEY (cart_id) REFERENCES jomla_carts(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES jomla_products(id) ON DELETE CASCADE
      )
    `);
  }
  let tablesReadyPromise = null;
  function ensureTablesOnce() {
    if (!tablesReadyPromise) tablesReadyPromise = ensureJomlaTables();
    return tablesReadyPromise;
  }
  app.use(async (req, res, next) => {
    try { await ensureTablesOnce(); next(); } catch (err) { next(err); }
  });

  async function uniqueSlug(db, name, table, ignoreId) {
    let base = slugify(name);
    let slug = base;
    let n = 2;
    for (;;) {
      const params = ignoreId ? [slug, ignoreId] : [slug];
      const sql = ignoreId
        ? `SELECT id FROM ${table} WHERE slug = ? AND id != ?`
        : `SELECT id FROM ${table} WHERE slug = ?`;
      const [[row]] = await db.execute(sql, params);
      if (!row) return slug;
      slug = `${base}-${n++}`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  عام — تصفح المتجر
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/jomla/api/categories', async (req, res) => {
    try {
      const db = await getDB();
      const [rows] = await db.execute(
        `SELECT c.id, c.name, c.slug, c.description,
                (SELECT pi.id FROM jomla_product_images pi
                 JOIN jomla_products p ON p.id = pi.product_id
                 WHERE p.category_id = c.id AND p.status = 'published'
                 ORDER BY pi.is_primary DESC, pi.sort_order LIMIT 1) AS image_id
         FROM jomla_categories c
         WHERE c.active = 1
         ORDER BY c.sort_order, c.name`
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/jomla/api/products', async (req, res) => {
    try {
      const db = await getDB();
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const perPage = 24;
      const offset = (page - 1) * perPage;

      let where = `p.status = 'published'`;
      const params = [];
      if (req.query.category) {
        where += ` AND c.slug = ?`;
        params.push(req.query.category);
      }

      const [rows] = await db.execute(
        `SELECT p.id, p.name, p.slug, p.price, p.compare_at_price, p.currency, p.stock_note,
                (SELECT id FROM jomla_product_images WHERE product_id = p.id ORDER BY is_primary DESC, sort_order LIMIT 1) AS image_id
         FROM jomla_products p
         LEFT JOIN jomla_categories c ON c.id = p.category_id
         WHERE ${where}
         ORDER BY p.created_at DESC
         LIMIT ${perPage} OFFSET ${offset}`,
        params
      );
      res.json({ products: rows, page, perPage });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/jomla/api/products/:slug', async (req, res) => {
    try {
      const db = await getDB();
      const [[product]] = await db.execute(
        `SELECT * FROM jomla_products WHERE slug = ? AND status = 'published'`,
        [req.params.slug]
      );
      if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
      const [images] = await db.execute(
        `SELECT id, is_primary FROM jomla_product_images WHERE product_id = ? ORDER BY sort_order`,
        [product.id]
      );
      res.json({ ...product, images });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/jomla/product-image/:id', async (req, res) => {
    try {
      const db = await getDB();
      const [[row]] = await db.execute(
        `SELECT image_data, mime_type FROM jomla_product_images WHERE id = ?`,
        [req.params.id]
      );
      if (!row) return res.sendStatus(404);
      res.set('Content-Type', row.mime_type || 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(row.image_data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ─── صفحة تفاصيل المنتج (SSR للفهرسة) ───────────────────────────────────
  app.get('/jomla/product/:slug', async (req, res) => {
    try {
      const db = await getDB();
      const [[product]] = await db.execute(
        `SELECT p.*, c.name AS category_name, c.slug AS category_slug
         FROM jomla_products p
         LEFT JOIN jomla_categories c ON c.id = p.category_id
         WHERE p.slug = ? AND p.status = 'published'`,
        [req.params.slug]
      );
      if (!product) {
        res.status(404).set('Content-Type', 'text/html; charset=utf-8');
        return res.send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>المنتج غير موجود — متجر الجملة</title></head><body><h1>المنتج غير موجود</h1><a href="/jomla">عودة لمتجر الجملة</a></body></html>`);
      }
      const [images] = await db.execute(
        `SELECT id, is_primary FROM jomla_product_images WHERE product_id = ? ORDER BY sort_order`,
        [product.id]
      );

      const title = escapeHtml(product.meta_title || product.name);
      const description = escapeHtml(product.meta_description || product.description || '');
      const primary = images.find(i => i.is_primary) || images[0];
      const base = CONFIG.serverURL.replace(/\/$/, '');
      const primaryImgUrl = primary ? `${base}/jomla/product-image/${primary.id}` : '';
      const canonical = `${base}/jomla/product/${product.slug}`;

      const mainImgId = primary ? primary.id : null;
      const galleryMainHtml = mainImgId
        ? `<img id="gallery-main-img" src="${base}/jomla/product-image/${mainImgId}" alt="${title}">`
        : '';
      const galleryThumbsHtml = images.length > 1 ? images.map((img, idx) => `
        <img src="${base}/jomla/product-image/${img.id}" alt="${title}" loading="lazy"
             class="${img.id === mainImgId ? 'active' : ''}" onclick="document.getElementById('gallery-main-img').src=this.src;document.querySelectorAll('.gallery-thumbs img').forEach(i=>i.classList.remove('active'));this.classList.add('active')">
      `).join('') : '';

      const breadcrumbHtml = product.category_slug
        ? `<a href="/jomla">الرئيسية</a><span class="sep">${CHEVRON_SVG}</span><a href="/jomla#${encodeURIComponent(product.category_slug)}">${escapeHtml(product.category_name)}</a><span class="sep">${CHEVRON_SVG}</span><span class="current">${title}</span>`
        : `<a href="/jomla">الرئيسية</a><span class="sep">${CHEVRON_SVG}</span><span class="current">${title}</span>`;

      const jsonLd = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: product.name,
        description: product.description || '',
        image: images.map(i => `${base}/jomla/product-image/${i.id}`),
        offers: {
          '@type': 'Offer',
          price: product.price,
          priceCurrency: product.currency || 'SAR',
          availability: 'https://schema.org/InStock',
        },
      });

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — متجر الجملة</title>
<meta name="description" content="${description}">
<meta property="og:type" content="product">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${primaryImgUrl}">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/images/drrose-logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/jomla/jomla.css?v=3">
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
<header class="store-header">
  <a href="/jomla" class="store-logo"><img src="/images/drrose-logo.png" alt="دورو"></a>
  <a href="/jomla/cart.html" class="cart-link">السلة <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg></a>
</header>
<nav class="breadcrumb">${breadcrumbHtml}</nav>
<main class="product-detail">
  <div class="gallery">
    <div class="gallery-main">${galleryMainHtml || '<div class="no-image">لا توجد صورة</div>'}</div>
    ${galleryThumbsHtml ? `<div class="gallery-thumbs">${galleryThumbsHtml}</div>` : ''}
  </div>
  <div class="info">
    <h1>${title}</h1>
    <div class="price-row">
      <span class="price ${product.compare_at_price && Number(product.compare_at_price) > Number(product.price) ? 'on-sale' : ''}">${product.price} ${escapeHtml(product.currency || 'SAR')}</span>
      ${product.compare_at_price && Number(product.compare_at_price) > Number(product.price) ? `<span class="price-compare">${product.compare_at_price} ${escapeHtml(product.currency || 'SAR')}</span>` : ''}
    </div>
    ${product.stock_note ? `<span class="stock-note">${escapeHtml(product.stock_note)}</span>` : ''}
    <p class="description">${description}</p>
    <button class="btn-add-cart" data-product-id="${product.id}">أضف إلى السلة</button>
  </div>
</main>
<script src="/jomla/jomla.js"></script>
</body>
</html>`);
    } catch (err) {
      res.status(500).send('خطأ في الخادم');
    }
  });

  app.get('/jomla/sitemap.xml', async (req, res) => {
    try {
      const db = await getDB();
      const [products] = await db.execute(`SELECT slug, updated_at FROM jomla_products WHERE status = 'published'`);
      const base = CONFIG.serverURL.replace(/\/$/, '');
      const urls = [
        `<url><loc>${base}/jomla</loc></url>`,
        ...products.map(p => `<url><loc>${base}/jomla/product/${p.slug}</loc><lastmod>${new Date(p.updated_at).toISOString()}</lastmod></url>`),
      ].join('\n');
      res.set('Content-Type', 'application/xml');
      res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
    } catch (err) { res.status(500).send(''); }
  });

  // ─── السلة ───────────────────────────────────────────────────────────────
  async function getOrCreateCart(req, res) {
    const db = await getDB();
    const cookies = parseCookies(req);
    let token = cookies.jomla_cart_token;

    if (token) {
      const [[row]] = await db.execute(`SELECT id FROM jomla_carts WHERE cart_token = ?`, [token]);
      if (row) return row.id;
    }

    token = crypto.randomBytes(24).toString('hex');
    const [result] = await db.execute(`INSERT INTO jomla_carts (cart_token) VALUES (?)`, [token]);
    res.cookie ? res.cookie('jomla_cart_token', token, { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 90, sameSite: 'lax' })
               : res.set('Set-Cookie', `jomla_cart_token=${token}; HttpOnly; Max-Age=${60 * 60 * 24 * 90}; Path=/; SameSite=Lax`);
    return result.insertId;
  }

  async function getCartIdReadOnly(req) {
    const cookies = parseCookies(req);
    const token = cookies.jomla_cart_token;
    if (!token) return null;
    const db = await getDB();
    const [[row]] = await db.execute(`SELECT id FROM jomla_carts WHERE cart_token = ?`, [token]);
    return row ? row.id : null;
  }

  app.get('/jomla/api/cart', async (req, res) => {
    try {
      const cartId = await getCartIdReadOnly(req);
      if (!cartId) return res.json({ items: [], total: 0 });
      const db = await getDB();
      const [items] = await db.execute(
        `SELECT ci.product_id, ci.quantity, p.name, p.price, p.slug,
                (SELECT id FROM jomla_product_images WHERE product_id = p.id ORDER BY is_primary DESC, sort_order LIMIT 1) AS image_id
         FROM jomla_cart_items ci
         JOIN jomla_products p ON p.id = ci.product_id
         WHERE ci.cart_id = ?`,
        [cartId]
      );
      const total = items.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);
      res.json({ items, total });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/jomla/api/cart/add', async (req, res) => {
    try {
      const { productId, quantity } = req.body;
      const qty = Math.max(1, parseInt(quantity) || 1);
      if (!productId) return res.status(400).json({ error: 'productId مطلوب' });
      const cartId = await getOrCreateCart(req, res);
      const db = await getDB();
      await db.execute(
        `INSERT INTO jomla_cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
        [cartId, productId, qty]
      );
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/jomla/api/cart/update', async (req, res) => {
    try {
      const { productId, quantity } = req.body;
      const cartId = await getCartIdReadOnly(req);
      if (!cartId) return res.status(400).json({ error: 'لا توجد سلة' });
      const db = await getDB();
      const qty = parseInt(quantity);
      if (!qty || qty <= 0) {
        await db.execute(`DELETE FROM jomla_cart_items WHERE cart_id = ? AND product_id = ?`, [cartId, productId]);
      } else {
        await db.execute(`UPDATE jomla_cart_items SET quantity = ? WHERE cart_id = ? AND product_id = ?`, [qty, cartId, productId]);
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/jomla/api/cart/remove', async (req, res) => {
    try {
      const { productId } = req.body;
      const cartId = await getCartIdReadOnly(req);
      if (!cartId) return res.json({ success: true });
      const db = await getDB();
      await db.execute(`DELETE FROM jomla_cart_items WHERE cart_id = ? AND product_id = ?`, [cartId, productId]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  إدارة — منتجات وتصنيفات
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/admin/jomla/products', async (req, res) => {
    try {
      const db = await getDB();
      const [rows] = await db.execute(
        `SELECT p.*, c.name AS category_name,
                (SELECT id FROM jomla_product_images WHERE product_id = p.id ORDER BY is_primary DESC, sort_order LIMIT 1) AS image_id
         FROM jomla_products p
         LEFT JOIN jomla_categories c ON c.id = p.category_id
         ORDER BY p.created_at DESC`
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/admin/jomla/products/:id', async (req, res) => {
    try {
      const db = await getDB();
      const [[product]] = await db.execute(`SELECT * FROM jomla_products WHERE id = ?`, [req.params.id]);
      if (!product) return res.status(404).json({ error: 'المنتج غير موجود' });
      const [images] = await db.execute(
        `SELECT id, is_primary, sort_order FROM jomla_product_images WHERE product_id = ? ORDER BY sort_order`,
        [product.id]
      );
      res.json({ ...product, images });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/admin/jomla/products', async (req, res) => {
    try {
      const { name, description, price, compareAtPrice, categoryId, currency, stockNote } = req.body;
      if (!name) return res.status(400).json({ error: 'اسم المنتج مطلوب' });
      const db = await getDB();
      const slug = await uniqueSlug(db, name, 'jomla_products');
      const [result] = await db.execute(
        `INSERT INTO jomla_products (category_id, name, slug, description, price, compare_at_price, currency, stock_note, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
        [categoryId || null, name, slug, description || null, price || 0, compareAtPrice || null, currency || 'SAR', stockNote || null]
      );
      res.json({ success: true, id: result.insertId, slug });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/admin/jomla/products/:id', async (req, res) => {
    try {
      const db = await getDB();
      const fieldMap = {
        name: 'name', description: 'description', price: 'price',
        compareAtPrice: 'compare_at_price', categoryId: 'category_id', currency: 'currency',
        metaTitle: 'meta_title', metaDescription: 'meta_description', stockNote: 'stock_note',
      };
      const sets = [];
      const params = [];
      for (const [bodyKey, col] of Object.entries(fieldMap)) {
        if (req.body[bodyKey] !== undefined) { sets.push(`${col} = ?`); params.push(req.body[bodyKey] || null); }
      }
      if (!sets.length) return res.status(400).json({ error: 'لا يوجد حقول للتحديث' });
      params.push(req.params.id);
      await db.execute(`UPDATE jomla_products SET ${sets.join(', ')} WHERE id = ?`, params);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/admin/jomla/products/:id', async (req, res) => {
    try {
      const db = await getDB();
      await db.execute(`DELETE FROM jomla_products WHERE id = ?`, [req.params.id]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/admin/jomla/products/:id/publish', async (req, res) => {
    try {
      const db = await getDB();
      const status = req.body.status === 'draft' ? 'draft' : 'published';
      await db.execute(`UPDATE jomla_products SET status = ? WHERE id = ?`, [status, req.params.id]);
      res.json({ success: true, status });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/admin/jomla/products/:id/images', upload.array('images', 12), async (req, res) => {
    try {
      if (!req.files || !req.files.length) return res.status(400).json({ error: 'الصور مطلوبة' });
      const db = await getDB();
      const [[{ cnt }]] = await db.execute(`SELECT COUNT(*) AS cnt FROM jomla_product_images WHERE product_id = ?`, [req.params.id]);
      let order = cnt;
      for (const file of req.files) {
        await db.execute(
          `INSERT INTO jomla_product_images (product_id, image_data, mime_type, sort_order, is_primary)
           VALUES (?, ?, ?, ?, ?)`,
          [req.params.id, file.buffer, file.mimetype, order, cnt === 0 && order === cnt ? 1 : 0]
        );
        order++;
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/admin/jomla/products/:id/images/:imageId', async (req, res) => {
    try {
      const db = await getDB();
      await db.execute(`DELETE FROM jomla_product_images WHERE id = ? AND product_id = ?`, [req.params.imageId, req.params.id]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/admin/jomla/products/:id/images/:imageId/primary', async (req, res) => {
    try {
      const db = await getDB();
      await db.execute(`UPDATE jomla_product_images SET is_primary = 0 WHERE product_id = ?`, [req.params.id]);
      await db.execute(`UPDATE jomla_product_images SET is_primary = 1 WHERE id = ? AND product_id = ?`, [req.params.imageId, req.params.id]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/admin/jomla/categories', async (req, res) => {
    try {
      const db = await getDB();
      const [rows] = await db.execute(`SELECT * FROM jomla_categories ORDER BY sort_order, name`);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/admin/jomla/categories', async (req, res) => {
    try {
      const { name, description, sortOrder } = req.body;
      if (!name) return res.status(400).json({ error: 'اسم التصنيف مطلوب' });
      const db = await getDB();
      const slug = await uniqueSlug(db, name, 'jomla_categories');
      const [result] = await db.execute(
        `INSERT INTO jomla_categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)`,
        [name, slug, description || null, sortOrder || 0]
      );
      res.json({ success: true, id: result.insertId, slug });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/admin/jomla/categories/:id', async (req, res) => {
    try {
      const { name, description, sortOrder, active } = req.body;
      const db = await getDB();
      const sets = [];
      const params = [];
      if (name !== undefined) { sets.push('name = ?'); params.push(name); }
      if (description !== undefined) { sets.push('description = ?'); params.push(description); }
      if (sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(sortOrder); }
      if (active !== undefined) { sets.push('active = ?'); params.push(active ? 1 : 0); }
      if (!sets.length) return res.status(400).json({ error: 'لا يوجد حقول للتحديث' });
      params.push(req.params.id);
      await db.execute(`UPDATE jomla_categories SET ${sets.join(', ')} WHERE id = ?`, params);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/admin/jomla/categories/:id', async (req, res) => {
    try {
      const db = await getDB();
      await db.execute(`DELETE FROM jomla_categories WHERE id = ?`, [req.params.id]);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/admin/jomla/orders', async (req, res) => {
    try {
      const db = await getDB();
      const [carts] = await db.execute(
        `SELECT c.id, c.cart_token, c.created_at, c.updated_at,
                SUM(ci.quantity) AS item_count, SUM(ci.quantity * p.price) AS total
         FROM jomla_carts c
         JOIN jomla_cart_items ci ON ci.cart_id = c.id
         JOIN jomla_products p ON p.id = ci.product_id
         GROUP BY c.id
         ORDER BY c.updated_at DESC`
      );
      res.json(carts);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/admin/jomla/orders/:cartId', async (req, res) => {
    try {
      const db = await getDB();
      const [items] = await db.execute(
        `SELECT ci.product_id, ci.quantity, p.name, p.price
         FROM jomla_cart_items ci JOIN jomla_products p ON p.id = ci.product_id
         WHERE ci.cart_id = ?`,
        [req.params.cartId]
      );
      res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  سكرابر — سحب منتج من رابط خارجي
  // ═══════════════════════════════════════════════════════════════════════

  app.post('/admin/jomla/scrape', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: 'الرابط مطلوب' });
      const data = await scrapeProductUrl(url);
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message || 'فشل سحب البيانات' }); }
  });

  // يحفظ منتج مسحوب واحد كمسودة + يحمّل صوره — تُستخدم من مسار المنتج الواحد ومسار السحب الجماعي
  async function saveScrapedProduct(db, { title, description, price, compareAtPrice, currency, categoryId, images, sourceUrl }) {
    const slug = await uniqueSlug(db, title, 'jomla_products');
    const [result] = await db.execute(
      `INSERT INTO jomla_products (category_id, name, slug, description, price, compare_at_price, currency, status, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
      [categoryId || null, title, slug, description || null, price || 0, compareAtPrice || null, currency || 'SAR', sourceUrl || null]
    );
    const productId = result.insertId;

    const imageUrls = Array.isArray(images) ? images.slice(0, 12) : [];
    let order = 0;
    for (const imgUrl of imageUrls) {
      try {
        const { buffer, mimeType } = await downloadImageAsBuffer(imgUrl);
        await db.execute(
          `INSERT INTO jomla_product_images (product_id, image_data, mime_type, sort_order, is_primary, source_url)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [productId, buffer, mimeType, order, order === 0 ? 1 : 0, imgUrl]
        );
        order++;
      } catch (imgErr) {
        // نتجاهل صورة فشل تحميلها ونكمل الباقي — لا نوقف الحفظ كامل بسببها
        continue;
      }
    }
    return { id: productId, slug, imagesSaved: order };
  }

  app.post('/admin/jomla/scrape/confirm', async (req, res) => {
    try {
      const { title, description, price, currency, categoryId, images, sourceUrl } = req.body;
      if (!title) return res.status(400).json({ error: 'العنوان مطلوب' });
      const db = await getDB();
      const saved = await saveScrapedProduct(db, { title, description, price, currency, categoryId, images, sourceUrl });
      res.json({ success: true, ...saved });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ─── سحب جماعي من صفحة مجموعة/تصنيف (Shopify) ───────────────────────────
  app.post('/admin/jomla/scrape-collection', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: 'الرابط مطلوب' });
      const data = await scrapeCollectionUrl(url);
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message || 'فشل سحب المجموعة' }); }
  });

  // يحفظ مجموعة منتجات محددة (بعد المراجعة) كمسودات — كل منتج مستقل، فشل واحد ما يوقف الباقي
  app.post('/admin/jomla/scrape-collection/confirm', async (req, res) => {
    try {
      const { products, categoryId } = req.body;
      if (!Array.isArray(products) || !products.length) {
        return res.status(400).json({ error: 'لا يوجد منتجات محددة للحفظ' });
      }
      const db = await getDB();
      const saved = [];
      const failed = [];
      for (const p of products.slice(0, 100)) {
        if (!p.title) { failed.push({ title: p.title || '(بدون اسم)', error: 'العنوان مطلوب' }); continue; }
        try {
          const result = await saveScrapedProduct(db, { ...p, categoryId: categoryId || null });
          saved.push({ title: p.title, ...result });
        } catch (err) {
          failed.push({ title: p.title, error: err.message });
        }
      }
      res.json({ success: true, savedCount: saved.length, failedCount: failed.length, saved, failed });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};
