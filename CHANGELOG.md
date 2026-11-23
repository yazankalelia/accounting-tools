# سجل التغييرات الكامل — قيد / QAYD (A → Z)
آخر تحديث: 2026-11-23 · المستودع: `yazankalelia/accounting-tools` · الفرع `main`

هذا الملف هو **توثيق محفوظ** لكل ما أُنجز، بما في ذلك القرارات والاختبارات والنسخ الاحتياطية والحالات الملغاة. دليل الاستخدام الحالي في `README.md`.

---

## المرحلة 0 — الأساس (قبل 13 نوفمبر 2026)

من سجل Git نفسه:
- `f37ad69` — إعادة العلامة التجارية إلى «قيد — منظومة المحاسبة الاحترافية / QAYD — Professional Accounting System» مع الشعارات.
- `8d4f8bf`, `ed03158` — شعارات عالية الدقة PNG وfavicon.
- `55af357`, `e255f60` — ترجمة كاملة عربي/إنجليزي + إصلاحات محاسبية وملاحظات المراجعة.
- `4427197` — تسمية القيمة المتبقية (residual/salvage value).
- `6f9c265` — تحديث الشعارات والـfavicon.
- التطبيق قبل تدخلنا كان يحتوي 14 أداة، قيودًا، تقارير طباعة/PDF/CSV (المرحلة 6)، استيراد CSV بنكي، IFRS 9، نسخًا احتياطيًا، وصندوق ملاحظات يرسل إلى Google Sheets.

## المرحلة 1 — تجربة السحابة ثم الإلغاء (13–14 نوفمبر 2026)

### ما بُني فعليًا (ثم أُلغي لاحقًا بقرار منك)
- مشروع Firebase **`qayd-ce3d1`** (الاسم QAYD، خطة Spark)، Firestore `(default)` في المنطقة `me-central1` (الدوحة) بوضع Production.
- قواعد `firestore.rules` (رفض افتراضي + عزل لكل شركة + أدوار owner/accountant/reviewer/viewer + تشترط `email_verified == true` + سجل تدقيق append-only + منع حذفه) — نُشرت فعليًا.
- مصادقة Email/Password + نطاق `yazankalelia.github.io` مضاف + تطبيق ويب `QAYD Web`.
- طبقة سحابية **بدون أي SDK خارجي**: Identity Toolkit REST + Firestore REST (متوافقة مع CSP، ملف واحد).
- نموذج البيانات: `users/{uid}`، `companies/{cid}`، `companies/{cid}/members/{uid}`، `invites/{email}`، `kv`، `journal`، `coa`، `sessions`، `counters`، `audit`.
- ترقيم قيود ذري عبر Firestore `:commit` على `counters/je-YYYY-MM`.
- اختبار شامل بحساب مؤقت (mail.tm): إنشاء حساب → تحقق → شركة → ترقيم 1 ثم 2 → kv/journal/audit → قراءة غير مصادقة = 403 → حذف audit = 403. ثم **حُذفت كل بيانات الاختبار** (المجموعات + المستخدم).
- حسابك الرسمي أُنشئ: `yazan2017kalelia@gmail.com`، UID `LAETh2ElnDWhezkbOsXrhyUZSJB2`، وتم التحقق من بريدك بنفسك؛ شركة «قيد» `cmwfc1zewf6rw` (JOD، 24 حسابًا، دور `owner`). كلمة المرور المؤقتة `Qayd-Kalelia-7391!x` (ينصح تغييرها).
- نشر Firebase Hosting على `qayd-ce3d1.web.app`، ثم **عُطّل** لاحقًا (`hosting:disable`) — الآن يعيد 404.
- ميزة «اسم مستخدم/Username» بُنيت ثم **حُذفت** بطلبك قبل أي نشر.

### ما تبقّى من المرحلة 1 (لم يُحذف، لأنك لم تطلبه)
- مشروع Firebase `qayd-ce3d1` ما زال موجودًا وفيه بيانات الحساب والشركة (يمكن حذفه متى شئت).
- مشروع `qayd-app` الإضافي غير المستخدم ما زال موجودًا.
- أداة `firebase-tools` مثبتة عالميًا وجلسة الدخول محفوظة محليًا (`~\.config\configstore\firebase-tools.json`).
- نسخة من كل ما حُذف محفوظة في `C:\Users\Yazan\.local\share\opencode\` (انظر قسم النسخ).

## المرحلة 2 — العودة إلى الوضع المحلي (14 نوفمبر)

بناءً على قرارك الصريح «إزالة Firebase من التطبيق كليًا»:
- `12579cd` — **Revert to local-only build**: استُعيدت النسخة السابقة للسحابة (`bak-calculator-precloud.html`)، وحُذفت `FIREBASE_SETUP.md` و`firestore.rules` من المستودع، ونُشر التحديث على GitHub Pages.
- النتيجة: لا حسابات، لا تسجيل دخول، لا طلبات شبكة مالية — التطبيق محلي 100%.

## المرحلة 3 — الأيقونات والمفضلة (14 نوفمبر)

- `0c076a2` — **Redesigned nav icons**:
  - استُبدلت 16 رمز يونيكود غير متناسق (`▣ ⇄ ¤ ض ...`) بأيقونات SVG خطية موحدة (stroke 1.7، مربع 24، 20px ثابت) في القائمة الجانبية وعناوين الصفحات الـ16.
  - مجموعة «الأكثر استخدامًا» أعلى القائمة: تُحسب من تكرار زياراتك وتُحفظ في `localStorage.qayd:favs` (أعلى 4 صفحات).
  - إدخالا i18n: «الأكثر استخدامًا / Most used».
  - مصدر التغيير قابل لإعادة التوليد: `.local\share\opencode\patch_icons2.py`.

## المرحلة 4 — الجوال وتأثير الضغط (14 نوفمبر)

- `2e344a4` — **Mobile bottom navigation + press feedback**:
  - شريط سفلي ثابت للهاتف (≤768px): حاسبة · VAT · أسعار العملات · السجل · «المزيد» (يفتح درج الأدوات الـ16).
  - حالة نشطة متزامنة مع التنقّل من أي مصدر، `aria-expanded` على زر «المزيد»، مساحات آمنة للحواف، نقل زر «ملاحظة» فوق الشريط.
  - أُزيل زر «☰ الأدوات» المكرر من الشريط العلوي.
  - تأثير ضغط موحّن: `.bn-item .92`، `.ck` و`.calc-chip` `.96`، `.btn` `.97`، `.nav-item` `.985` مع transition 0.13s.
  - `@media (prefers-reduced-motion: reduce)` يعطّل الحركة لمن يفضل ذلك.

## المرحلة 5 — المحاسبة التجارية (14–23 نوفمبر)

- `9cf1d58` — **Trade: partners, invoices, cheques, CSV import, VAT quarterly**:
  - قاعدة البيانات المحلية رُفعت إلى **IndexedDB v3** مع متاجر `partners` و`invoices` و`cheques` (ترحيل v1/v2 → v3 دون فقد البيانات).
  - صفحة «الفواتير والدفاتر»: الشركاء (نوع، هاتف، رقم ضريبي، رصيد افتتاحي واتجاه)، كشف حساب متحرك + طباعة، فواتير بيع/شراء ببنود متعددة وضريبة 16/10/5/0% وترقيم `F-YYYY-0001`، حفظ مسودة أو ترحيل قيد تلقائي (Dr 1300 / Cr إيراد + 2200 للمبيعات؛ Dr مصروف + 2210 / Cr 2100 للمشتريات)، إلغاء ترحيل بقيد معاكس، طباعة A4 بترويسة الشركة، تصدير CSV.
  - استيراد الشركاء من CSV مع قالب جاهز وعدّاد مُستورَد/متخطى.
  - صفحة «الشيكات»: وارد/صادر، جهة من دفتر الشركاء، مصرف، رقم، استحقاق، مبلغ؛ تحصيل (Dr 1200 / Cr 1300) أو صرف (Dr 2100 / Cr 1200)، مرتجع/ملغى، إلغاء تسوية بقيد معاكس، فلاتر الاستحقاق، تمييز المتأخر، تصدير CSV.
  - «ملخص الضريبة ربع السنوي» في صفحة VAT: من القيود المرحّلة (2200/2210) مع جدول شهري وصافي مستحق.
  - إصلاح مهم: ربط `window.toastSafe` بدالة `toast` لمنع تجميد الواجهة عند التنبيهات.

## المرحلة 6 — المهارات (Skills)

- ثبّتُّ 14 مهارة Firebase من `npx skills add firebase/agent-skills` بطلبك (13 نوفمبر).
- بطلبك لاحقًا «تحقق من أن كل المهارات معطلة» → نُقلت كلها (14 من `.config\opencode\skills` + 2 من `.agents\skills`) إلى العزل:
  `C:\Users\Yazan\.local\share\opencode\skills-disabled\` — قابلة للاستعادة، ولا تُحمّل في أي جلسة حالية.
- إعدادات `opencode.json` نفسها كانت تحظر `skill`/`browser`/`websearch`/توليد الصور قبل ذلك.

---

## سجل التحقق (Verification)

| الفحص | النتيجة |
|---|---|
| `node --check` على كل سكربتات الصفحة (`verify_patch.py`) | `rc=0` دائمًا |
| فحص الإقلاع headless (Edge) | 18 صفحة، صفر أخطاء كونسول، بلا شاشة دخول |
| فاتورة مبيعات: 3×80 + 16% | `F-2026-0001` → قيد Dr 1300 278.40 / Cr 4100 240.00 / Cr 2200 38.40 ✅ |
| فاتورة مبيعات: 2×50 + 16% | Dr 1300 116 / Cr 4100 100 / Cr 2200 16 ✅ |
| شيك وارد 5,000 → تحصيل | `JE-202611-0001`: Dr 1200 5,000 / Cr 1300 5,000 ✅ |
| زر الترحيل معطّل حتى اكتمال الشريك + الحساب | ✅ |
| ملخص VAT ربع سنوي | 3 صفوف شهرية + إجماليات بلا أخطاء ✅ |
| الهاتف 390×844 | الشريط السفلي + فتح الدرج + الضغط scale(0.92) ✅ |
| الموقع الحي `yazankalelia.github.io/accounting-tools/` | HTTP 200 ويحوي `page-trade` و`page-cheques` و`V_qCompute` ✅ |
| `qayd-ce3d1.web.app` | 404 (معطّل) ✅ |

## النسخ الاحتياطية المحفوظة

المجلد: `C:\Users\Yazan\.local\share\opencode\`

| الملف | ماذا يمثل |
|---|---|
| `bak-calculator-before-icons.html` | قبل تغيير الأيقونات |
| `bak-calculator-before-trade.html` | قبل الفواتير/الشركاء |
| `bak-calculator-precloud.html` | النسخة المحلية الأصلية (أساس الإرجاع) |
| `bak-calculator-precloud2.html` | نسخة طبقة السحابة بإعدادات فارغة |
| `bak-calculator-preusername.html` | قبل ميزة اسم المستخدم |
| `bak-calculator-firebasebuild.html` | آخر نسخة سحابية + اسم مستخدم |
| `firebase-keep\` | قواعد Firestore + دليل الإعداد + إعدادات النشر + نسخة الاستضافة |
| `skills-disabled\` | كل مهارات Firebase المعزولة |

## القرارات والمنطق

1. **لا SDK خارجي** في الوضع السحابي: CSP صارم + ملف واحد → REST مباشر.
2. **الوضع المحلي** هو الحالي بقرار صريح منك؛ السحابة أُلغيت كليًا من التطبيق مع بقاء بيانات المشروع في Firebase (لم تُحذف).
3. **القواعد بدل المفتاح**: `apiKey` عام، الحماية كانت في `firestore.rules` (الآن غير مستخدمة).
4. **append-only للسجل التدقيقي**: العكس ينشئ قيدًا جديدًا ولا يمس الأصل.
5. **CSV لا xlsx**:Zero-dependency & CSP — قالب CSV يكفي؛ SheetJS خيار مستقبلي.
6. **الفواتير لا تُحذف بعد الترحيل**: تُعكس فقط.

## الحالة الحالية والخطوة التالية

- **حالي**: تطبيق محلي كامل 18 أداة + فواتير/شركاء/شيكات، منشور على GitHub Pages، commit `9cf1d58`.
- **المرحلة ب (لم تبدأ)**: نظام متعدد المستخدمين/أونلاين — الخيارات: Supabase (موصى به) / Firebase / خادم خاص. تتطلب قاعدة مركزية + مصادقة + صلاحيات + مزامنة (تقدير 1–3 أيام عمل).
- **إضافات معلّقة**: مكتبة SheetJS لاستيراد `.xlsx`، ربط Fawtara، إقفال سنة آلي، نسخ احتياطي مجدول.

## ملخص Git (آخر 6 commits)

```
9cf1d58 Trade: partners, invoices with auto journal entries, cheques, CSV import, VAT quarterly summary
2e344a4 Add mobile bottom navigation and pressed-state feedback with reduced-motion support
0c076a2 Redesigned nav icons: unified line SVGs with usage-based favorites group
12579cd Revert to local-only build: remove Firebase cloud layer and account feature
d0488ae Cloud mode: Firebase auth, roles, Firestore backend, security rules
6f9c265 Update brand logos and favicon (QAYD icons)
```
