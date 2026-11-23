import { db } from '../db/schema';
import { round2 } from '../ledger/validation';
import { getCurrentUser } from '../security/auth.service';
import { assertCan, assertCompanyAccess, type CurrentUser } from '../security/permissions';

type AccType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

async function accountType(companyId: string, accountId: string): Promise<AccType> {
  const acc: any = await db.accounts.where('[companyId+code]').equals([companyId, accountId]).first();
  if (acc?.type) return String(acc.type).toUpperCase() as AccType;
  const code = String(accountId);
  if (code.startsWith('4')) return 'REVENUE';
  if (code.startsWith('5') || code.startsWith('6')) return 'EXPENSE';
  if (code.startsWith('3')) return 'EQUITY';
  if (code.startsWith('2')) return 'LIABILITY';
  return 'ASSET';
}

async function rows(companyId: string, from?: string, to?: string, user?: CurrentUser) {
  const actor = user ?? getCurrentUser();
  assertCompanyAccess(actor, companyId);
  assertCan(actor, companyId, 'reports', 'view');
  const entries = (await db.journalEntries.where('companyId').equals(companyId).toArray())
    .filter((e) => (e.status === 'POSTED' || e.status === 'REVERSED')
      && (!from || e.entryDate >= from) && (!to || e.entryDate <= to));
  const ids = new Set(entries.map((e) => e.id));
  const lines = (await db.journalLines.where('companyId').equals(companyId).toArray())
    .filter((l) => ids.has(l.journalEntryId));
  return lines;
}

export interface IncomeStatement {
  revenue: number;
  expenses: number;
  netIncome: number;
  from?: string;
  to?: string;
}

export async function incomeStatement(companyId: string, from?: string, to?: string, user?: CurrentUser): Promise<IncomeStatement> {
  const lines = await rows(companyId, from, to, user);
  let revenue = 0;
  let expenses = 0;
  for (const l of lines) {
    const t = await accountType(companyId, l.accountId);
    if (t === 'REVENUE') revenue += l.credit - l.debit;
    if (t === 'EXPENSE') expenses += l.debit - l.credit;
  }
  revenue = round2(revenue);
  expenses = round2(expenses);
  return { revenue, expenses, netIncome: round2(revenue - expenses), from, to };
}

export interface BalanceSheet {
  assets: number;
  liabilities: number;
  equity: number;
  netIncome: number;
  balanced: boolean;
  asOf?: string;
}

export async function balanceSheet(companyId: string, asOf?: string, user?: CurrentUser): Promise<BalanceSheet> {
  const lines = await rows(companyId, undefined, asOf, user);
  let assets = 0, liabilities = 0, equity = 0, netIncome = 0;
  for (const l of lines) {
    const t = await accountType(companyId, l.accountId);
    const bal = l.debit - l.credit;
    if (t === 'ASSET') assets += bal;
    if (t === 'LIABILITY') liabilities -= bal;
    if (t === 'EQUITY') equity += bal;
    if (t === 'REVENUE') netIncome += l.credit - l.debit;
    if (t === 'EXPENSE') netIncome -= l.debit - l.credit;
  }
  assets = round2(assets);
  liabilities = round2(liabilities);
  equity = round2(equity + netIncome);
  netIncome = round2(netIncome);
  return { assets, liabilities, equity, netIncome, balanced: assets === round2(liabilities + equity), asOf };
}

export interface CashFlow {
  netIncome: number;
  changeInReceivables: number;
  changeInPayables: number;
  operatingCashFlow: number;
  from?: string;
  to?: string;
}

/** غير مباشر: صافي الربح ± التغير في الذمم المدينة/الدائنة. */
export async function cashFlow(companyId: string, from?: string, to?: string, user?: CurrentUser): Promise<CashFlow> {
  const actor = user ?? getCurrentUser();
  assertCompanyAccess(actor, companyId);
  assertCan(actor, companyId, 'reports', 'view');
  const income = await incomeStatement(companyId, from, to, actor);

  async function balanceAt(accountId: string, date?: string): Promise<number> {
    const lines = await rows(companyId, undefined, date, actor);
    return round2(lines.filter((l) => l.accountId === accountId).reduce((s, l) => s + l.debit - l.credit, 0));
  }
  const ar = round2((await balanceAt('1300', to)) - (await balanceAt('1300', from)));
  const ap = round2((await balanceAt('2100', to)) - (await balanceAt('2100', from)));
  return {
    netIncome: income.netIncome,
    changeInReceivables: ar,
    changeInPayables: ap,
    operatingCashFlow: round2(income.netIncome - ar + ap),
    from,
    to,
  };
}
