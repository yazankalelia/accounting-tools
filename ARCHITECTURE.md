# الهندسة النهائية لقيد — QAYD v4 (توثيق محفوظ)

آخر تحديث: 2026-11-23 · الحالة: **تصميم معتمد، التنفيذ على مراحل** · المرجع: `CHANGELOG.md`

هذا الملف هو المرجع الهندسي المعتمد للانتقال من المخزن المحلي الحالي (`SCStore` / `supercalc` v3) إلى قاعدة **Dexie.js** بإصدار **4**، متعددة الشركات، جاهزة للمزامنة لاحقًا.

---

## 1. المبدأ الحاكم (غير قابل للتفاوض)

1. **كل بيانات مالية تنتمي إلى `companyId`.** لا يوجد استعلام بلا قيد شركة — حتى `accounts` و`taxRates`.
2. **كل عملية مالية تمر عبر قيد مزدوج داخل معاملة واحدة** (`db.transaction('rw', ...)`). لا يُكتب أصل العملية (فاتورة/شيك/دفعة) إلا مع سطور القيد في نفس المعاملة — إما كلها أو لا شيء.
3. **القيد المرحّل لا يُحذف ولا يُعدّل** — يُنشأ قيد معاكس `reversalOfId` (append-only audit).
4. **الترقيم ذري لكل شركة** عبر عدّاد داخل نفس المعاملة (لاحقًا `syncQueue` يضمن الترتيب عند المزامنة).
5. **النسخة/الحالة قابلة للمزامنة**: كل سجل قابل للتغيير يحمل `version`, `updatedAt`, `syncStatus`.

---

## 2. لماذا Dexie؟

- يتعامل مع IndexedDB مباشرة (لا خادم، لا SDK سحابي) — يحفظ مبدأ «ملف واحد، بلا مكتبات خارجية» من حيث **النشر**: سيُضمَّن `dexie.min.js` داخل `index.html` (لا CDN، لا طلب شبكة، متوافق مع العمل دون اتصال).
- `upgrade()` يوفّر ترحيلًا مُنظّمًا من `supercalc` v1/v2/v3 إلى `qayd_db` v4 دون حذف البيانات القديمة فورًا.
- المعاملات (`transaction`) والفهارس المركّبة (`[companyId+...]`) مطابقة تمامًا لمبدأ القيد المزدوج والفصل بين الشركات.

> ملاحظة: ملف `calculator.html` الحالي **لا يحتوي CSP صارمًا**، لذا تضمين Dexieinlineً لا يتطلب تعديل سياسة. إن أُضيف CSP لاحقًا يُسمح بـ`'unsafe-inline'` للسكربت المضمن أو يُستبدل بـ blob/مصدر خارجي موثوق.

---

## 3. مخطط IndexedDB النهائي (الإصدار 4)

```js
import Dexie from 'dexie';

export const db = new Dexie('qayd_db');

db.version(4).stores({
  // الحساب والشركات
  users: 'id, email, name, status, [email+status]',
  userCompanies: 'id, userId, companyId, role, status, [userId+companyId], [companyId+userId]',
  companies: 'id, name, slug, currency, taxNumber, status, [name+status]',
  companySettings: 'id, companyId, key, value, [companyId+key]',
  fiscalYears: 'id, companyId, startDate, endDate, status, [companyId+status], [companyId+startDate]',
  fiscalPeriods: 'id, companyId, fiscalYearId, startDate, endDate, isClosed, [companyId+isClosed]',

  // دليل الحسابات والقيود
  accounts: 'id, companyId, code, name, type, normalBalance, parentId, currency, status, [companyId+code], [companyId+type], [companyId+parentId], [companyId+status]',
  journalEntries: 'id, companyId, entryNumber, entryDate, description, status, sourceType, sourceId, reversalOfId, currency, exchangeRate, createdBy, createdAt, updatedAt, version, syncStatus, [companyId+entryNumber], [companyId+entryDate], [companyId+status], [companyId+sourceType+sourceId], [companyId+syncStatus]',
  journalLines: 'id, companyId, journalEntryId, accountId, debit, credit, currency, exchangeRate, description, lineDate, costCenterId, projectId, [companyId+journalEntryId], [companyId+accountId+lineDate], [companyId+accountId], [companyId+syncStatus]',

  // الأطراف والأصناف
  partners: 'id, companyId, name, partnerType, taxNumber, phone, email, address, openingBalance, openingBalanceDirection, status, [companyId+name], [companyId+partnerType], [companyId+status]',
  products: 'id, companyId, name, sku, unit, salePrice, costPrice, taxRateId, status, [companyId+name], [companyId+sku]',

  // الفواتير والمدفوعات
  invoices: 'id, companyId, invoiceType, invoiceNumber, invoiceDate, dueDate, partnerId, currency, exchangeRate, subtotal, discountTotal, taxTotal, total, paidAmount, creditNoteAmount, balanceDue, status, notes, createdBy, createdAt, updatedAt, version, syncStatus, [companyId+invoiceType+invoiceNumber], [companyId+invoiceDate], [companyId+partnerId], [companyId+status], [companyId+syncStatus]',
  invoiceLines: 'id, companyId, invoiceId, productId, description, quantity, unitPrice, discountRate, discountAmount, taxRateId, taxAmount, lineTotal, [companyId+invoiceId], [companyId+productId]',

  payments: 'id, companyId, paymentType, paymentNumber, paymentDate, partnerId, bankAccountId, currency, exchangeRate, amount, status, reference, notes, createdBy, createdAt, updatedAt, version, syncStatus, [companyId+paymentNumber], [companyId+paymentDate], [companyId+partnerId], [companyId+status], [companyId+syncStatus]',
  paymentAllocations: 'id, companyId, paymentId, invoiceId, amount, currency, exchangeRate, [companyId+paymentId], [companyId+invoiceId]',

  // الشيكات
  checks: 'id, companyId, checkType, checkNumber, bankId, partnerId, issueDate, dueDate, amount, currency, status, invoiceId, notes, createdBy, createdAt, updatedAt, version, syncStatus, [companyId+checkType+status], [companyId+dueDate], [companyId+partnerId], [companyId+invoiceId], [companyId+syncStatus]',
  checkEvents: 'id, companyId, checkId, eventType, eventDate, amount, journalEntryId, notes, createdBy, createdAt, [companyId+checkId+eventDate], [companyId+checkId]',

  // البنوك والضريبة
  banks: 'id, companyId, name, accountNumber, currency, openingBalance, status, [companyId+name], [companyId+status]',
  bankTransactions: 'id, companyId, bankId, transactionDate, valueDate, description, reference, amount, direction, reconciliationStatus, matchedPaymentId, journalEntryId, [companyId+bankId+transactionDate], [companyId+reconciliationStatus]',
  taxRates: 'id, companyId, name, rate, taxType, appliesTo, isDefault, status, [companyId+taxType], [companyId+isDefault]',
  taxReturns: 'id, companyId, periodStart, periodEnd, status, outputTax, inputTax, netTax, journalEntryId, [companyId+periodStart], [companyId+status]',

  // المخزون لاحقًا
  inventoryItems: 'id, companyId, productId, warehouseId, quantity, unitCost, currency, status, [companyId+productId], [companyId+warehouseId]',
  warehouses: 'id, companyId, name, status, [companyId+name]',
  inventoryMovements: 'id, companyId, productId, warehouseId, movementType, movementDate, quantity, unitCost, totalCost, sourceType, sourceId, [companyId+productId+movementDate], [companyId+warehouseId]',

  // التدقيق والمزامنة
  auditLogs: 'id, companyId, userId, tableName, recordId, action, changedAt, beforeData, afterData, ipAddress, deviceId, [companyId+tableName+recordId], [companyId+changedAt], [companyId+userId]',
  syncQueue: 'id, companyId, operation, tableName, recordId, payload, status, attempts, lastError, createdAt, updatedAt, [companyId+status], [companyId+tableName+recordId]',
  syncState: 'id, companyId, lastPulledAt, lastPushedAt, schemaVersion, [companyId+schemaVersion]',

  backups: 'id, companyId, createdAt, type, sizeBytes, status, storageLocation, checksum, [companyId+createdAt], [companyId+status]',
  attachments: 'id, companyId, entityType, entityId, fileName, mimeType, sizeBytes, storageKey, createdAt, [companyId+entityType+entityId]'
});
```

> ملاحظة تقنية: بعض حقول مثل `syncStatus` تظهر داخل فهارس مركّبة فقط (`[companyId+syncStatus]`) دون إعلانها كحقل مستقل — هذا صالح في Dexie (الفهرس يُنشأ من قيمة الكائن حتى لو لم تُذكر في سلسلة المتاجر).

---

## 4. استراتيجية الترحيل (Migration v3 → v4)

1. **`db.version(4).stores(...)`** يُنشئ المتاجر الجديدة فارغة ويُبقي قاعدة `supercalc` القديمة كما هي (لا حذف).
2. دالة `migrateFromSupercalc()` تعمل مرة واحدة عند أول إقلاع بعد الترقية:
   - تقرأ `kv` (إعدادات الشركة، الشعار، اسم المؤسسة، عملة) → تنشئ `companies` + `companySettings`.
   - تقرأ `coa` (24 حسابًا) → `accounts` بنفس الرموز 1100/1200/1300/2100/2200/2210/4100/5100/3200 مع `companyId`.
   - تقرأ `journal` → `journalEntries` + `journalLines` (تحويل `lines` إلى سطور منفصلة)، مع `syncStatus='local'`, `version=1`.
   - تقرأ `partners`, `invoices`, `cheques` → جداولها الجديدة مع `companyId`.
   - تكتب علامة `companySettings{key:'migrated_from_v3', value:'1'}` لمنع التكرار.
3. **التحقق بعد الترحيل**: عدد القيود قبل/بعد، مجموع المدين = مجموع الدائن، عدد الشركاء — تُسجَّل في `auditLogs` كحدث `MIGRATION`.
4. لا تُحذف `supercalc` يدويًا؛ تُترك للرجوع إليها، ويُمكن حذفها في إصدار لاحق بعد تأكيد المستخدم.

---

## 5. تعدد الشركات والصلاحيات

- **مفتاح الجلسة المحلي**: `localStorage['qayd:activeCompany']`. كل استعلام يمر عبر `withCompany(table)` تُحقن `companyId` تلقائيًا.
- **تبديل الشركة** من الشريط العلوي → يعيد تحميل السياق دون إعادة تحميل الصفحة، ويُحدّث كل التقارير.
- **RBAC + Company Scope (مُطبَّق في طبقة الخدمة — لا بالواجهة فقط):**
  - المستخدم قد ينتمي لعدة شركات، بدور **مختلف في كل شركة** (`userCompanies`).
  - الأدوار: `OWNER | ADMIN | ACCOUNTANT | AUDITOR | DATA_ENTRY | VIEWER` (جدول الصلاحيات في `qayd/docs/SECURITY.md`).
  - `can(user, companyId, resource, action)` → يجد العضوية النشطة، يعتمد `permissions` الخاصة بالعضوية إن وُجدت، وإلا افتراضيات الدور. `OWNER` = كل شيء.
  - `assertCompanyAccess()` + `assertCan()` يُستدعيان في بداية **كل دالة خدمة** (`postBusinessTransaction`, `reverseEntry`, `voidEntry`, `getAccountBalance`, `trialBalance`, `auditSince`) — لا يكفي إخفاء الزر.
  - تجاوز النطاق برمي استثناء: `لا صلاحية على هذه الشركة (Company Scope)`.
  - في الوضع المحلي هذا يمنع الخطأ والعبث عبر الواجهة/الكود، لكنه **ليس حماية مشفّرة** لأن المستخدم يملك الجهاز؛ الحماية القانونية/الإدارية الحقيقية تأتي مع B6 (RLS/Cursor rules).
  - `auditLogs.userId` يسجّل من نفّذ العملية دائمًا.

---

## 6. النسخ الاحتياطي التلقائي

**الطبقات الثلاث (مُطبَّقة في `qayd/src/core/backup/backup.service.ts`):**

1. **محلية تلقائية داخل المتصفح**: `backups` (البيانات الوصفية) + `backups_data` (الحمولة الكاملة) في IndexedDB — لا شيء في `localStorage`.
2. **ملف JSON قابل للتنزيل**: `downloadBackup(id)` ينشئ Blob ويحفظ `qayd-<company>-<date>.json`.
3. **سحابية اختيارية لاحقًا** في النسخة المدفوعة (لا يوجد أي طلب شبكة الآن).

**قواعد الإنشاء:** بعد كل عملية مالية مهمة (`AUTO_AFTER_POST`)، يوميًا 02:00 (`AUTO_DAILY`)، وقبل الاستيراد/الترقية/الحذف (`BEFORE_*`)، وقبل الاستعادة (`PRE_RESTORE`).

**الاحتفاظ:** آخر 30 نسخة + أحدث نسخة لكل أسبوع (12 أسبوعًا) + لكل شهر (12 شهرًا) — `applyRetention()`.

**ملف النسخة:** `app`, `schemaVersion`, `createdAt`, `companyId`, `checksum` (SHA-256), `data` (كل الجداول + اسم `settings`).

**الاستعادة الآمنة بالترتيب:** نسخة وقائية → التحقق من `app`/`schemaVersion`/`checksum` → `pauseSync()` → حذف+إدراج كل الجداول في **معاملة واحدة** → سطر `RESTORE` في `auditLogs` → `resumeSync()`. لا تُمس بيانات الشركات الأخرى.

---

## 7. جاهزية المزامنة (بدون تفعيلها الآن)

- `syncQueue` = outbox: كل إنشاء/تعديل/حذف يضيف عملية `pending` داخل نفس المعاملة.
- `syncState` يحفظ `lastPulledAt/lastPushedAt/schemaVersion` لكل شركة.
- `version` + `updatedAt` + `syncStatus` تُعدّ للـconflict resolution (last-write-wins مع حماية `reversalOfId` و`status='posted'`).
- `auditLogs` append-only يبقى المصدر الموثوق للتدقيق حتى لو اختلفت النسخ.
- لا يوجد أي طلب شبكة في هذه المرحلة — البنية فقط.

---

## 8. خطة التنفيذ على مراحل

| المرحلة | العمل | النتيجة |
|---|---|---|
| **B1 — الأساس** | تضمين Dexie، تعريف v4، `migrateFromSupercalc()`، مفتاح الشركة النشطة | بياناتك القديمة تظهر في الهيكل الجديد بلا فقد |
| **B2 — تعدد الشركات** | واجهة إنشاء/تبديل الشركة + `withCompany` + أدوار+toggle | عدة دفاتر منفصلة على جهاز واحد |
| **B3 — القيد المزدوج الموحّد** | `postBusinessTransaction()` داخل `db.transaction` تستخدمها الفواتير/الشيكات/المدفوعات | لا عملية مالية بلا قيد، ذرّيًا |
| **B4 — المدفوعات والأصناف** | `payments` + `paymentAllocations` + `products` + `taxRates` | تسوية فواتير، بنود أصناف، ضريبة قابلة للإعداد |
| **B5 — النسخ التلقائي + التدقيق** | `backups`, `auditLogs`, مؤشر تأخر النسخ | حماية يومية وتتبع كامل |
| **B6 — المزامنة (مستقبلي)** | ربط `syncQueue` بـSupabase/Firebase/VPS + صلاحيات حقيقية | متعدد المستخدمين/أونلاين |

**الترتيب المقترح:** B1 → B2 → B3 قبل أي ميزة جديدة؛ الباقي حسب الحاجة.

---

## 9. ما يتغيّر مقابل الوضع الحالي

| الحالي (v3) | الجديد (v4) |
|---|---|
| `SCStore` مخصص + localStorage | Dexie.js مدمج + IndexedDB `qayd_db` |
| مستخدم واحد، شركة ضمنية | `companyId` صريح في كل سجل + مبدّل شركات |
| `SCJE.post` يكتب في `journal` | `postBusinessTransaction()` داخل معاملة Dexie |
| نسخ JSON يدوي | `backups` + ملف تلقائي (File System Access) |
| لا حقول مزامنة | `version/updatedAt/syncStatus/syncQueue/syncState` |
| 18 أداة تعمل محليًا | تبقى كما هي + تُعاد توجيهها تدريجيًا إلى الطبقة الجديدة |

---

## 10. القرارات المعلّقة (بعد تحديث التصميم)

- **نموذج المشروع:** تُرقيَ القرار من «ملف واحد + Dexie مدمج» إلى **مشروع Vite + TypeScript** (انظر القسم 13). الناتج النهائي يبقى ثابتًا (`dist/`) ويُنشر على GitHub Pages.
- **Dexie:** يعتمد كحزمة npm في `package.json` بدل تضمينه يدويًا.
- **حذف `supercalc`:** لا يُحذف في v4؛ يُترك قابلًا للاستعادة.
- **تفعيل المزامنة:** ليس الآن — البنية جاهزة فقط.
- **صلاحيات محلية:** توجيهية، تُفعّل فعليًا مع B6.

---

## 11. قواعد تصميم الجداول (ملزمة)

| القاعدة | التطبيق في QAYD |
|---|---|
| كل بيانات مالية تنتمي لشركة | `companyId` في **كل** جدول مالي |
| لا تحذف السجلات المالية | `status: 'VOID'` أو قيد عكسي `reversalOfId` |
| كل مستند يولّد قيدًا | `sourceType` + `sourceId` في `journalEntries` |
| الرصيد يُحسب | من `journalLines` — **لا يُخزّن** كرقم نهائي |
| كل تعديل يُوثّق | سطر في `auditLogs` (قبل/بعد) |
| كل تغيير قابل للمزامنة | `updatedAt`, `version`, `syncStatus` |
| كل عملية متعددة الجداول | داخل `db.transaction()` — ذرّيًا |

### حالات وأنواع القيد

`journalEntries.status`: `DRAFT | POSTED | REVERSED | VOID`
`journalEntries.sourceType`: `MANUAL | INVOICE | PAYMENT | CHECK | BANK_RECONCILIATION | TAX_RETURN`

```ts
journalEntries: {
  id, companyId, entryNumber, entryDate, description,
  status, sourceType, sourceId, reversalOfId,
  currency, exchangeRate, updatedAt, version, syncStatus
}
journalLines: {
  id, companyId, journalEntryId, accountId,
  debit, credit, currency, exchangeRate,
  description, lineDate, costCenterId, projectId
}
```

### القاعدة الإلزامية للتوازن

```ts
const debit  = lines.reduce((s, l) => s + Number(l.debit  || 0), 0);
const credit = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
if (debit !== credit) throw new Error('القيد غير متوازن');
```

> تُطبَّق في `assertBalanced()` مع تقريب إلى منزلتين عشريتين لتفادي انحراف الفاصلة العائمة (0.1 + 0.2).

### مثال: فاتورة مبيعات 1,000 + 15%

| الحساب | مدين | دائن |
|---|---:|---:|
| المدينون (1300) | 1,150 | 0 |
| إيرادات المبيعات (4100) | 0 | 1,000 |
| ضريبة المخرجات (2200) | 0 | 150 |

عند التحصيل:

| الحساب | مدين | دائن |
|---|---:|---:|
| البنك/الصندوق (1200) | 1,150 | 0 |
| المدينون (1300) | 0 | 1,150 |

---

## 12. نمط Strangler (الترحيل التدريجي)

**لا تُعاد كتابة التطبيق دفعة واحدة.** تُنقل صفحة/وحدة واحدة في كل مرة من `index.html` القديم إلى وحدات `src/`:

1. المشروع الجديد `qayd/` بـVite + TypeScript.
2. صورة من `index.html` الحالي في `src/legacy/` (مرجع فقط).
3. `src/core/db/dexie.ts` + `schema.ts` + `migrations.ts`.
4. **الدفعة الأولى:** دليل الحسابات → القيود → التقارير.
5. **الدفعة الثانية:** الشركاء → الفواتير → الشيكات.
6. **الدفعة الثالثة:** VAT → التسوية البنكية → بقية الأدوات.
7. **لا يُحذف الكود القديم إلا بعد اجتياز الاختبارات.**

### هيكل المشروع المعتمد

```
qayd/
├─ index.html            # Shell جديد (Vite)
├─ package.json
├─ vite.config.ts
├─ tsconfig.json
├─ .env.example
├─ public/
│  ├─ manifest.webmanifest
│  ├─ icons/
│  └─ sw.js
├─ src/
│  ├─ main.ts
│  ├─ app/        router.ts · layout.ts · theme.ts
│  ├─ legacy/     index.html (النسخة الحالية، للرجوع)
│  ├─ core/
│  │  ├─ db/            dexie.ts · schema.ts · migrations.ts · repositories/
│  │  ├─ ledger/        journal.service.ts · account.service.ts · balance.service.ts · validation.ts
│  │  ├─ tax/           vat.service.ts
│  │  ├─ reports/       trial-balance · income-statement · balance-sheet · cash-flow
│  │  ├─ security/      auth.service.ts · permissions.ts · audit.service.ts
│  │  ├─ backup/        backup.service.ts · restore.service.ts · scheduler.ts
│  │  └─ sync/          queue.ts · sync.engine.ts · conflict.resolver.ts
│  ├─ modules/          dashboard · companies · accounts · journal · invoices · payments ·
│  │                    checks · banking · partners · products · inventory · tax · reports
│  ├─ ui/               components/ · forms/ · tables/
│  └─ utils/
├─ tests/         ledger.test.ts · invoice.test.ts · vat.test.ts · reports.test.ts
└─ docs/          ACCOUNTING.md · DATABASE.md · SECURITY.md · CHANGELOG.md
```

---

## 13. ترتيب التنفيذ الفعلي (حالة العمل)

- [x] توثيق التصميم (README + CHANGELOG + ARCHITECTURE) — commit `3137b43`
- [x] إنشاء مشروع Vite + TypeScript داخل المستودع الحالي في `accounting-tools\qayd\` (Vite 6.4.6 / TS 5.x / Dexie 4)
- [x] نسخ `calculator.html` إلى `src/legacy/index.html`
- [x] `db/schema.ts` + `db/dexie.ts` + `db/migrations.ts` (ترحيل supercalc بلا حذف)
- [x] `ledger/validation.ts` + `journal.service.ts` + `balance.service.ts` + `audit.service.ts` + `sync/queue.ts`
- [x] اختبارات `ledger.test.ts`: **7/7 ناجحة** (توازن، عائم، رفض سطر مزدوج، فاتورة 15%، عكس، منع تكرار العكس، ميزان المراجعة) + `npm run build` ناجح
- [x] RBAC + Company Scope في طبقة الخدمة: `permissions.ts`, `auth.service.ts`، وربطها بكل خدمات القيد/الأرصدة/التدقيق — **21/21 اختبار ناجح**
- [x] النسخ الاحتياطي ثلاثي الطبقات + الجدولة + الاحتفاظ + الاستعادة الآمنة — **8 اختبارات إضافية (المجموع 29/29 ناجح)**
- [ ] نقل أول واجهة (دليل الحسابات/القيود) إلى `src/modules/`
- [ ] الباقي حسب الدفعات في القسم 12

