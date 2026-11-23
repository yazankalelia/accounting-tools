import { db } from '../db/schema';
import { newId } from '../../utils/id';
import { getCurrentUser } from '../security/auth.service';
import { assertCan, assertCompanyAccess, type CurrentUser } from '../security/permissions';

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;
export type AccountType = typeof ACCOUNT_TYPES[number];

export interface CreateAccountInput {
  companyId: string;
  code: string;
  name: string;
  type: AccountType;
  parentId?: string;
  normalBalance?: 'DEBIT' | 'CREDIT';
  user?: CurrentUser;
}

export async function createAccount(input: CreateAccountInput): Promise<string> {
  const actor = input.user ?? getCurrentUser();
  assertCompanyAccess(actor, input.companyId);
  assertCan(actor, input.companyId, 'settings', 'manage');
  const code = String(input.code || '').trim();
  const name = String(input.name || '').trim();
  if (!code || !name) throw new Error('الرمز والاسم مطلوبان');
  const dup = await db.accounts.where('[companyId+code]').equals([input.companyId, code]).first();
  if (dup) throw new Error(`الحساب ${code} موجود مسبقًا`);

  const id = newId();
  await db.accounts.add({
    id,
    companyId: input.companyId,
    code,
    name,
    type: input.type,
    normalBalance: input.normalBalance ?? (input.type === 'ASSET' || input.type === 'EXPENSE' ? 'DEBIT' : 'CREDIT'),
    parentId: input.parentId || undefined,
    currency: 'JOD',
    status: 'ACTIVE',
    updatedAt: Date.now(),
    version: 1,
    syncStatus: 'PENDING',
  });
  return id;
}

/** حسابات افتراضية تُُنشأ مع أي شركة جديدة لضمان عمل الأمثلة فورًا. */
export async function seedChartOfAccounts(companyId: string, user?: CurrentUser): Promise<number> {
  const existing = await db.accounts.where('companyId').equals(companyId).count();
  if (existing > 0) return 0;
  const defaults: Array<[string, string, AccountType]> = [
    ['1100', 'النقدية', 'ASSET'],
    ['1200', 'البنك', 'ASSET'],
    ['1300', 'المدينون', 'ASSET'],
    ['1500', 'الأصول الثابتة', 'ASSET'],
    ['2100', 'الدائنون', 'LIABILITY'],
    ['2200', 'ضريبة المخرجات', 'LIABILITY'],
    ['2210', 'ضريبة المدخلات', 'LIABILITY'],
    ['3100', 'رأس المال', 'EQUITY'],
    ['4100', 'إيرادات المبيعات', 'REVENUE'],
    ['5100', 'مصروف المشتريات', 'EXPENSE'],
    ['5200', 'مصروف الإهلاك', 'EXPENSE'],
  ];
  for (const [code, name, type] of defaults) {
    await createAccount({ companyId, code, name, type, user });
  }
  return defaults.length;
}

export async function listAccounts(companyId: string): Promise<any[]> {
  return db.accounts.where('companyId').equals(companyId).sortBy('code');
}
