// سكربت مشترك لصفحة تفاصيل المنتج (SSR) — زر إضافة للسلة
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.querySelector('.btn-add-cart');
  if (!btn || btn.disabled) return;
  btn.addEventListener('click', async () => {
    const productId = btn.dataset.productId;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'جاري الإضافة...';
    try {
      const res = await fetch('/jomla/api/cart/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ productId: Number(productId), quantity: 1 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشلت الإضافة');
      btn.textContent = 'تمت الإضافة ✓';
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1200);
    } catch (err) {
      btn.textContent = err.message || 'خطأ، حاول مجدداً';
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1800);
    }
  });
});
