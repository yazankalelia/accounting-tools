import { db } from '../db/schema';
import { newId } from '../../utils/id';
import { sha256, byteLength } from '../../utils/crypto';
import { writeAudit } from '../security/audit.service';
import { pauseSync, resumeSync } from '../sync/control';
import { getCurrentUser } from '../security/auth.service';
import { assertCan, type CurrentUser } from '../security/permissions';

export const SCHEMA_VERSION = 4;

export type BackupType =
  | 'AUTO_AFTER_POST'
  | 'AUTO_DAILY'
  | 'WEEKLY'
  | 'MONTHLY'
  | 'BEFORE_IMPORT'
  | 'BEFORE_UPGRADE'
  | 'BEFORE_DELETE'
  | 'MANUAL'
  | 'PRE_RESTORE';

/**
 * الجداول المؤثرة في النسخة الكاملة. `syncQueue` حالة تشغيل مؤقتة لا تُنسخ.
 * `users` و`userCompanies` و`backups` تُعامل بطريقة خاصة (انظر createBackup/restoreBackup).
 */
export const BACKUP_TABLES = [
  'companies',
  'companySettings',
  'users',
  'userCompanies',
  'fiscalYears',
  'fiscalPeriods',
  'accounts',
  'journalEntries',
  'journalLines',
  'partners',
  'products',
  'invoices',
  'invoiceLines',
  'payments',
  'paymentAllocations',
  'checks',
  'checkEvents',
  'banks',
  'bankTransactions',
  'taxRates',
  'taxReturns',
  'warehouses',
  'inventoryItems',
  'inventoryMovements',
  'attachments',
  'auditLogs',
  'backups',
] as const;

/** لا تُخزَّن أسرار كلمة المرور في النسخة ولا في قوائم المستخدمين. */
const SECRET_KEYS = ['password', 'passwordHash', 'password_hash', 'hash', 'secret', 'pin', 'token'];

function stripSecrets<T extends Record<string, any>>(row: T): T {
  const clean: Record<string, any> = { ...row };
  for (const key of SECRET_KEYS) delete clean[key];
  return clean as T;
}

export interface BackupPayload {
  app: 'QAYD';
  schemaVersion: number;
  createdAt: string;
  companyId: string;
  checksum: string;
  data: Record<string, unknown[]>;
}

/** نسخة كاملة داخل IndexedDB + بياناتها في جدول منفصل (لا localStorage). */
export async function createBackup(companyId: string, type: BackupType = 'MANUAL', user?: CurrentUser): Promise<string> {
  const actor = user ?? getCurrentUser();
  // الرفض افتراضيًا: لا نسخة دون صلاحية صريحة (VIEWER ممنوع).
  assertCan(actor, companyId, 'backup', 'create_backup');

  const data: Record<string, unknown[]> = {};
  for (const table of BACKUP_TABLES) {
    if (table === 'companies') {
      data[table] = await db.companies.where('id').equals(companyId).toArray();
    } else if (table === 'users') {
      // المستخدمون جدول عام: نأخذ فقط أعضاء هذه الشركة ونجرّد الأسرار.
      const memberships = await db.userCompanies.where('companyId').equals(companyId).toArray();
      const users = await db.users.bulkGet(memberships.map((m) => m.userId));
      data[table] = users.filter(Boolean).map((u) => stripSecrets(u as Record<string, any>));
    } else {
      data[table] = await db.table(table).where('companyId').equals(companyId).toArray();
    }
  }
  data.settings = data.companySettings; // الاسم في ملف JSON كما في المواصفة

  const draft = {
    app: 'QAYD' as const,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    companyId,
    data,
  };
  const checksum = await sha256(JSON.stringify(draft));
  const payload: BackupPayload = { ...draft, checksum };
  const serialized = JSON.stringify(payload);
  const id = newId();

  await db.transaction('rw', db.backups, db.backups_data, async () => {
    await db.backups.add({
      id,
      companyId,
      createdAt: payload.createdAt,
      type,
      sizeBytes: byteLength(serialized),
      status: 'SUCCESS',
      storageLocation: 'INDEXEDDB',
      checksum,
      schemaVersion: SCHEMA_VERSION,
    });
    await db.backups_data.add({ id, payload });
  });
  if (type.startsWith('AUTO_')) await applyRetention(companyId);
  return id;
}

/** تُستدعى قبل استيراد/ترقية/حذف مهم. */
export function backupBefore(
  companyId: string,
  type: Extract<BackupType, 'BEFORE_IMPORT' | 'BEFORE_UPGRADE' | 'BEFORE_DELETE'>,
  user?: CurrentUser,
): Promise<string> {
  return createBackup(companyId, type, user);
}

export async function listBackups(companyId: string): Promise<any[]> {
  return db.backups.where('companyId').equals(companyId).reverse().sortBy('createdAt');
}

export async function verifyBackup(payload: BackupPayload): Promise<void> {
  if (payload.app !== 'QAYD') throw new Error('ملف النسخ الاحتياطي ليس من قيد');
  if (typeof payload.schemaVersion !== 'number' || payload.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`إصدار النسخة ${payload.schemaVersion} أحدث من التطبيق (${SCHEMA_VERSION})`);
  }
  if (!payload.checksum || !payload.data || typeof payload.companyId !== 'string') {
    throw new Error('بنية النسخة غير صحيحة');
  }
  const { checksum, ...rest } = payload;
  const actual = await sha256(JSON.stringify(rest));
  if (actual !== checksum) throw new Error('Checksum غير مطابق — النسخة تالفة أو معدّلة');
}

function isoWeekKey(iso: string): string {
  const d = new Date(iso);
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 3 - (d.getUTCDay() || 7)));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${week}`;
}

function monthKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
}

/**
 * الاحتفاظ: آخر 30 نسخة + أحدث نسخة لكل أسبوع (12 أسبوعًا) + لكل شهر (12 شهرًا).
 */
export async function applyRetention(companyId: string): Promise<{ kept: number; deleted: number }> {
  const all = await listBackups(companyId);
  const sorted = [...all].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const keep = new Set<string>();

  for (const b of sorted.slice(0, 30)) keep.add(b.id);

  const weeks = new Set<string>();
  for (const b of sorted) {
    const k = isoWeekKey(b.createdAt);
    if (!weeks.has(k)) { weeks.add(k); keep.add(b.id); }
    if (weeks.size >= 12) break;
  }
  const months = new Set<string>();
  for (const b of sorted) {
    const k = monthKey(b.createdAt);
    if (!months.has(k)) { months.add(k); keep.add(b.id); }
    if (months.size >= 12) break;
  }

  const doomed = all.filter((b) => !keep.has(b.id));
  if (doomed.length) {
    await db.transaction('rw', db.backups, db.backups_data, async () => {
      await db.backups.bulkDelete(doomed.map((b) => b.id));
      await db.backups_data.bulkDelete(doomed.map((b) => b.id));
    });
  }
  return { kept: keep.size, deleted: doomed.length };
}

/** تنزيل ملف JSON قابل للاستعادة على جهاز آخر. */
export async function downloadBackup(companyId: string, backupId: string, user?: CurrentUser): Promise<void> {
  const actor = user ?? getCurrentUser();
  assertCan(actor, companyId, 'backup', 'create_backup');
  const meta = await db.backups.get(backupId);
  const row = await db.backups_data.get(backupId);
  if (!meta || meta.companyId !== companyId || !row) {
    throw new Error('النسخة غير موجودة أو لا تنتمي لهذه الشركة');
  }
  if (typeof document === 'undefined') throw new Error('التنزيل متاح في المتصفح فقط');
  const blob = new Blob([JSON.stringify(row.payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `qayd-${meta.companyId}-${String(meta.createdAt).slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** استعادة آمنة: فحص صلاحية → نسخة وقائية → checksum → معاملة واحدة → تدقيق. */
export async function restoreBackup(companyId: string, backupId: string, user?: CurrentUser): Promise<void> {
  const actor = user ?? getCurrentUser();
  // العملية تدميرية محتملة: الرفض هو الافتراضي، وتُفحص الصلاحية عند كل عملية حساسة.
  assertCan(actor, companyId, 'backup', 'restore');

  const meta = await db.backups.get(backupId);
  if (!meta || meta.companyId !== companyId) {
    throw new Error('النسخة الاحتياطية غير موجودة أو لا تنتمي لهذه الشركة');
  }
  const row = await db.backups_data.get(backupId);
  if (!row) throw new Error('النسخة الاحتياطية غير موجودة');
  const payload = row.payload as BackupPayload;
  if (payload.companyId !== companyId) {
    throw new Error('النسخة الاحتياطية غير موجودة أو لا تنتمي لهذه الشركة');
  }

  await verifyBackup(payload);
  await createBackup(companyId, 'PRE_RESTORE', actor); // قبل أي تعديل
  pauseSync();

  // المستخدمون وعضويتهم وسجل النسخ الحالي لا يُستبدلون بأعمى: نضيف المفقود فقط.
  const special = new Set<string>(['companies', 'users', 'userCompanies', 'backups']);
  const replaceTables = BACKUP_TABLES.filter((t) => !special.has(t));
  try {
    const scope = [...new Set<string>(['companies', 'users', 'userCompanies', 'auditLogs', ...replaceTables])];
    await db.transaction(
      'rw',
      scope.map((name) => db.table(name)),
      async () => {
        await db.companies.where('id').equals(companyId).delete();
        await db.companies.bulkPut((payload.data.companies ?? []).filter((c: any) => c.id === companyId) as any[]);

        for (const incoming of (payload.data.users ?? []) as any[]) {
          if (await db.users.get(incoming.id)) continue; // احتفظ بالمستخدم الحالي
          await db.users.add(stripSecrets(incoming));
        }
        const memberships = ((payload.data.userCompanies ?? []) as any[])
          .filter((m) => m.companyId === companyId);
        for (const m of memberships) {
          if (m.userId === actor.id) continue; // احتفظ بعضوية المستخدم الحالي
          if (await db.userCompanies.get(m.id)) continue;
          const duplicate = await db.userCompanies.where('[userId+companyId]').equals([m.userId, companyId]).first();
          if (duplicate) continue;
          await db.userCompanies.add(m);
        }

        for (const table of replaceTables) {
          const rows = table === 'companySettings'
            ? (payload.data.companySettings ?? payload.data.settings ?? [])
            : (payload.data[table] ?? []);
          await db.table(table).where('companyId').equals(companyId).delete();
          if (rows.length) await db.table(table).bulkPut(rows as any[]);
        }
        await writeAudit(
          companyId, 'companies', companyId, 'RESTORE',
          undefined, { backupId, checksum: payload.checksum, schemaVersion: payload.schemaVersion },
          actor.id,
        );
      },
    );
  } finally {
    resumeSync();
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** نسخة يومية مجدولة عند 02:00 لكل شركة، ثم إعادة جدولة. */
export function scheduleBackups(): void {
  stopBackups();
  const now = new Date();
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  timer = setTimeout(async () => {
    try {
      const companies = await db.companies.toArray();
      for (const c of companies) {
        await createBackup(c.id, 'AUTO_DAILY');
        await applyRetention(c.id);
      }
    } finally {
      scheduleBackups();
    }
  }, next.getTime() - now.getTime());
}

export function stopBackups(): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
}
