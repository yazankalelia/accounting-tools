import { describe, it, expect, beforeEach } from 'vitest';
import {
  can, assertCan, assertCompanyAccess,
  type CurrentUser, type Role, type PermissionMap,
} from '../src/core/security/permissions';
import { db } from '../src/core/db/schema';
import { postBusinessTransaction, reverseEntry } from '../src/core/ledger/journal.service';
import { trialBalance } from '../src/core/ledger/balance.service';

const A = 'company_A';
const B = 'company_B';

function userWith(role: Role, companies: string[], overrides?: PermissionMap): CurrentUser {
  return {
    id: 'u1',
    name: 'اختبار',
    memberships: companies.map((companyId, i) => ({
      id: `uc_${i}`,
      userId: 'u1',
      companyId,
      role,
      status: 'ACTIVE' as const,
      ...(overrides ? { permissions: overrides } : {}),
    })),
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('RBAC + Company Scope', () => {
  it('OWNER يملك كل الصلاحيات داخل شركته فقط', () => {
    const u = userWith('OWNER', [A]);
    expect(can(u, A, 'company', 'delete')).toBe(true);
    expect(can(u, B, 'company', 'delete')).toBe(false);
    expect(() => assertCompanyAccess(u, B)).toThrow('Company Scope');
  });

  it('ADMIN يدير المستخدمين والإعدادات لكن بلا حذف نهائي للشركة', () => {
    const u = userWith('ADMIN', [A]);
    expect(can(u, A, 'users', 'manage')).toBe(true);
    expect(can(u, A, 'settings', 'manage')).toBe(true);
    expect(can(u, A, 'company', 'delete')).toBe(false);
    expect(can(u, A, 'company', 'manage')).toBe(true);
  });

  it('ACCOUNTANT يرحّل القيود ولا يدير المستخدمين', () => {
    const u = userWith('ACCOUNTANT', [A]);
    expect(can(u, A, 'journal', 'post')).toBe(true);
    expect(can(u, A, 'invoices', 'void')).toBe(true);
    expect(can(u, A, 'reports', 'export')).toBe(true);
    expect(can(u, A, 'users', 'manage')).toBe(false);
  });

  it('DATA_ENTRY ينشئ مسودات فقط', () => {
    const u = userWith('DATA_ENTRY', [A]);
    expect(can(u, A, 'journal', 'create')).toBe(true);
    expect(can(u, A, 'journal', 'edit_draft')).toBe(true);
    expect(can(u, A, 'journal', 'post')).toBe(false);
    expect(can(u, A, 'invoices', 'post')).toBe(false);
  });

  it('AUDITOR للعرض والتصدير والتدقيق فقط', () => {
    const u = userWith('AUDITOR', [A]);
    expect(can(u, A, 'audit', 'view')).toBe(true);
    expect(can(u, A, 'reports', 'export')).toBe(true);
    expect(can(u, A, 'journal', 'create')).toBe(false);
    expect(can(u, A, 'journal', 'post')).toBe(false);
  });

  it('VIEWER للعرض المحدود', () => {
    const u = userWith('VIEWER', [A]);
    expect(can(u, A, 'journal', 'view')).toBe(true);
    expect(can(u, A, 'reports', 'export')).toBe(false);
    expect(can(u, A, 'backup', 'create_backup')).toBe(false);
  });

  it('صلاحيات العضوية تتجاوز افتراض الدور', () => {
    const u = userWith('VIEWER', [A], { journal: ['view', 'post'], reports: [] });
    expect(can(u, A, 'journal', 'post')).toBe(true);
    expect(can(u, A, 'reports', 'view')).toBe(false);
  });

  it('عضوية معلّقة تُسقط كل الصلاحيات', () => {
    const u = userWith('OWNER', [A]);
    u.memberships[0].status = 'SUSPENDED';
    expect(can(u, A, 'journal', 'post')).toBe(false);
  });

  it('نفس المستخدم بدور مختلف في شركتين', () => {
    const u: CurrentUser = {
      id: 'u1',
      memberships: [
        { id: 'uc1', userId: 'u1', companyId: A, role: 'ACCOUNTANT', status: 'ACTIVE' },
        { id: 'uc2', userId: 'u1', companyId: B, role: 'VIEWER', status: 'ACTIVE' },
      ],
    };
    expect(can(u, A, 'journal', 'post')).toBe(true);
    expect(can(u, B, 'journal', 'post')).toBe(false);
    expect(can(u, B, 'journal', 'view')).toBe(true);
  });

  it('طبقة الخدمة ترفض الترحيل من DATA_ENTRY', async () => {
    const u = userWith('DATA_ENTRY', [A]);
    await expect(postBusinessTransaction({
      companyId: A,
      entryDate: '2026-11-23',
      description: 'محاولة ترحيل',
      user: u,
      lines: [{ accountId: '1100', debit: 10 }, { accountId: '4100', credit: 10 }],
    })).rejects.toThrow('لا تملك صلاحية post على journal');
  });

  it('طبقة الخدمة تسمح بمسودة لـDATA_ENTRY وترحيل لـACCOUNTANT', async () => {
    const entry = { companyId: A, entryDate: '2026-11-23', description: 'اختبار', lines: [{ accountId: '1100', debit: 10 }, { accountId: '4100', credit: 10 }] };
    const draftId = await postBusinessTransaction({ ...entry, status: 'DRAFT', user: userWith('DATA_ENTRY', [A]) });
    expect((await db.journalEntries.get(draftId))?.status).toBe('DRAFT');

    const postedId = await postBusinessTransaction({ ...entry, user: userWith('ACCOUNTANT', [A]) });
    expect((await db.journalEntries.get(postedId))?.status).toBe('POSTED');
  });

  it('لا يمكن الترحيل لشركة لا ينتمي إليها المستخدم حتى لو عرف companyId', async () => {
    const u = userWith('ACCOUNTANT', [A]);
    await expect(postBusinessTransaction({
      companyId: B,
      entryDate: '2026-11-23',
      description: 'تجاوز نطاق',
      user: u,
      lines: [{ accountId: '1100', debit: 10 }, { accountId: '4100', credit: 10 }],
    })).rejects.toThrow('Company Scope');
  });

  it('العكس والتقارير محميان أيضًا', async () => {
    const owner = userWith('OWNER', [A]);
    const id = await postBusinessTransaction({
      companyId: A, entryDate: '2026-11-23', description: 'قيد', user: owner,
      lines: [{ accountId: '1100', debit: 10 }, { accountId: '4100', credit: 10 }],
    });
    await expect(reverseEntry(id, A, undefined, userWith('AUDITOR', [A]))).rejects.toThrow('reverse');
    await expect(trialBalance(A, undefined, userWith('DATA_ENTRY', [A]))).rejects.toThrow('reports');
    await expect(trialBalance(B, undefined, userWith('ACCOUNTANT', [A]))).rejects.toThrow('Company Scope');
  });

  it('assertCan يرمي رسالة عربية واضحة', () => {
    expect(() => assertCan(userWith('VIEWER', [A]), A, 'journal', 'post')).toThrow('لا تملك صلاحية post على journal');
  });
});
