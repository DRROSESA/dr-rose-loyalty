// ─── سكرابر المنتجات ───────────────────────────────────────────────────────
// يسحب اسم/وصف/سعر/صور منتج من أي رابط، بترتيب أولوية:
// 1) JSON-LD (schema.org Product) — الأكثر موثوقية
// 2) أنماط منصات معروفة (Salla / Zid / WooCommerce)
// 3) fallback عام (OpenGraph + regex للسعر)

const cheerio = require('cheerio');
const fetch = require('node-fetch');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15000;

function toAbsoluteUrl(src, baseUrl) {
  if (!src) return null;
  try { return new URL(src, baseUrl).toString(); } catch { return null; }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── 1) JSON-LD Product ────────────────────────────────────────────────────
function extractFromJsonLd($, baseUrl) {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const el of scripts) {
    let data;
    try { data = JSON.parse($(el).contents().text()); } catch { continue; }

    const candidates = [];
    const flatten = (node) => {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(flatten); return; }
      if (node['@graph']) flatten(node['@graph']);
      candidates.push(node);
    };
    flatten(data);

    const product = candidates.find(n => {
      const type = n['@type'];
      return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
    });
    if (!product) continue;

    let offers = product.offers;
    if (Array.isArray(offers)) offers = offers[0];
    const price = offers && (offers.price || offers.lowPrice);
    const currency = offers && (offers.priceCurrency || 'SAR');

    let images = product.image;
    if (!images) images = [];
    else if (typeof images === 'string') images = [images];
    else if (!Array.isArray(images)) images = [images.url].filter(Boolean);
    images = images.map(i => (typeof i === 'string' ? i : i && i.url)).filter(Boolean)
      .map(u => toAbsoluteUrl(u, baseUrl)).filter(Boolean);

    if (!product.name && !price && images.length === 0) continue;

    return {
      title: product.name || null,
      description: product.description || null,
      price: price != null ? String(price) : null,
      currency: currency || null,
      images,
    };
  }
  return null;
}

// ─── 2) أنماط منصات معروفة ──────────────────────────────────────────────────
function detectPlatform($, html) {
  if (/cdn\.salla\.(sa|network)|salla-storage|window\.salla/i.test(html)) return 'salla';
  if (/cdn\.zid\.store|window\.zid|zid-theme/i.test(html)) return 'zid';
  if (/woocommerce/i.test(html) || $('body').hasClass('woocommerce')) return 'woocommerce';
  if (/cdn\.shopify\.com|Shopify\.theme|window\.Shopify/i.test(html)) return 'shopify';
  return null;
}

function extractByPlatform($, platform, baseUrl) {
  const pick = (selectors) => {
    for (const sel of selectors) {
      const el = $(sel).first();
      if (el && el.text().trim()) return el.text().trim();
    }
    return null;
  };
  const pickImages = (selectors) => {
    const urls = [];
    for (const sel of selectors) {
      $(sel).each((_, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original');
        const abs = toAbsoluteUrl(src, baseUrl);
        if (abs && !urls.includes(abs)) urls.push(abs);
      });
      if (urls.length) break;
    }
    return urls;
  };

  if (platform === 'salla') {
    return {
      title: pick(['h1.product-title', 'h1[itemprop="name"]', 'h1']),
      description: pick(['.product-description', '[itemprop="description"]']),
      price: pick(['.product-formatted-price', '[itemprop="price"]', '.amount']),
      currency: null,
      images: pickImages(['.product-gallery img', '.s-product-gallery-thumb img', 'img[itemprop="image"]']),
    };
  }
  if (platform === 'zid') {
    return {
      title: pick(['h1.product-title', 'h1']),
      description: pick(['.product-description', '.product-details__description']),
      price: pick(['.product-price', '[itemprop="price"]']),
      currency: null,
      images: pickImages(['.product-gallery img', '.product-images img']),
    };
  }
  if (platform === 'woocommerce') {
    return {
      title: pick(['.product_title', 'h1.product_title']),
      description: pick(['.woocommerce-product-details__short-description', '#tab-description']),
      price: pick(['.price .amount', 'p.price']),
      currency: null,
      images: pickImages(['.woocommerce-product-gallery img', '.woocommerce-product-gallery__image img']),
    };
  }
  if (platform === 'shopify') {
    return {
      title: pick(['h1.product-title', 'h1.product__title', 'h1']),
      description: pick(['.product__description', '.product-single__description']),
      price: pick(['.price-item--regular', '.product__price', '[class*="price"]']),
      currency: null,
      images: pickImages(['.product__media img', '.product-single__photo img', 'img[class*="product"]']),
    };
  }
  return null;
}

// ─── 3) fallback عام ────────────────────────────────────────────────────────
function extractGeneric($, baseUrl) {
  const meta = (name) => $(`meta[property="${name}"]`).attr('content') || $(`meta[name="${name}"]`).attr('content') || null;

  const title = meta('og:title') || $('title').first().text().trim() || null;
  const description = meta('og:description') || meta('description') || null;

  let images = $('meta[property="og:image"]').map((_, el) => $(el).attr('content')).get();
  if (!images.length) {
    const candidate = $('img[class*="product"], .product img, [class*="gallery"] img').first();
    const src = candidate.attr('src') || candidate.attr('data-src');
    if (src) images = [src];
  }
  images = images.map(u => toAbsoluteUrl(u, baseUrl)).filter(Boolean);

  // regex للسعر: يدور على عناصر فيها كلمة price بالكلاس/الـ id، أو نص قريب من "ر.س"/SAR
  let price = null;
  const priceEl = $('[class*="price" i], [id*="price" i]').filter((_, el) => {
    const t = $(el).text().trim();
    return /\d/.test(t) && t.length < 40;
  }).first();
  if (priceEl.length) {
    const m = priceEl.text().match(/[\d.,]+/);
    if (m) price = m[0];
  }
  if (!price) {
    const bodyText = $('body').text();
    const m = bodyText.match(/(\d+(?:[.,]\d+)?)\s*(?:ر\.?\s?س|ريال|SAR|SR)/i);
    if (m) price = m[1];
  }

  return { title, description, price, currency: null, images };
}

// ─── دمج النتائج بترتيب الأولوية ────────────────────────────────────────────
function mergeResults(...results) {
  const merged = { title: null, description: null, price: null, currency: 'SAR', images: [] };
  for (const r of results) {
    if (!r) continue;
    if (!merged.title && r.title) merged.title = r.title;
    if (!merged.description && r.description) merged.description = r.description;
    if (!merged.price && r.price) merged.price = r.price;
    if (r.currency) merged.currency = r.currency;
    if (r.images && r.images.length) {
      for (const img of r.images) if (!merged.images.includes(img)) merged.images.push(img);
    }
  }
  return merged;
}

// ─── Shopify: يوفر endpoints رسمية JSON موثوقة 100% بدل تخمين HTML ──────────
function stripHtmlTags(html) {
  if (!html) return null;
  // نستخدم cheerio بدل regex عشان يفك ترميز HTML entities (&amp; ونحوها) بشكل صحيح
  const text = cheerio.load(`<div>${html}</div>`)('div').text();
  return text.replace(/\s+/g, ' ').trim() || null;
}

function shopifyProductToResult(p, baseUrl) {
  const variant = (p.variants && p.variants[0]) || {};
  return {
    title: p.title || null,
    description: stripHtmlTags(p.body_html),
    price: variant.price != null ? parseFloat(variant.price) : null,
    compareAtPrice: variant.compare_at_price != null ? parseFloat(variant.compare_at_price) : null,
    currency: null, // Shopify JSON ما يذكر العملة بهذا الـ endpoint — نعتمد الافتراضي SAR بالطبقة الأعلى
    images: (p.images || []).map(img => toAbsoluteUrl(img.src, baseUrl)).filter(Boolean),
    sourceUrl: p.handle ? new URL(`/products/${p.handle}`, baseUrl).toString() : baseUrl,
    handle: p.handle || null,
  };
}

// يحاول جلب منتج Shopify واحد عبر /products/{handle}.json — يرجع null إذا فشل (مو Shopify أو الرابط مو منتج)
async function tryShopifyProductJson(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/products\/([^\/?#]+)/);
    if (!m) return null;
    const jsonUrl = `${u.origin}/products/${m[1]}.json`;
    const res = await fetchWithTimeout(jsonUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.product) return null;
    return shopifyProductToResult(data.product, url);
  } catch {
    return null;
  }
}

// ─── الدالة الرئيسية — منتج واحد ─────────────────────────────────────────────
async function scrapeProductUrl(url) {
  // Shopify: نجرب endpoint الـ JSON الرسمي أول (أدق من تحليل HTML)
  const shopifyResult = await tryShopifyProductJson(url);
  if (shopifyResult && (shopifyResult.title || shopifyResult.price)) {
    return {
      title: shopifyResult.title,
      description: shopifyResult.description,
      price: shopifyResult.price,
      currency: 'SAR',
      images: shopifyResult.images.slice(0, 12),
      sourceUrl: url,
      platformDetected: 'shopify',
    };
  }

  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8' } });
  if (!res.ok) throw new Error(`تعذر فتح الرابط (HTTP ${res.status})`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const fromJsonLd = extractFromJsonLd($, url);
  const platform = detectPlatform($, html);
  const fromPlatform = platform ? extractByPlatform($, platform, url) : null;
  const fromGeneric = extractGeneric($, url);

  const merged = mergeResults(fromJsonLd, fromPlatform, fromGeneric);

  // تنظيف السعر لرقم عشري
  let price = null;
  if (merged.price) {
    const cleaned = String(merged.price).replace(/[^\d.]/g, '');
    const num = parseFloat(cleaned);
    if (!isNaN(num)) price = num;
  }

  return {
    title: merged.title,
    description: merged.description,
    price,
    currency: merged.currency || 'SAR',
    images: merged.images.slice(0, 12), // حد أعلى معقول لعدد الصور بالمعاينة
    sourceUrl: url,
    platformDetected: platform || (fromJsonLd ? 'json-ld' : 'generic'),
  };
}

// ─── سحب جماعي — صفحة مجموعة/تصنيف كاملة ─────────────────────────────────────
// يدعم حالياً Shopify فقط (عبر /collections/{handle}/products.json الرسمي).
// يرجع مصفوفة منتجات جاهزة للمراجعة، بدون تحميل صور فعلياً (يصير بخطوة confirm لاحقاً).
async function scrapeCollectionUrl(url) {
  const u = new URL(url);
  const isCollectionPath = /\/collections\//.test(u.pathname);
  if (!isCollectionPath) {
    throw new Error('الرابط لازم يكون رابط مجموعة/تصنيف (يحتوي /collections/)');
  }

  const allProducts = [];
  const perPage = 50;
  let page = 1;
  let sawShopify = false;

  // نجمع كل الصفحات (Shopify يحدد 50 كحد أقصى لكل استدعاء) حتى 300 منتج كحد أعلى أمان
  while (allProducts.length < 300) {
    const jsonUrl = `${u.origin}${u.pathname.replace(/\/$/, '')}/products.json?limit=${perPage}&page=${page}`;
    const res = await fetchWithTimeout(jsonUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok) break;
    let data;
    try { data = await res.json(); } catch { break; }
    if (!data || !Array.isArray(data.products) || !data.products.length) break;
    sawShopify = true;
    data.products.forEach(p => allProducts.push(shopifyProductToResult(p, url)));
    if (data.products.length < perPage) break; // آخر صفحة
    page++;
  }

  if (!sawShopify) {
    throw new Error('السحب الجماعي مدعوم حالياً لمتاجر Shopify فقط — هذا الرابط غير مدعوم');
  }

  return {
    sourceUrl: url,
    platformDetected: 'shopify',
    count: allProducts.length,
    products: allProducts.map(p => ({
      title: p.title,
      description: p.description,
      price: p.price,
      compareAtPrice: p.compareAtPrice,
      currency: 'SAR',
      images: p.images.slice(0, 8),
      sourceUrl: p.sourceUrl,
    })),
  };
}

async function downloadImageAsBuffer(url) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`فشل تحميل الصورة (HTTP ${res.status})`);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) throw new Error('الرابط المحدد ليس صورة');
  const buffer = await res.buffer();
  return { buffer, mimeType: contentType.split(';')[0].trim() };
}

module.exports = { scrapeProductUrl, scrapeCollectionUrl, downloadImageAsBuffer };
