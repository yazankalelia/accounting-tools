# النسخ الاحتياطي — التصميم والتنفيذ بثلاث طبقات

## الطبقات
1. **IndexedDB محلية تلقائية** — `backups` للوصف + `backups_data` للحمولة. لا `localStorage` للبيانات الضخمة.
2. **ملف JSON قابل للتنزيل** — `downloadBackup(id)`.
3. **سحابة اختيارية لاحقًا** (النسخة المدفوعة) — لم تُنفَّذ؛ لا شبكة الآن.

## متى تُنشأ نسخة
| الحدث | النوع |
|---|---|
| بعد ترحيل/عكس/إبطال قيد | `AUTO_AFTER_POST` |
| يوميًا 02:00 لكل شركة | `AUTO_DAILY` |
| قبل استيراد | `BEFORE_IMPORT` |
| قبل ترقية | `BEFORE_UPGRADE` |
| قبل حذف مهم | `BEFORE_DELETE` |
| قبل استعادة | `PRE_RESTORE` |
| بناءً على طلب المستخدم | `MANUAL` |

`backupBefore(companyId, type)` يوفّر الأنواع الوقائية الثلاثة.

## شكل الملف
```json
{
  "app": "QAYD",
  "schemaVersion": 4,
  "createdAt": "2026-11-23T18:00:00Z",
  "companyId": "company_1",
  "checksum": "sha256...",
  "data": { "companies": [], "accounts": [], "journalEntries": [], "journalLines": [], "partners": [], "invoices": [], "invoiceLines": [], "payments": [], "paymentAllocations": [], "checks": [], "checkEvents": [], "banks": [], "bankTransactions": [], "taxRates": [], "auditLogs": [], "settings": [] }
}
```
`checksum` = SHA-256 لـJSON الكامل قبل إضافة حقل `checksum`.

## الاحتفاظ
`applyRetention(companyId)` يحتفظ بـ:
- آخر **30** نسخة،
- أحدث نسخة لكل أسبوع لـ**12 أسبوعًا**،
- أحدث نسخة لكل شهر لـ**12 شهرًا**،
ويحذف الباقي من `backups` و`backups_data` معًا.

## الجدولة
`scheduleBackups()` يحسب الموعد التالي 02:00 ويُعيد الجدولة بعد كل تنفيذ؛ `stopBackups()` يوقفه (للاختبارات/إغلاق التطبيق).

## الاستعادة الآمنة
1. نسخة وقائية `PRE_RESTORE` من الوضع الحالي.
2. `verifyBackup()`: اسم التطبيق، `schemaVersion <= 4`، تطابق `checksum`.
3. `pauseSync()`.
4. حذف + إدراج كل جداول الشركة داخل `db.transaction()` واحدة — لا تُمس الشركات الأخرى.
5. سطر تدقيق `RESTORE` في `auditLogs`.
6. `resumeSync()`.

## سلوك الرفض
Any tampering → `Checksum غير مطابق — النسخة تالفة أو معدّلة`.
`schemaVersion` أحدث → رفض صريح بدل محاولة استعادة غير متوافقة.
