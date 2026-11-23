import { db } from '../db/schema';
import { round2 } from './validation';
import { getCurrentUser } from '../security/auth.service';
import { assertCan, assertCompanyAccess, type CurrentUser } from '../security/permissions';

/** الرصيد يُحسب دائمًا من journalLines — لا يُخزّن كرقم نهائي في أي جدول. */
export async function getAccountBalance(
  companyId: string,
  accountId: string,
  asOf?: string,
  user?: CurrentUser,
): Promise<number> {
  const actor = user ?? getCurrentUser();
  assertCompanyAccess(actor, companyId);
  assertCan(actor, companyId, 'journal', 'view');
  // القيد المعكوس يبقى محسوبًا مع قيده العكسي كي يتلغيا؛ المُبطل VOID يُستبعد.
  const entries = await db.journalEntries.where('companyId').equals(companyId).toArray();
  const ids = new Set(
    entries
      .filter((e) => (e.status === 'POSTED' || e.status === 'REVERSED') && (!asOf || e.entryDate <= asOf))
      .map((e) => e.id),
  );
  const lines = await db.journalLines
    .where('[companyId+accountId]')
    .equals([companyId, accountId])
    .toArray();
  return round2(
    lines
      .filter((l) => ids.has(l.journalEntryId))
      .reduce((sum, l) => sum + l.debit - l.credit, 0),
  );
}

export interface TrialRow {
  accountId: string;
  debit: number;
  credit: number;
  balance: number;
}

/** ميزان المراجعة حتى تاريخ محدد. */
export async function trialBalance(companyId: string, asOf?: string, user?: CurrentUser): Promise<TrialRow[]> {
  const actor = user ?? getCurrentUser();
  assertCompanyAccess(actor, companyId);
  assertCan(actor, companyId, 'reports', 'view');
  const entries = await db.journalEntries.where('companyId').equals(companyId).toArray();
  const ids = new Set(
    entries
      .filter((e) => (e.status === 'POSTED' || e.status === 'REVERSED') && (!asOf || e.entryDate <= asOf))
      .map((e) => e.id),
  );
  const lines = await db.journalLines.where('companyId').equals(companyId).toArray();
  const byAccount = new Map<string, TrialRow>();
  for (const l of lines) {
    if (!ids.has(l.journalEntryId)) continue;
    const row = byAccount.get(l.accountId) ?? { accountId: l.accountId, debit: 0, credit: 0, balance: 0 };
    row.debit += l.debit;
    row.credit += l.credit;
    row.balance += l.debit - l.credit;
    byAccount.set(l.accountId, row);
  }
  return [...byAccount.values()]
    .map((r) => ({ ...r, debit: round2(r.debit), credit: round2(r.credit), balance: round2(r.balance) }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
}
