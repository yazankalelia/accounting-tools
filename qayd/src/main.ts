import { mountApp } from './modules/app';

mountApp().catch((e) => {
  const root = document.getElementById('app');
  if (root) {
    root.textContent = 'تعذّر تشغيل التطبيق: ' + (e instanceof Error ? e.message : String(e));
  }
  // تُرصد هذه الرسالة في Console عند وجود خطأ حقيقي أثناء الإقلاع.
  console.error('[QAYD boot]', e);
});
