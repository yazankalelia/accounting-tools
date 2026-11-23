import { db } from '../db/schema';
import { newId } from '../../utils/id';
import { sha256 } from '../../utils/crypto';
import { getCurrentUser } from '../security/auth.service';
import { assertCan, type CurrentUser } from '../security/permissions';
import { round2 } from '../ledger/validation';
import { createBackup } from '../backup/backup.service';
import { pauseSync, resumeSync } from '../sync/control';
import { writeAudit } from '../security/audit.service';

export interface ImportReport {
  format: 'QAYD' | 'SUPERCALC';
  companyId: string;
  counts: Record<string, number>;
  warnings: string[];
  backupId: string;
  checksumVerified: boolean;
}

interface AnyRecord { [key: string]: any }

function arr(v: unknown): AnyRecord[] {
  return Array.isArray(v) ? (v as AnyRecord[]) : [];
}

function val(row: AnyRecord, ...keys: string[]): any {
  for (const k of keys) if (row?.[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  return undefined;
}

function dateOf(row: AnyRecord): string {
  const raw = val(row, 'date', 'entryDate', 'createdAt');
  if (typeof raw === 'number') return new Date(raw).toISOString().slice(0, 10);
  if (typeof raw === 'string') return raw.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

/** توازن القيد المستورد: يُحسب من سطوره لا من حقل status في الملف. */
function assertImportedEntryBalanced(lines: AnyRecord[]): void {
  const debit = round2(lines.reduce((s, l) => s + Number(l.debit || 0), 0));
  const credit = round2(lines.reduce((s, l) => s + Number(l.credit || 0), 0));
  if (debit !== credit) {
    throw new Error(`قيد غير متوازن: مدين ${debit} مقابل دائن ${credit}`);
  }
}

/**
 * القيود غير المتوازنة لا تدخل الميزان: تُعزل وتُسجَّل audit،
 * لكن وجود مئات القيود الصحيحة لا يُفشل الاستيراد بالكامل.
 */
async function storeValidatedJournal(
  entries: AnyRecord[],
  lines: AnyRecord[],
  companyId: string,
  actor: CurrentUser,
): Promise<{ storedEntries: number; storedLines: number; rejected: string[] }> {
  const byEntry = new Map<string, AnyRecord[]>();
  for (const line of lines) {
    const key = String(line.journalEntryId);
    const list = byEntry.get(key) ?? [];
    list.push(line);
    byEntry.set(key, list);
  }

  const valid: AnyRecord[] = [];
  const rejected: string[] = [];
  for (const entry of entries) {
    try {
      assertImportedEntryBalanced(byEntry.get(String(entry.id)) ?? []);
      valid.push(entry);
    } catch {
      rejected.push(String(entry.id));
    }
  }
  if (entries.length && !valid.length) {
    throw new Error('قيد غير متوازن: لا توجد قيود صالحة للاستيراد');
  }

  const validIds = new Set(valid.map((e) => String(e.id)));
  const validLines = lines.filter((l) => validIds.has(String(l.journalEntryId)));
  await db.journalEntries.bulkPut(valid.map((e) => ({
    ...e,
    status: e.status === 'POSTED' ? 'POSTED' : 'DRAFT',
  })) as any[]);
  await db.journalLines.bulkPut(validLines as any[]);

  if (rejected.length) {
    await db.auditLogs.add({
      id: newId(), companyId, userId: actor.id,
      tableName: 'journalEntries', recordId: rejected.join(','),
      action: 'IMPORT_REJECTED_UNBALANCED', changedAt: Date.now(),
      beforeData: null, afterData: { invalidEntryIds: rejected },
    } as any);
  }
  return { storedEntries: valid.length, storedLines: validLines.length, rejected };
}

function companyOf(root: AnyRecord): AnyRecord {
  const kv = arr(root?.data?.kv);
  const map: AnyRecord = {};
  for (const r of kv) map[String(r.k ?? r.key ?? '')] = r.v ?? r.value;
  return {
    name: map.companyName || map.name || 'شركة مستوردة',
    currency: map.currency || 'JOD',
    taxNumber: map.taxNumber,
  };
}

/**
 * استيراد ملف JSON من التطبيق القديم (app: accounting-tools-pro, schema: 1)
 * أو من نسخة QAYD (app: QAYD). لا يُحذف أي شيء من القديم، وتُنشأ نسخة وقائية أولًا.
 */
export async function importBackupFile(text: string, user?: CurrentUser): Promise<ImportReport> {
  let root: AnyRecord;
  try { root = JSON.parse(text) as AnyRecord; }
  catch { throw new Error('ملف JSON غير صالح'); }
  if (!root || typeof root !== 'object') throw new Error('بنية الملف غير صحيحة');

  const isQayd = root.app === 'QAYD';
  const isLegacy = root.app === 'accounting-tools-pro' || root.app === undefined;
  if (!isQayd && !isLegacy) throw new Error(`نظام غير معروف: ${String(root.app)}`);
  if (isQayd && Number(root.schemaVersion) > 4) throw new Error(`إصدار النسخة ${root.schemaVersion} أحدث من التطبيق`);

  const actor = user ?? getCurrentUser();
  const companyId = String(root.companyId || `imported-${Date.now()}`);
  assertCan(actor, companyId, 'company', 'manage');

  let checksumVerified = false;
  if (isQayd) {
    const { checksum, ...rest } = root;
    if (checksum) {
      const actual = await sha256(JSON.stringify(rest));
      if (actual !== checksum) throw new Error('Checksum غير مطابق — النسخة تالفة أو معدّلة');
      checksumVerified = true;
    }
  }

  const backupId = await createBackup(companyId, 'BEFORE_IMPORT', actor);
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  pauseSync();

  try {
    await db.transaction('rw', [
      db.companies, db.companySettings, db.accounts, db.journalEntries, db.journalLines,
      db.partners, db.invoices, db.checks, db.auditLogs,
    ], async () => {
      if (isQayd) {
        const d = root.data ?? {};
        const tables = ['companies', 'accounts', 'partners', 'invoices', 'checks', 'companySettings'] as const;
        for (const t of tables) {
          const rows = arr(d[t]);
          if (rows.length) await db.table(t).bulkPut(rows);
          counts[t] = rows.length;
        }
        const imported = await storeValidatedJournal(arr(d.journalEntries), arr(d.journalLines), companyId, actor);
        counts.journalEntries = imported.storedEntries;
        counts.journalLines = imported.storedLines;
        if (imported.rejected.length) {
          warnings.push(`استُبعدت ${imported.rejected.length} قيدًا غير متوازن من الميزان (سُجّلت في التدقيق).`);
        }
      } else {
        const d = root.data ?? {};
        const meta = companyOf(root);
        const now = Date.now();
        await db.companies.put({
          id: companyId, name: String(meta.name), slug: 'imported',
          currency: String(meta.currency),
          taxNumber: meta.taxNumber ? String(meta.taxNumber) : undefined,
          status: 'ACTIVE', createdAt: now, updatedAt: now,
        });
        counts.companies = 1;

        const coa = arr(d.coa);
        await db.accounts.bulkPut(coa.map((r) => ({
          id: newId(), companyId,
          code: String(val(r, 'code', 'id') || ''),
          name: String(val(r, 'name', 'label') || ''),
          type: String(val(r, 'type') || 'ASSET'),
          normalBalance: String(val(r, 'normalBalance') || 'DEBIT'),
          parentId: val(r, 'parentId') ? String(val(r, 'parentId')) : undefined,
          currency: String(meta.currency),
          status: 'ACTIVE', updatedAt: now, version: 1, syncStatus: 'LOCAL',
        })));
        counts.accounts = coa.length;

        const journal = arr(d.journal);
        const entries: AnyRecord[] = [];
        const lines: AnyRecord[] = [];
        for (const r of journal) {
          const id = `imp_${String(val(r, 'id') || newId())}`;
          const rawLines = arr(val(r, 'lines', 'entries'));
          entries.push({
            id, companyId,
            entryNumber: String(val(r, 'entryNumber', 'number', 'id') || id),
            entryDate: dateOf(r),
            description: String(val(r, 'description', 'desc', 'note') || ''),
            status: String(val(r, 'status') || 'POSTED').toUpperCase() === 'POSTED' ? 'POSTED' : 'DRAFT',
            sourceType: 'MANUAL', currency: String(meta.currency), exchangeRate: 1,
            createdAt: now, updatedAt: now, version: 1, syncStatus: 'LOCAL',
          });
          for (const l of rawLines) {
            lines.push({
              id: newId(), companyId, journalEntryId: id,
              accountId: String(val(l, 'account', 'accountId', 'code') || ''),
              debit: Number(val(l, 'debit', 'd') || 0),
              credit: Number(val(l, 'credit', 'c') || 0),
              currency: String(meta.currency), exchangeRate: 1,
              description: val(l, 'description', 'desc') ? String(val(l, 'description', 'desc')) : undefined,
              lineDate: dateOf(r),
            });
          }
        }
        const imported = await storeValidatedJournal(entries, lines, companyId, actor);
        counts.journalEntries = imported.storedEntries;
        counts.journalLines = imported.storedLines;
        if (imported.rejected.length) {
          warnings.push(`استُبعدت ${imported.rejected.length} قيدًا غير متوازن من الميزان (سُجّلت في التدقيق).`);
        }

        const kv = arr(d.kv);
        await db.companySettings.bulkPut(kv.map((r) => ({
          id: newId(), companyId, key: String(val(r, 'k', 'key') || 'legacy'),
          value: String(val(r, 'v', 'value') ?? ''),
        })));
        counts.companySettings = kv.length;

        const audits = arr(d.audit);
        await db.auditLogs.bulkPut(audits.map((r) => ({
          id: newId(), companyId,
          tableName: String(val(r, 'table', 'tableName') || 'legacy'),
          recordId: String(val(r, 'recordId', 'id') || ''),
          action: 'MIGRATION', changedAt: Number(val(r, 'ts', 'changedAt') || now),
          beforeData: r, userId: actor.id,
        })));
        counts.auditLogs = audits.length;

        if (arr(d.sessions).length) warnings.push('لقاطات الجلسات (sessions) لم تُستورد — هي لقطات واجهة لا بيانات مالية.');
      }

      await writeAudit(companyId, 'companies', companyId, 'MIGRATION', undefined,
        { format: isQayd ? 'QAYD' : 'SUPERCALC', counts, backupId }, actor.id);
    });

    return {
      format: isQayd ? 'QAYD' : 'SUPERCALC',
      companyId, counts, warnings, backupId, checksumVerified,
    };
  } finally {
    resumeSync();
  }
}
