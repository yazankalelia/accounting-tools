import { db, type Company } from './schema';
import { newId } from '../../utils/id';
import { writeAudit } from '../security/audit.service';

const LEGACY_DB = 'supercalc';
export const LEGACY_COMPANY_ID = 'legacy-company';

export interface MigrationReport {
  status: 'MIGRATED' | 'SKIPPED' | 'FAILED';
  counts: Record<string, number>;
  errors: string[];
}

function openLegacy(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(LEGACY_DB);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null); // قاعدة قديمة غير موجودة = لا شيء لترحيله
    req.onblocked = () => resolve(null);
  });
}

function readAll(legacy: IDBDatabase, store: string): Promise<any[]> {
  return new Promise((resolve) => {
    if (!legacy.objectStoreNames.contains(store)) return resolve([]);
    try {
      const req = legacy.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

function val(row: any, ...keys: string[]): any {
  for (const k of keys) if (row?.[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  return undefined;
}

function dateOf(row: any): string {
  const raw = val(row, 'date', 'entryDate', 'invoiceDate', 'issueDate', 'createdAt');
  if (typeof raw === 'number') return new Date(raw).toISOString().slice(0, 10);
  if (typeof raw === 'string') return raw.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/**
 * ترحيل supercalc (v1/v2/v3) → qayd_db v4.
 * لا يُحذف أي شيء من القاعدة القديمة — تُترك قابلة للاستعادة.
 */
export async function migrateFromSupercalc(): Promise<MigrationReport> {
  const report: MigrationReport = { status: 'MIGRATED', counts: {}, errors: [] };
  const flag = await db.companySettings.where('[companyId+key]').equals([LEGACY_COMPANY_ID, 'migrated_from_v3']).first();
  if (flag) return { ...report, status: 'SKIPPED' };

  const legacy = await openLegacy();
  if (!legacy) return { ...report, status: 'SKIPPED' };

  try {
    const [kv, coa, journal, partners, invoices, cheques] = await Promise.all([
      readAll(legacy, 'kv'),
      readAll(legacy, 'coa'),
      readAll(legacy, 'journal'),
      readAll(legacy, 'partners'),
      readAll(legacy, 'invoices'),
      readAll(legacy, 'cheques'),
    ]);

    const now = Date.now();
    const company: Company = {
      id: LEGACY_COMPANY_ID,
      name: String(val(kv[0], 'companyName', 'name', 'value') || 'شركتي'),
      slug: 'legacy',
      currency: String(val(kv[0], 'currency') || 'JOD'),
      taxNumber: val(kv[0], 'taxNumber') ? String(val(kv[0], 'taxNumber')) : undefined,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };

    await db.transaction(
      'rw',
      [db.companies, db.companySettings, db.accounts, db.journalEntries, db.journalLines,
        db.partners, db.invoices, db.checks, db.auditLogs],
      async () => {
        await db.companies.put(company);

        await db.accounts.bulkPut(coa.map((r) => ({
          id: String(val(r, 'id') || newId()),
          companyId: LEGACY_COMPANY_ID,
          code: String(val(r, 'code', 'id') || ''),
          name: String(val(r, 'name', 'label') || ''),
          type: String(val(r, 'type') || 'ASSET'),
          normalBalance: String(val(r, 'normalBalance') || 'DEBIT'),
          parentId: val(r, 'parentId') ? String(val(r, 'parentId')) : undefined,
          currency: company.currency,
          status: 'ACTIVE',
          updatedAt: now,
          version: 1,
          syncStatus: 'LOCAL',
        })));

        const entries: any[] = [];
        const lines: any[] = [];
        for (const r of journal) {
          const id = String(val(r, 'id') || newId());
          const rawLines = Array.isArray(val(r, 'lines', 'entries')) ? val(r, 'lines', 'entries') : [];
          const posted = String(val(r, 'status') || 'POSTED').toUpperCase() === 'POSTED';
          entries.push({
            id,
            companyId: LEGACY_COMPANY_ID,
            entryNumber: String(val(r, 'entryNumber', 'number', 'jeNo') || id),
            entryDate: dateOf(r),
            description: String(val(r, 'description', 'desc', 'note') || ''),
            status: posted ? 'POSTED' : 'DRAFT',
            sourceType: String(val(r, 'sourceType') || 'MANUAL'),
            sourceId: val(r, 'sourceId') ? String(val(r, 'sourceId')) : undefined,
            reversalOfId: val(r, 'reversalOfId') ? String(val(r, 'reversalOfId')) : undefined,
            currency: company.currency,
            exchangeRate: 1,
            createdAt: now,
            updatedAt: now,
            version: 1,
            syncStatus: 'LOCAL',
          });
          for (const l of rawLines) {
            lines.push({
              id: newId(),
              companyId: LEGACY_COMPANY_ID,
              journalEntryId: id,
              accountId: String(val(l, 'account', 'accountId', 'code') || ''),
              debit: Number(val(l, 'debit', 'd') || 0),
              credit: Number(val(l, 'credit', 'c') || 0),
              currency: company.currency,
              exchangeRate: 1,
              description: val(l, 'description', 'desc') ? String(val(l, 'description', 'desc')) : undefined,
              lineDate: dateOf(r),
            });
          }
        }
        await db.journalEntries.bulkPut(entries);
        await db.journalLines.bulkPut(lines);

        await db.partners.bulkPut(partners.map((r) => ({
          id: String(val(r, 'id') || newId()),
          companyId: LEGACY_COMPANY_ID,
          name: String(val(r, 'name') || ''),
          partnerType: String(val(r, 'type', 'partnerType') || 'CUSTOMER'),
          taxNumber: val(r, 'taxNumber') ? String(val(r, 'taxNumber')) : undefined,
          phone: val(r, 'phone') ? String(val(r, 'phone')) : undefined,
          openingBalance: Number(val(r, 'openingBalance', 'balance') || 0),
          openingBalanceDirection: String(val(r, 'openingBalanceDirection', 'direction') || 'DEBIT'),
          status: 'ACTIVE',
          updatedAt: now,
          version: 1,
          syncStatus: 'LOCAL',
        })));

        await db.invoices.bulkPut(invoices.map((r) => ({
          id: String(val(r, 'id') || newId()),
          companyId: LEGACY_COMPANY_ID,
          invoiceType: String(val(r, 'type', 'invoiceType') || 'SALE'),
          invoiceNumber: String(val(r, 'invoiceNumber', 'number', 'no') || ''),
          invoiceDate: dateOf(r),
          partnerId: val(r, 'partnerId') ? String(val(r, 'partnerId')) : undefined,
          total: Number(val(r, 'total', 'amount') || 0),
          subtotal: Number(val(r, 'subtotal') || 0),
          taxTotal: Number(val(r, 'tax', 'taxTotal', 'vat') || 0),
          status: String(val(r, 'status') || 'DRAFT'),
          notes: val(r, 'notes') ? String(val(r, 'notes')) : undefined,
          createdAt: now,
          updatedAt: now,
          version: 1,
          syncStatus: 'LOCAL',
        })));

        await db.checks.bulkPut(cheques.map((r) => ({
          id: String(val(r, 'id') || newId()),
          companyId: LEGACY_COMPANY_ID,
          checkType: String(val(r, 'type', 'checkType') || 'INCOMING'),
          checkNumber: String(val(r, 'number', 'checkNumber', 'no') || ''),
          dueDate: val(r, 'dueDate') ? String(val(r, 'dueDate')).slice(0, 10) : undefined,
          partnerId: val(r, 'partnerId') ? String(val(r, 'partnerId')) : undefined,
          amount: Number(val(r, 'amount') || 0),
          currency: company.currency,
          status: String(val(r, 'status') || 'PENDING'),
          createdAt: now,
          updatedAt: now,
          version: 1,
          syncStatus: 'LOCAL',
        })));

        await db.companySettings.bulkPut([
          { id: newId(), companyId: LEGACY_COMPANY_ID, key: 'migrated_from_v3', value: '1' },
          { id: newId(), companyId: LEGACY_COMPANY_ID, key: 'source_db', value: LEGACY_DB },
        ]);
        await writeAudit(LEGACY_COMPANY_ID, 'companies', LEGACY_COMPANY_ID, 'MIGRATION', undefined, report.counts);
      },
    );

    report.counts = {
      companies: 1,
      accounts: coa.length,
      journalEntries: journal.length,
      journalLines: linesCount(journal),
      partners: partners.length,
      invoices: invoices.length,
      checks: cheques.length,
    };
  } catch (e) {
    report.status = 'FAILED';
    report.errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    legacy.close();
  }
  return report;
}

function linesCount(journal: any[]): number {
  return journal.reduce((n, r) => n + (Array.isArray(val(r, 'lines', 'entries')) ? val(r, 'lines', 'entries').length : 0), 0);
}
