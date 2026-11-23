import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/core/db/schema';
import { createCompany, listCompanies } from '../src/core/company/company.service';
import { createUser, listUsers, setUserRole, suspendUser } from '../src/core/security/user.service';
import { createAccount, seedChartOfAccounts, listAccounts } from '../src/core/accounts/accounts.service';
import { importBackupFile } from '../src/core/import/legacy-import.service';
import { getAccountBalance } from '../src/core/ledger/balance.service';
import { createBackup, restoreBackup } from '../src/core/backup/backup.service';
import { localOwner } from '../src/core/security/auth.service';

const owner = localOwner('*');

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('معالج الإعداد والاستيراد', () => {
  it('ينشئ شركة بعملة وسطر تدقيق وعضوية OWNER', async () => {
    const c = await createCompany({ name: 'شركة النور', currency: 'JOD', user: owner });
    expect(c.name).toBe('شركة النور');
    expect(await listCompanies()).toHaveLength(1);
    expect(await db.userCompanies.where('companyId').equals(c.id).count()).toBe(1);
    expect(await db.auditLogs.where('companyId').equals(c.id).count()).toBe(1);
  });

  it('ينشئ مستخدمًا بدور ويغيّر دوره ثم يعلّقه', async () => {
    const c = await createCompany({ name: 'شركة', user: owner });
    const id = await createUser({
      companyId: c.id, name: 'محاسب', email: 'a@x.com', role: 'ACCOUNTANT', user: owner,
    });
    const users = await listUsers(c.id, owner);
    expect(users.find((u) => u.id === id)?.memberships[0].role).toBe('ACCOUNTANT');

    await setUserRole(id, c.id, 'AUDITOR', undefined, owner);
    expect((await listUsers(c.id, owner)).find((u) => u.id === id)?.memberships[0].role).toBe('AUDITOR');

    await suspendUser(id, c.id, true, owner);
    expect((await listUsers(c.id, owner)).find((u) => u.id === id)?.memberships[0].status).toBe('SUSPENDED');
  });

  it('يرفض مستخدمًا بدور غير معروف', async () => {
    const c = await createCompany({ name: 'شركة', user: owner });
    await expect(createUser({ companyId: c.id, name: 'x', role: 'HACKER' as any, user: owner }))
      .rejects.toThrow('دور غير صالح');
  });

  it('ينشئ دليل حسابات ويرفض تكرار الرمز', async () => {
    const c = await createCompany({ name: 'شركة', user: owner });
    expect(await seedChartOfAccounts(c.id, owner)).toBe(11);
    expect((await listAccounts(c.id)).length).toBe(11);
    await expect(createAccount({ companyId: c.id, code: '1100', name: 'مكرر', type: 'ASSET', user: owner }))
      .rejects.toThrow('موجود مسبقًا');
  });

  it('يستورد نسخة التطبيق القديم: عملة/دليل/قيود ويحسب الرصيد', async () => {
    const legacy = {
      app: 'accounting-tools-pro', schema: 1, createdAt: '2026-01-01T00:00:00Z',
      data: {
        kv: [{ k: 'companyName', v: 'شركة قديمة' }, { k: 'currency', v: 'JOD' }],
        coa: [{ code: '1100', name: 'النقدية', type: 'ASSET' }, { code: '4100', name: 'الإيراد', type: 'REVENUE' }],
        journal: [{
          id: 'j1', date: '2026-01-15', description: 'قيد قديم', status: 'POSTED',
          lines: [{ account: '1100', debit: 250 }, { account: '4100', credit: 250 }],
        }],
        audit: [], sessions: [{ id: 's1' }],
      },
    };
    const r = await importBackupFile(JSON.stringify(legacy), owner);
    expect(r.format).toBe('SUPERCALC');
    expect(r.counts.accounts).toBe(2);
    expect(r.counts.journalEntries).toBe(1);
    expect(r.counts.journalLines).toBe(2);
    expect(r.warnings.length).toBe(1);
    expect(await getAccountBalance(r.companyId, '1100')).toBe(250);

    const company: any = await db.companies.get(r.companyId);
    expect(company.name).toBe('شركة قديمة');
  });

  it('يستورد نسخة QAYD بعد التحقق من checksum مع نسخة وقائية', async () => {
    const c = await createCompany({ name: 'شركة', user: owner });
    await seedChartOfAccounts(c.id, owner);
    const id = await createBackup(c.id, 'MANUAL');
    const payload = (await db.backups_data.get(id))!.payload as any;
    const r = await importBackupFile(JSON.stringify(payload), owner);
    expect(r.format).toBe('QAYD');
    expect(r.checksumVerified).toBe(true);
    expect(r.counts.journalEntries).toBe(0);
    expect(await db.backups.get(r.backupId)).toBeDefined();
  });

  it('يرفض نسخة QAYD معدّلة', async () => {
    const c = await createCompany({ name: 'شركة', user: owner });
    const id = await createBackup(c.id, 'MANUAL');
    const payload = (await db.backups_data.get(id))!.payload as any;
    payload.data.accounts = [{ id: 'hacked' }];
    await expect(importBackupFile(JSON.stringify(payload), owner)).rejects.toThrow('Checksum غير مطابق');
  });

  it('الاستعادة بعد الاستيراد تُعيد الحالة وتسجّل تدقيقًا', async () => {
    const legacy = {
      app: 'accounting-tools-pro', data: {
        kv: [{ k: 'companyName', v: 'قديمة' }], coa: [], journal: [], audit: [],
      },
    };
    const r = await importBackupFile(JSON.stringify(legacy), owner);
    const id = await createBackup(r.companyId, 'MANUAL');
    await db.accounts.add({
      id: 'extra', companyId: r.companyId, code: '9999', name: 'حساب إضافي',
      type: 'ASSET', status: 'ACTIVE', updatedAt: Date.now(),
    });
    expect(await db.accounts.where('companyId').equals(r.companyId).count()).toBe(1);
    await restoreBackup(r.companyId, id, owner);
    expect(await db.accounts.where('companyId').equals(r.companyId).count()).toBe(0);
  });

  it('listCompanies يعرض شركات العضوية الفعالة فقط', async () => {
    const a = await createCompany({ name: 'شركة أ', user: owner });
    await createCompany({ name: 'شركة ب', user: owner });
    const scoped: any = {
      id: 'u-scoped',
      memberships: [{ id: 'ms', userId: 'u-scoped', companyId: a.id, role: 'VIEWER', status: 'ACTIVE' }],
    };
    await db.userCompanies.add({ id: 'ms', userId: 'u-scoped', companyId: a.id, role: 'VIEWER', status: 'ACTIVE' });
    expect((await listCompanies(scoped)).map((c) => c.id)).toEqual([a.id]);
    await db.userCompanies.update('ms', { status: 'SUSPENDED' });
    expect(await listCompanies(scoped)).toHaveLength(0);
  });

  it('listUsers يعرض مستخدمي الشركة المحددة فقط وبلا أسرار', async () => {
    const a = await createCompany({ name: 'شركة أ', user: owner });
    const b = await createCompany({ name: 'شركة ب', user: owner });
    const ua = await createUser({ companyId: a.id, name: 'أ', role: 'ACCOUNTANT', user: owner });
    await createUser({ companyId: b.id, name: 'ب', role: 'VIEWER', user: owner });
    await db.users.update(ua, { passwordHash: 'secret' });

    const rows = await listUsers(a.id, owner);
    expect(rows.map((u) => u.id)).toEqual([ua]);
    expect(rows[0].passwordHash).toBeUndefined();
    expect(rows[0].companyRole).toBe('ACCOUNTANT');
  });

  it('يرفض استيراد ملف فيه قيد غير متوازن واحد', async () => {
    const legacy = {
      app: 'accounting-tools-pro',
      data: {
        kv: [{ k: 'companyName', v: 'غير متوازنة' }],
        coa: [{ code: '1100', name: 'النقدية', type: 'ASSET' }],
        journal: [{ id: 'bad', status: 'POSTED', lines: [{ account: '1100', debit: 30 }, { account: '4100', credit: 20 }] }],
      },
    };
    await expect(importBackupFile(JSON.stringify(legacy), owner)).rejects.toThrow(/غير متوازن/);
  });

  it('يعزل القيد غير المتوازن ويُبقي القيود الصحيحة فقط في الميزان', async () => {
    const legacy = {
      app: 'accounting-tools-pro',
      data: {
        kv: [{ k: 'companyName', v: 'مختلطة' }],
        coa: [{ code: '1100', name: 'النقدية', type: 'ASSET' }, { code: '4100', name: 'الإيراد', type: 'REVENUE' }],
        journal: [
          { id: 'good', status: 'POSTED', lines: [{ account: '1100', debit: 100 }, { account: '4100', credit: 100 }] },
          { id: 'bad', status: 'POSTED', lines: [{ account: '1100', debit: 30 }, { account: '4100', credit: 20 }] },
        ],
      },
    };
    const r = await importBackupFile(JSON.stringify(legacy), owner);
    expect(r.warnings.join(' ')).toMatch(/استُبعدت/);
    expect(r.counts.journalEntries).toBe(1);
    expect(await getAccountBalance(r.companyId, '1100')).toBe(100);
    const audits = await db.auditLogs.where('companyId').equals(r.companyId).toArray();
    expect(audits.some((a) => (a as any).action === 'IMPORT_REJECTED_UNBALANCED')).toBe(true);
  });
});
