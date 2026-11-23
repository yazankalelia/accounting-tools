# الأمان: RBAC + Company Scope

## المبدأ
- المستخدم قد ينتمي لأكثر من شركة، **بدور مختلف في كل شركة**.
- `companyId` يُفرض في طبقة الخدمة والاستعلامات، ولا يكفي إخفاء الأزرار في الواجهة.
- `can()` يقرر، و`assertCan()` / `assertCompanyAccess()` يمنعان قبل أي كتابة أو قراءة.

## جدول الأدوار (تنفيذه في `src/core/security/permissions.ts`)

| الدور | الصلاحيات |
|---|---|
| `OWNER` | كل شيء، إدارة المستخدمين، حذف/إلغاء الشركة |
| `ADMIN` | الإعدادات والمستخدمون، كل العمليات المالية، **لا حذف نهائي للشركة** |
| `ACCOUNTANT` | قيود (إنشاء/تحرير مسودة/ترحيل/عكس)، فواتير، مدفوعات، شيكات، تقارير + تصدير |
| `AUDITOR` | عرض فقط + تصدير + سجل التدقيق |
| `DATA_ENTRY` | إدخال مسودات فقط (لا ترحيل، لا تقارير) |
| `VIEWER` | عرض محدود |

## دالة القرار

```ts
can(user, companyId, resource, action): boolean
```
1. تبحث عن عضوية `ACTIVE` مطابقة لـ`companyId` — إن لم توجد → `false`.
2. `OWNER` → `true` مباشرة.
3. إن كانت `membership.permissions[resource]` موجودة فهي **تتجاوز** افتراض الدور، وإلا يُستخدم `ROLE_PERMISSIONS[role]`.

## نقاط الفرض في الخدمة

| الدالة | الفحص |
|---|---|
| `postBusinessTransaction` | `journal:create` للمسودة، `journal:post` للترحيل |
| `reverseEntry` | `journal:reverse` |
| `voidEntry` | `journal:void` |
| `getAccountBalance` | `journal:view` |
| `trialBalance` | `reports:view` |
| `auditSince` | `audit:view` |

كلها تسبقها `assertCompanyAccess(user, companyId)`.

## الحدود الحالية
- الوضع المحلي: المستخدم يملك المتصفح والملف، لذا هذه طبقة **منطق وضبط داخلي** وليست حماية تشفيرية.
- الوضع متعدد المستخدمين (B6): تُلزم القواعد نفسها على الخادم عبر Supabase RLS أو Firestore rules — لا يُثق بالواجهة أبدًا.
- سجل التدقيق `auditLogs` append-only ويُسجّل `userId` من نفّذ العملية.
