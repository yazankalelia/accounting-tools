import { db } from './core/db/schema';
import { migrateFromSupercalc, LEGACY_COMPANY_ID } from './core/db/migrations';
import { getActiveCompanyId, setActiveCompanyId } from './core/db/dexie';
import { postBusinessTransaction } from './core/ledger/journal.service';
import { trialBalance } from './core/ledger/balance.service';
import { listBackups, scheduleBackups } from './core/backup/backup.service';

const root = document.getElementById('app')!;

root.innerHTML = `
  <main style="font-family:system-ui;max-width:820px;margin:40px auto;padding:0 20px;line-height:1.8">
    <h1>قيد — QAYD v4</h1>
    <p>الأساس الهندسي: Dexie · تعدد الشركات · قيد مزدوج ذري · تدقيق · جاهزية مزامنة.</p>
    <section id="status">جارٍ التهيئة…</section>
    <section style="margin-top:24px">
      <button id="demo">تجربة قيد مبيعات 1,000 + 15%</button>
      <pre id="out" style="background:#0f172a;color:#a7f3d0;padding:16px;border-radius:12px;overflow:auto"></pre>
    </section>
  </main>
`;

async function boot(): Promise<void> {
  await db.open();
  const report = await migrateFromSupercalc();
  if (!getActiveCompanyId()) setActiveCompanyId(LEGACY_COMPANY_ID);
  const companyId = getActiveCompanyId();
  scheduleBackups();
  const counts = {
    companies: await db.companies.count(),
    backups: await listBackups(companyId).then((b) => b.length),
    accounts: await db.accounts.count(),
    journalEntries: await db.journalEntries.count(),
    partners: await db.partners.count(),
    invoices: await db.invoices.count(),
    checks: await db.checks.count(),
  };
  document.getElementById('status')!.innerHTML =
    `<h2>حالة الترحيل: ${report.status}</h2><pre>${JSON.stringify({ companyId, counts, report }, null, 2)}</pre>`;

  document.getElementById('demo')!.addEventListener('click', async () => {
    const id = await postBusinessTransaction({
      companyId,
      entryDate: new Date().toISOString().slice(0, 10),
      description: 'فاتورة مبيعات تجريبية',
      sourceType: 'INVOICE',
      lines: [
        { accountId: '1300', debit: 1150 },
        { accountId: '4100', credit: 1000 },
        { accountId: '2200', credit: 150 },
      ],
    });
    const entry = await db.journalEntries.get(id);
    const tb = await trialBalance(companyId);
    document.getElementById('out')!.textContent = JSON.stringify({ entry, trialBalance: tb }, null, 2);
  });

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch { /* لا يؤثر على التشغيل */ }
  }
}

boot().catch((e) => {
  document.getElementById('status')!.textContent = 'خطأ: ' + (e instanceof Error ? e.message : String(e));
});
