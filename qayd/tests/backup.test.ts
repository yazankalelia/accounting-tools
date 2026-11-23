import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/core/db/schema';
import {
  createBackup, listBackups, applyRetention, verifyBackup,
  restoreBackup, backupBefore, SCHEMA_VERSION, type BackupPayload,
} from '../src/core/backup/backup.service';
import { postBusinessTransaction } from '../src/core/ledger/journal.service';
import { getAccountBalance } from '../src/core/ledger/balance.service';
import { isSyncPaused } from '../src/core/sync/control';

const CID = 'company_backup_test';

beforeEach(async () => {
  await db.delete();
  await db.open();
  const now = Date.now();
  await db.companies.put({
    id: CID, name: 'شركة اختبار', slug: 'test', currency: 'JOD',
    status: 'ACTIVE', createdAt: now, updatedAt: now,
  });
});

async function post(amount: number): Promise<string> {
  return postBusinessTransaction({
    companyId: CID,
    entryDate: '2026-11-23',
    description: `قيد ${amount}`,
    lines: [{ accountId: '1100', debit: amount }, { accountId: '4100', credit: amount }],
  });
}

describe('النسخ الاحتياطي التلقائي', () => {
  it('ينشئ نسخة بعد كل عملية مالية مع checksum وschemaVersion', async () => {
    await post(100);
    const rows = await listBackups(CID);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('AUTO_AFTER_POST');
    expect(rows[0].schemaVersion).toBe(SCHEMA_VERSION);
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].storageLocation).toBe('INDEXEDDB');
    expect(rows[0].sizeBytes).toBeGreaterThan(0);

    const raw = await db.backups_data.get(rows[0].id);
    const payload = raw!.payload as BackupPayload;
    expect(payload.app).toBe('QAYD');
    expect(payload.companyId).toBe(CID);
    expect(payload.data.journalEntries).toHaveLength(1);
    expect(payload.data.journalLines).toHaveLength(2);
    expect(payload.data.settings).toBeDefined();
    await expect(verifyBackup(payload)).resolves.toBeUndefined();
  });

  it('لا يخزّن الحمولة في localStorage', async () => {
    const id = await createBackup(CID, 'MANUAL');
    const raw = await db.backups_data.get(id);
    expect(raw?.payload).toBeDefined();
    expect(typeof localStorage === 'undefined' || localStorage.getItem(id) === null).toBe(true);
  });

  it('يرفض نسخة معدّلة (checksum غير مطابق)', async () => {
    const id = await createBackup(CID, 'MANUAL');
    const raw = await db.backups_data.get(id);
    const tampered = { ...(raw!.payload as BackupPayload), data: { ...(raw!.payload as BackupPayload).data, accounts: [{ id: 'hacked' }] } };
    await expect(verifyBackup(tampered)).rejects.toThrow('Checksum غير مطابق');
  });

  it('يرفض نسخة من إصدار أحدث', async () => {
    const id = await createBackup(CID, 'MANUAL');
    const raw = await db.backups_data.get(id);
    await expect(verifyBackup({ ...(raw!.payload as BackupPayload), schemaVersion: 99 })).rejects.toThrow('أحدث من التطبيق');
  });

  it('يحتفظ بآخر 30 + أسبوعية 12 + شهرية 12 ويحذف الباقي', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = await createBackup(CID, 'AUTO_DAILY');
      ids.push(id);
      await db.backups.update(id, { createdAt: new Date(Date.now() - i * 4 * 86400000).toISOString() });
    }
    const r = await applyRetention(CID);
    expect(r.deleted).toBeGreaterThan(0);
    expect(r.kept).toBeLessThanOrEqual(54);
    expect(await db.backups.count()).toBe(r.kept);
    expect(await db.backups_data.count()).toBe(r.kept);
    expect(await db.backups.get(ids[99])).toBeUndefined(); // أقدم نسخة حُذفت
    expect(await db.backups.get(ids[0])).toBeDefined();    // أحدث نسخة بقيت
  });

  it('ينشئ نسخة وقائية قبل الاستيراد/الترقية/الحذف', async () => {
    await backupBefore(CID, 'BEFORE_IMPORT');
    await backupBefore(CID, 'BEFORE_UPGRADE');
    await backupBefore(CID, 'BEFORE_DELETE');
    const rows = await listBackups(CID);
    expect(rows.map((r) => r.type).sort()).toEqual(['BEFORE_DELETE', 'BEFORE_IMPORT', 'BEFORE_UPGRADE']);
  });

  it('يستعيد بأمان: نسخة وقائية + تحقق + معاملة واحدة + تدقيق + استئناف مزامنة', async () => {
    await post(100);
    const id = await createBackup(CID, 'MANUAL');
    await post(50);
    expect(await db.journalEntries.where('companyId').equals(CID).count()).toBe(2);

    await restoreBackup(id);

    expect(await db.journalEntries.where('companyId').equals(CID).count()).toBe(1);
    expect(await getAccountBalance(CID, '1100')).toBe(100);
    expect(isSyncPaused()).toBe(false);

    const rows = await listBackups(CID);
    expect(rows.some((r) => r.type === 'PRE_RESTORE')).toBe(true);
    const audits = await db.auditLogs.where('[companyId+tableName+recordId]').equals([CID, 'companies', CID]).toArray();
    expect(audits.some((a) => a.action === 'RESTORE')).toBe(true);
  });

  it('لا يلمس بيانات شركة أخرى أثناء الاستعادة', async () => {
    const OTHER = 'company_other';
    const now = Date.now();
    await db.companies.put({ id: OTHER, name: 'أخرى', slug: 'o', currency: 'JOD', status: 'ACTIVE', createdAt: now, updatedAt: now });
    await postBusinessTransaction({
      companyId: OTHER, entryDate: '2026-11-23', description: 'أخرى',
      lines: [{ accountId: '1100', debit: 77 }, { accountId: '4100', credit: 77 }],
    });
    const id = await createBackup(CID, 'MANUAL');
    await restoreBackup(id);
    expect(await db.journalEntries.where('companyId').equals(OTHER).count()).toBe(1);
  });
});
