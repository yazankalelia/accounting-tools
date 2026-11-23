import { mountApp } from './modules/app';

// في الإنتاج فقط: تسجيل نسبي تحت مجلد النشر (مثال /accounting-tools/beta/).
// الـservice worker يعمل network-first + skipWaiting، فلا يحجب تحديث الصفحة.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(new URL('sw.js', document.baseURI).toString(), { scope: './' })
      .catch((e) => console.warn('[QAYD sw]', e));
  });
}

mountApp().catch((e) => {
  const root = document.getElementById('app');
  if (root) {
    root.textContent = 'تعذّر تشغيل التطبيق: ' + (e instanceof Error ? e.message : String(e));
  }
  // تُرصد هذه الرسالة في Console عند وجود خطأ حقيقي أثناء الإقلاع.
  console.error('[QAYD boot]', e);
});
