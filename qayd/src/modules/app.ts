import '../ui/styles.css';
import { db } from '../core/db/schema';
import { getActiveCompanyId, setActiveCompanyId } from '../core/db/dexie';
import { migrateFromSupercalc, LEGACY_COMPANY_ID } from '../core/db/migrations';
import { createCompany, listCompanies } from '../core/company/company.service';
import { createUser, listUsers, setUserRole, suspendUser } from '../core/security/user.service';
import { createAccount, listAccounts, seedChartOfAccounts, ACCOUNT_TYPES } from '../core/accounts/accounts.service';
import { postBusinessTransaction, reverseEntry } from '../core/ledger/journal.service';
import { trialBalance } from '../core/ledger/balance.service';
import { createInvoice } from '../core/invoices/invoice.service';
import { incomeStatement, balanceSheet, cashFlow } from '../core/reports/financial-reports.service';
import { createBackup, listBackups, downloadBackup, restoreBackup, scheduleBackups } from '../core/backup/backup.service';
import { importBackupFile } from '../core/import/legacy-import.service';
import { ROLE_PERMISSIONS, type Role } from '../core/security/permissions';

type Fn = () => Promise<void> | void;
const q = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector<T>(sel);
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const money = (v: unknown): string => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });

let activeId = LEGACY_COMPANY_ID;
let pageEl: HTMLElement;
let navEl: HTMLElement;
let titleEl: HTMLElement;
let pillEl: HTMLElement;
/** رسالة تظهر بعد إعادة الرسم حتى لا تختفي عند تحديث الصفحة. */
let flash = '';

function toast(msg: string): void {
  const t = q<HTMLElement>('#toast')!;
  t.textContent = msg;
  t.classList.add('show');
  window.setTimeout(() => t.classList.remove('show'), 3200);
}

function alertBox(text: string, ok = false): string {
  return `<div class="alert ${ok ? 'ok' : 'err'}">${esc(text)}</div>`;
}

function shell(): void {
  const app = q<HTMLElement>('#app')!;
  app.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">قيد <small>QAYD · v4</small></div>
      <nav class="nav" id="nav">
        <a href="#/dashboard">▦ نظرة عامة</a>
        <a href="#/companies">▣ الشركات</a>
        <a href="#/users">♙ المستخدمون والصلاحيات</a>
        <a href="#/accounts">☰ دليل الحسابات</a>
        <a href="#/journal">⇄ القيود</a>
        <a href="#/invoices">▤ الفواتير</a>
        <a href="#/reports">▥ التقارير</a>
        <a href="#/backups">⬒ النسخ الاحتياطي</a>
      </nav>
      <div class="company-box">الشركة النشطة
        <select id="activeCompany"></select>
      </div>
    </aside>
    <main class="content">
      <header class="topbar"><h1 id="pageTitle"></h1><span class="pill" id="pill">جاهز</span></header>
      <div id="flashSlot"></div>
      <div id="page"></div>
    </main>
  </div><div id="toast"></div>`;
  pageEl = q<HTMLElement>('#page')!;
  navEl = q<HTMLElement>('#nav')!;
  titleEl = q<HTMLElement>('#pageTitle')!;
  pillEl = q<HTMLElement>('#pill')!;
}

async function refreshCompanyPicker(): Promise<void> {
  const sel = q<HTMLSelectElement>('#activeCompany')!;
  const companies = await listCompanies();
  sel.innerHTML = companies.map((c) =>
    `<option value="${esc(c.id)}" ${c.id === activeId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  sel.onchange = () => { setActiveCompanyId(sel.value); activeId = sel.value; void render(); };
}

async function render(): Promise<void> {
  const route = location.hash.replace(/^#\/?/, '') || 'dashboard';
  navEl.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${route}`));
  const titles: Record<string, string> = {
    dashboard: 'نظرة عامة', companies: 'الشركات', users: 'المستخدمون والصلاحيات',
    accounts: 'دليل الحسابات', journal: 'القيود', invoices: 'الفواتير',
    reports: 'التقارير المالية', backups: 'النسخ الاحتياطي والاستيراد',
  };
  titleEl.textContent = titles[route] ?? 'قيد';
  pillEl.textContent = activeId;
  await refreshCompanyPicker();
  const pages: Record<string, Fn> = {
    dashboard: pageDashboard, companies: pageCompanies, users: pageUsers,
    accounts: pageAccounts, journal: pageJournal, invoices: pageInvoices,
    reports: pageReports, backups: pageBackups,
  };
  try { await (pages[route] ?? pageDashboard)(); }
  catch (e) { pageEl.innerHTML = alertBox('خطأ: ' + (e instanceof Error ? e.message : String(e))); }
  q<HTMLElement>('#flashSlot')!.innerHTML = flash;
  flash = '';
}

/* ---------- نظرة عامة ---------- */
async function pageDashboard(): Promise<void> {
  const [companies, accounts, entries, invoices, backups] = await Promise.all([
    db.companies.count(), db.accounts.count(), db.journalEntries.count(),
    db.invoices.count(), listBackups(activeId).then((b) => b.length),
  ]);
  pageEl.innerHTML = `
  <div class="grid g4">
    <div class="stat"><span>الشركات</span><b>${companies}</b></div>
    <div class="stat"><span>الحسابات</span><b>${accounts}</b></div>
    <div class="stat"><span>القيود</span><b>${entries}</b></div>
    <div class="stat"><span>الفواتير</span><b>${invoices}</b></div>
  </div>
  <div class="card" style="margin-top:16px">
    <h2>ابدأ من هنا</h2>
    <p style="color:var(--muted);font-size:13px">الترتيب المقترح: شركة ← مستخدمون ← دليل حسابات ← قيود ← فواتير ← تقارير ← نسخة احتياطية.</p>
    <div class="row">
      <button class="ghost" data-go="companies">الشركات</button>
      <button class="ghost" data-go="accounts">دليل الحسابات</button>
      <button class="ghost" data-go="journal">القيود</button>
      <button class="ghost" data-go="reports">التقارير</button>
    </div>
  </div>
  <div class="card"><h2>النسخ الاحتياطي</h2><p>عدد النسخ لهذه الشركة: <b>${backups}</b></p>
    <button class="ghost sm" id="dashBackup">إنشاء نسخة الآن</button><span id="dashOut"></span></div>`;
  pageEl.querySelectorAll<HTMLElement>('[data-go]').forEach((b) =>
    b.onclick = () => { location.hash = `#/${b.dataset.go}`; });
  q<HTMLElement>('#dashBackup')!.onclick = async () => {
    await createBackup(activeId, 'MANUAL');
    q<HTMLElement>('#dashOut')!.innerHTML = alertBox('تم إنشاء النسخة', true);
    toast('تم إنشاء النسخة الاحتياطية');
  };
}

/* ---------- الشركات ---------- */
async function pageCompanies(): Promise<void> {
  const rows = await listCompanies();
  pageEl.innerHTML = `
  <div class="card"><h2>شركة جديدة</h2>
    <div class="row">
      <div><label>اسم الشركة</label><input id="coName" placeholder="مثال: شركة النور"></div>
      <div><label>العملة</label><select id="coCur"><option>JOD</option><option>SAR</option><option>USD</option><option>EUR</option></select></div>
      <div><label>الرقم الضريبي</label><input id="coTax" placeholder="اختياري"></div>
      <div class="fixed"><button id="coAdd">إنشاء</button></div>
    </div><div id="coMsg"></div>
  </div>
  <div class="card"><h2>الشركات المسجلة (${rows.length})</h2>
    ${rows.length ? `<table><thead><tr><th>الاسم</th><th>العملة</th><th>الرقم الضريبي</th><th>الحالة</th><th></th></tr></thead><tbody>
    ${rows.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.currency)}</td><td>${esc(c.taxNumber || '—')}</td>
      <td>${c.status === 'ACTIVE' ? 'نشطة' : 'موقوفة'}</td>
      <td><button class="sm ghost" data-act="${esc(c.id)}">${c.id === activeId ? 'نشطة حاليًا' : 'تفعيل'}</button></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">لا توجد شركات بعد.</div>'}
  </div>`;
  q<HTMLElement>('#coAdd')!.onclick = async () => {
    const name = q<HTMLInputElement>('#coName')!.value;
    try {
      const c = await createCompany({
        name, currency: q<HTMLSelectElement>('#coCur')!.value,
        taxNumber: q<HTMLInputElement>('#coTax')!.value,
      });
      await seedChartOfAccounts(c.id);
      setActiveCompanyId(c.id);
      activeId = c.id;
      flash = alertBox(`تم إنشاء ${c.name} مع 11 حسابًا افتراضيًا`, true);
      toast(`تم إنشاء ${c.name} مع 11 حسابًا افتراضيًا`);
      await render();
    } catch (e) { q<HTMLElement>('#coMsg')!.innerHTML = alertBox((e as Error).message); }
  };
  pageEl.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => b.onclick = () => {
    setActiveCompanyId(b.dataset.act!); activeId = b.dataset.act!; void render();
  });
}

/* ---------- المستخدمون ---------- */
async function pageUsers(): Promise<void> {
  const users = await listUsers(activeId);
  const roles = Object.keys(ROLE_PERMISSIONS) as Role[];
  pageEl.innerHTML = `
  <div class="card"><h2>مستخدم جديد في «${esc(activeId)}»</h2>
    <div class="row">
      <div><label>الاسم</label><input id="uName" placeholder="اسم المستخدم"></div>
      <div><label>البريد</label><input id="uEmail" placeholder="name@example.com"></div>
      <div><label>الدور</label><select id="uRole">${roles.map((r) => `<option ${r === 'ACCOUNTANT' ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
      <div class="fixed"><button id="uAdd">إضافة</button></div>
    </div><div id="uMsg"></div>
    <p style="color:var(--muted);font-size:12px;margin-bottom:0">صلاحيات الدور: ${roles.map((r) => `<b>${r}</b>: ${Object.entries(ROLE_PERMISSIONS[r]).map(([k, v]) => `${k}(${(v as string[]).join(',')})`).join(' · ') || 'كل شيء'}`).join('<br>')}</p>
  </div>
  <div class="card"><h2>المستخدمون (${users.length})</h2>
    ${users.length ? `<table><thead><tr><th>الاسم</th><th>البريد</th><th>الدور</th><th>الحالة</th><th></th></tr></thead><tbody>
    ${users.map((u) => {
      const m = { role: u.companyRole, status: u.companyStatus };
      return `<tr><td>${esc(u.name)}</td><td>${esc(u.email || '—')}</td>
        <td>${m ? `<select class="roleSel" data-user="${esc(u.id)}">${roles.map((r) => `<option ${m.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>` : 'لا عضوية'}</td>
        <td>${m?.status === 'SUSPENDED' ? 'معلّق' : 'نشط'}</td>
        <td>${m ? `<button class="sm ${m.status === 'SUSPENDED' ? '' : 'danger'}" data-suspend="${esc(u.id)}" data-val="${m.status === 'SUSPENDED' ? '0' : '1'}">${m.status === 'SUSPENDED' ? 'تفعيل' : 'تعليق'}</button>` : ''}</td></tr>`;
    }).join('')}</tbody></table>` : '<div class="empty">لا يوجد مستخدمون بعد.</div>'}
  </div>`;
  q<HTMLElement>('#uAdd')!.onclick = async () => {
    try {
      await createUser({
        name: q<HTMLInputElement>('#uName')!.value,
        email: q<HTMLInputElement>('#uEmail')!.value,
        role: q<HTMLSelectElement>('#uRole')!.value as Role,
        companyId: activeId,
      });
      flash = alertBox('تم إنشاء المستخدم', true);
      toast('تم إنشاء المستخدم'); await render();
    } catch (e) { q<HTMLElement>('#uMsg')!.innerHTML = alertBox((e as Error).message); }
  };
  pageEl.querySelectorAll<HTMLSelectElement>('.roleSel').forEach((s) => s.onchange = async () => {
    await setUserRole(s.dataset.user!, activeId, s.value as Role);
    toast('تم تحديث الدور');
  });
  pageEl.querySelectorAll<HTMLElement>('[data-suspend]').forEach((b) => b.onclick = async () => {
    await suspendUser(b.dataset.suspend!, activeId, b.dataset.val === '1');
    await render();
  });
}

/* ---------- دليل الحسابات ---------- */
async function pageAccounts(): Promise<void> {
  const rows = await listAccounts(activeId);
  pageEl.innerHTML = `
  <div class="card"><h2>حساب جديد</h2>
    <div class="row">
      <div><label>الرمز</label><input id="aCode" placeholder="1100"></div>
      <div><label>الاسم</label><input id="aName" placeholder="النقدية"></div>
      <div><label>النوع</label><select id="aType">${ACCOUNT_TYPES.map((t) => `<option>${t}</option>`).join('')}</select></div>
      <div class="fixed"><button id="aAdd">إضافة</button></div>
      <div class="fixed"><button class="ghost" id="aSeed">تهيئة 11 حسابًا</button></div>
    </div><div id="aMsg"></div>
  </div>
  <div class="card"><h2>دليل الحسابات (${rows.length})</h2>
    ${rows.length ? `<table><thead><tr><th>الرمز</th><th>الاسم</th><th>النوع</th><th>الرصيد</th><th>الحالة</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${esc(r.type)}</td><td class="num">${money(r.balance ?? 0)}</td><td>${esc(r.status)}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">الدليل فارغ — استخدم «تهيئة 11 حسابًا».</div>'}
  </div>`;
  q<HTMLElement>('#aAdd')!.onclick = async () => {
    try {
      await createAccount({ companyId: activeId, code: q<HTMLInputElement>('#aCode')!.value,
        name: q<HTMLInputElement>('#aName')!.value,
        type: q<HTMLSelectElement>('#aType')!.value as any });
      flash = alertBox('تم إنشاء الحساب', true);
      toast('تم إنشاء الحساب'); await render();
    } catch (e) { q<HTMLElement>('#aMsg')!.innerHTML = alertBox((e as Error).message); }
  };
  q<HTMLElement>('#aSeed')!.onclick = async () => {
    const n = await seedChartOfAccounts(activeId);
    const msg = n ? `تم إنشاء ${n} حسابًا` : 'الدليل يحتوي حسابات بالفعل';
    flash = alertBox(msg, n > 0); toast(msg); await render();
  };
}

/* ---------- القيود ---------- */
function accountOptions(rows: any[]): string {
  return rows.map((a) => `<option value="${esc(a.code)}">${esc(a.code)} — ${esc(a.name)}</option>`).join('');
}

async function pageJournal(): Promise<void> {
  const [accounts, entries] = await Promise.all([
    listAccounts(activeId),
    db.journalEntries.where('companyId').equals(activeId).reverse().sortBy('entryDate'),
  ]);
  const line = (i: number) => `<div class="line-item" data-line="${i}">
    <div><label>الحساب</label><select class="lAcc">${accountOptions(accounts)}</select></div>
    <div><label>مدين</label><input class="lD" type="number" min="0" step="0.01" value="0"></div>
    <div><label>دائن</label><input class="lC" type="number" min="0" step="0.01" value="0"></div>
    <div><button class="ghost sm delLine">✕</button></div>
  </div>`;
  pageEl.innerHTML = `
  <div class="card"><h2>قيد جديد</h2>
    <div class="grid g3">
      <div><label>التاريخ</label><input id="jDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div><label>البيان</label><input id="jDesc" placeholder="وصف القيد"></div>
      <div><label>نوع المصدر</label><select id="jSource"><option>MANUAL</option><option>INVOICE</option><option>PAYMENT</option><option>CHECK</option></select></div>
    </div>
    <div id="lines" style="margin:14px 0">${line(0)}${line(1)}</div>
    <div class="row">
      <button class="ghost" id="jAddLine">+ سطر</button>
      <div class="fixed"><span id="jTotals" style="font-size:13px;color:var(--muted)"></span></div>
      <div class="fixed"><button id="jSave">ترحيل القيد</button></div>
    </div><div id="jMsg"></div>
  </div>
  <div class="card"><h2>القيود المرحّلة (${entries.length})</h2>
    ${entries.length ? `<table><thead><tr><th>الرقم</th><th>التاريخ</th><th>البيان</th><th>الحالة</th><th>المصدر</th><th></th></tr></thead><tbody>
    ${entries.slice(0, 30).map((e) => `<tr><td>${esc(e.entryNumber)}</td><td>${esc(e.entryDate)}</td><td>${esc(e.description)}</td>
      <td>${esc(e.status)}</td><td>${esc(e.sourceType)}</td>
      <td>${e.status === 'POSTED' ? `<button class="sm ghost" data-rev="${esc(e.id)}">عكس</button>` : ''}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">لا توجد قيود بعد.</div>'}
  </div>`;

  const linesBox = q<HTMLElement>('#lines')!;
  const refreshTotals = (): void => {
    let d = 0, c = 0;
    linesBox.querySelectorAll<HTMLElement>('.line-item').forEach((r) => {
      d += Number(q<HTMLInputElement>('.lD', r)!.value || 0);
      c += Number(q<HTMLInputElement>('.lC', r)!.value || 0);
    });
    const el = q<HTMLElement>('#jTotals')!;
    el.textContent = `مدين ${money(d)} · دائن ${money(c)} · الفرق ${money(d - c)}`;
    el.style.color = Math.abs(d - c) < 0.005 ? 'var(--ok)' : 'var(--danger)';
  };
  linesBox.oninput = refreshTotals;
  linesBox.onclick = (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('delLine') && linesBox.querySelectorAll('.line-item').length > 2) {
      target.closest('.line-item')!.remove(); refreshTotals();
    }
  };
  q<HTMLElement>('#jAddLine')!.onclick = () => { linesBox.insertAdjacentHTML('beforeend', line(linesBox.children.length)); refreshTotals(); };
  refreshTotals();

  q<HTMLElement>('#jSave')!.onclick = async () => {
    const rows = [...linesBox.querySelectorAll<HTMLElement>('.line-item')].map((r) => ({
      accountId: q<HTMLSelectElement>('.lAcc', r)!.value,
      debit: Number(q<HTMLInputElement>('.lD', r)!.value || 0),
      credit: Number(q<HTMLInputElement>('.lC', r)!.value || 0),
    }));
    try {
      const id = await postBusinessTransaction({
        companyId: activeId,
        entryDate: q<HTMLInputElement>('#jDate')!.value,
        description: q<HTMLInputElement>('#jDesc')!.value || 'قيد يدوي',
        sourceType: q<HTMLSelectElement>('#jSource')!.value as any,
        lines: rows,
      });
      flash = alertBox(`تم ترحيل القيد ${id} وإنشاء نسخة احتياطية`, true);
      toast('تم ترحيل القيد وإنشاء نسخة احتياطية'); await render();
    } catch (e) { q<HTMLElement>('#jMsg')!.innerHTML = alertBox((e as Error).message); }
  };
  pageEl.querySelectorAll<HTMLElement>('[data-rev]').forEach((b) => b.onclick = async () => {
    try {
      await reverseEntry(b.dataset.rev!, activeId);
      flash = alertBox('تم إنشاء قيد معاكس', true); toast('تم إنشاء قيد معاكس'); await render();
    }
    catch (e) { toast((e as Error).message); }
  });
}

/* ---------- الفواتير ---------- */
async function pageInvoices(): Promise<void> {
  const accounts = await listAccounts(activeId);
  const invoices = await db.invoices.where('companyId').equals(activeId).reverse().sortBy('invoiceDate');
  pageEl.innerHTML = `
  <div class="card"><h2>فاتورة مبيعات مع ضريبة</h2>
    <div class="grid g3">
      <div><label>الطرف (اسم أو معرّف)</label><input id="fPartner" placeholder="العميل"></div>
      <div><label>التاريخ</label><input id="fDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div><label>نسبة الضريبة %</label><input id="fVat" type="number" value="15" min="0" step="0.5"></div>
    </div>
    <div class="grid g3" style="margin-top:12px">
      <div><label>البيان</label><input id="fDesc" value="خدمة استشارية"></div>
      <div><label>الكمية</label><input id="fQty" type="number" value="2" min="1"></div>
      <div><label>سعر الوحدة</label><input id="fPrice" type="number" value="500" min="0"></div>
    </div>
    <div style="margin-top:14px"><button id="fSave">إنشاء الفاتورة والقيد</button></div>
    <div id="fMsg"></div>
  </div>
  <div class="card"><h2>الفواتير (${invoices.length})</h2>
    ${invoices.length ? `<table><thead><tr><th>الرقم</th><th>التاريخ</th><th>الطرف</th><th>الإجمالي</th><th>الضريبة</th><th>المدفوع</th><th>الحالة</th></tr></thead><tbody>
    ${invoices.map((i) => `<tr><td>${esc(i.invoiceNumber)}</td><td>${esc(i.invoiceDate)}</td><td>${esc(i.partnerId)}</td>
      <td class="num">${money(i.total)}</td><td class="num">${money(i.taxTotal)}</td><td class="num">${money(i.paidAmount)}</td><td>${esc(i.status)}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">لا توجد فواتير بعد. الحسابات المستخدمة: ' + accountOptions(accounts).replace(/<[^>]+>/g, ' ').trim() + '</div>'}
  </div>`;
  q<HTMLElement>('#fSave')!.onclick = async () => {
    try {
      const r = await createInvoice({
        companyId: activeId,
        partnerId: q<HTMLInputElement>('#fPartner')!.value || 'عميل',
        type: 'SALE', invoiceDate: q<HTMLInputElement>('#fDate')!.value,
        taxRate: Number(q<HTMLInputElement>('#fVat')!.value || 0),
        items: [{
          description: q<HTMLInputElement>('#fDesc')!.value,
          quantity: Number(q<HTMLInputElement>('#fQty')!.value),
          unitPrice: Number(q<HTMLInputElement>('#fPrice')!.value),
        }],
      });
      flash = alertBox(`فاتورة ${r.invoiceNumber} — الإجمالي ${money(r.total)} — القيد ${r.entryId} (معاملة واحدة)`, true);
      toast('أنشئت الفاتورة والقيد في معاملة واحدة'); await render();
    } catch (e) { q<HTMLElement>('#fMsg')!.innerHTML = alertBox((e as Error).message); }
  };
}

/* ---------- التقارير ---------- */
async function pageReports(): Promise<void> {
  pageEl.innerHTML = `
  <div class="card"><h2>التقارير</h2>
    <div class="row">
      <button class="ghost" data-rep="tb">ميزان المراجعة</button>
      <button class="ghost" data-rep="is">قائمة الدخل</button>
      <button class="ghost" data-rep="bs">الميزانية العمومية</button>
      <button class="ghost" data-rep="cf">قائمة التدفقات</button>
    </div>
  </div>
  <div class="card"><h2 id="repTitle">النتيجة</h2><div id="repBody"><div class="empty">اختر تقريرًا أعلاه.</div></div></div>`;
  const renderObj = (title: string, obj: unknown): void => {
    q<HTMLElement>('#repTitle')!.textContent = title;
    q<HTMLElement>('#repBody')!.innerHTML = `<pre>${esc(JSON.stringify(obj, null, 2))}</pre>`;
  };
  pageEl.querySelectorAll<HTMLElement>('[data-rep]').forEach((b) => b.onclick = async () => {
    const kind = b.dataset.rep!;
    if (kind === 'tb') {
      const rows = await trialBalance(activeId);
      q<HTMLElement>('#repTitle')!.textContent = 'ميزان المراجعة';
      q<HTMLElement>('#repBody')!.innerHTML = rows.length ? `<table><thead><tr><th>الحساب</th><th>مدين</th><th>دائن</th></tr></thead><tbody>
        ${rows.map((r: any) => `<tr><td>${esc(r.code ?? r.accountId)}</td><td class="num">${money(r.debit)}</td><td class="num">${money(r.credit)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">لا توجد أرصدة بعد.</div>';
    }
    if (kind === 'is') renderObj('قائمة الدخل', await incomeStatement(activeId));
    if (kind === 'bs') renderObj('الميزانية العمومية', await balanceSheet(activeId));
    if (kind === 'cf') renderObj('قائمة التدفقات النقدية', await cashFlow(activeId));
  });
}

/* ---------- النسخ الاحتياطي ---------- */
async function pageBackups(): Promise<void> {
  const rows = await listBackups(activeId);
  pageEl.innerHTML = `
  <div class="card"><h2>نسخة جديدة</h2>
    <div class="row"><div class="fixed"><button id="bkNew">إنشاء نسخة محلية</button></div>
      <div class="fixed"><button class="ghost" id="bkDownload">تنزيل أحدث نسخة JSON</button></div></div>
    <div id="bkMsg"></div>
  </div>
  <div class="card"><h2>النسخ (${rows.length})</h2>
    ${rows.length ? `<table><thead><tr><th>التاريخ</th><th>النوع</th><th>الحجم</th><th>Checksum</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(String(r.createdAt).slice(0, 19).replace('T', ' '))}</td><td>${esc(r.type)}</td>
      <td class="num">${Number(r.sizeBytes || 0).toLocaleString()}</td><td dir="ltr" style="font-size:10px">${esc(String(r.checksum || '').slice(0, 16))}…</td>
      <td><button class="sm ghost" data-dl="${esc(r.id)}">تنزيل</button> <button class="sm" data-restore="${esc(r.id)}">استعادة</button></td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">لا توجد نسخ بعد.</div>'}
  </div>
  <div class="card"><h2>استيراد ملف قديم أو نسخة QAYD</h2>
    <input type="file" id="bkFile" accept="application/json,.json">
    <div style="margin-top:10px"><button id="bkImport">استيراد</button></div>
    <div id="impMsg"></div>
    <p style="color:var(--muted);font-size:12px">يُنشأ نسخة وقائية تلقائيًا قبل أي استيراد، ويُتحقق من checksum إن وُجد.</p>
  </div>`;
  q<HTMLElement>('#bkNew')!.onclick = async () => {
    await createBackup(activeId, 'MANUAL');
    flash = alertBox('تم إنشاء نسخة احتياطية جديدة', true); toast('تم إنشاء النسخة'); await render();
  };
  q<HTMLElement>('#bkDownload')!.onclick = async () => {
    const list = await listBackups(activeId);
    if (list.length) { await downloadBackup(activeId, list[0].id); toast('تم تنزيل الملف'); }
    else q<HTMLElement>('#bkMsg')!.innerHTML = alertBox('لا توجد نسخة لتنزيلها');
  };
  pageEl.querySelectorAll<HTMLElement>('[data-dl]').forEach((b) => b.onclick = () => void downloadBackup(activeId, b.dataset.dl!));
  pageEl.querySelectorAll<HTMLElement>('[data-restore]').forEach((b) => b.onclick = async () => {
    if (!window.confirm('ستُستعاد النسخة وسيُستبدل وضع الشركة الحالي. متابعة؟')) return;
    try {
      await restoreBackup(activeId, b.dataset.restore!);
      flash = alertBox('تمت الاستعادة بنجاح', true); toast('تمت الاستعادة بنجاح'); await render();
    }
    catch (e) { q<HTMLElement>('#bkMsg')!.innerHTML = alertBox((e as Error).message); }
  });
  q<HTMLElement>('#bkImport')!.onclick = async () => {
    const file = q<HTMLInputElement>('#bkFile')!.files?.[0];
    if (!file) { q<HTMLElement>('#impMsg')!.innerHTML = alertBox('اختر ملف JSON أولًا'); return; }
    try {
      const r = await importBackupFile(await file.text());
      q<HTMLElement>('#impMsg')!.innerHTML = alertBox(
        `تم الاستيراد: ${r.format} · شركة ${r.companyId} · ${JSON.stringify(r.counts)}`, true);
      toast('تم استيراد البيانات بنجاح');
    } catch (e) { q<HTMLElement>('#impMsg')!.innerHTML = alertBox((e as Error).message); }
  };
}

/** نقطة الدخول: تُبنى الواجهة بعد اكتمال فتح قاعدة البيانات والترحيل. */
export async function mountApp(): Promise<void> {
  shell();
  await db.open();
  scheduleBackups();
  const report = await migrateFromSupercalc();
  if (!getActiveCompanyId()) setActiveCompanyId(LEGACY_COMPANY_ID);
  activeId = getActiveCompanyId() || LEGACY_COMPANY_ID;
  window.addEventListener('hashchange', () => void render());
  await render();
  if (!location.hash) location.hash = '#/dashboard';
  pillEl.title = `حالة الترحيل: ${report.status}`;
}
