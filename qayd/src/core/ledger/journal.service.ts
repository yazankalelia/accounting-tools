import {
  db,
  type JournalEntry,
  type JournalLine,
  type EntryStatus,
  type SourceType,
} from '../db/schema';
import { newId } from '../../utils/id';
import { assertBalanced, assertLineShape, round2 } from './validation';
import { writeAudit } from '../security/audit.service';
import { enqueue } from '../sync/queue';
import { getCurrentUser } from '../security/auth.service';
import { assertCan, assertCompanyAccess, type CurrentUser } from '../security/permissions';
import { createBackup } from '../backup/backup.service';

export interface PostLineInput {
  accountId: string;
  debit?: number;
  credit?: number;
  description?: string;
  lineDate?: string;
  costCenterId?: string;
  projectId?: string;
}

export interface PostEntryInput {
  companyId: string;
  entryDate: string;
  description: string;
  lines: PostLineInput[];
  sourceType?: SourceType;
  sourceId?: string;
  reversalOfId?: string;
  currency?: string;
  exchangeRate?: number;
  createdBy?: string;
  status?: EntryStatus;
  /** يُمرَّر صراحةً من الطلب في الوضع متعدد المستخدمين؛ الافتراضي مالك محلي. */
  user?: CurrentUser;
  /** يمنع نسخة مكررة عند الاستدعاء من داخل معاملة أكبر (مثل العكس). */
  skipBackup?: boolean;
}

/** ترقيم ذري لكل شركة شهريًا: JE-YYYYMM-0001. */
export async function nextEntryNumber(companyId: string, entryDate: string): Promise<string> {
  const prefix = 'JE-' + entryDate.slice(0, 7).replace('-', '');
  const last = await db.journalEntries
    .where('[companyId+entryNumber]')
    .between([companyId, prefix], [companyId, prefix + '\uffff'])
    .last();
  const n = last ? Number(last.entryNumber.split('-').pop() || 0) + 1 : 1;
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

/**
 * نقطة الدخول الوحيدة لكل عملية مالية.
 * القيد + سطوره + التدقيق + طابور المزامنة تُكتب داخل معاملة واحدة.
 */
export async function postBusinessTransaction(input: PostEntryInput): Promise<string> {
  const actor = input.user ?? getCurrentUser();
  assertCompanyAccess(actor, input.companyId); // company scope: لا استعلام بلا شركة
  assertCan(actor, input.companyId, 'journal', input.status === 'DRAFT' ? 'create' : 'post');

  assertLineShape(input.lines);
  const totals = assertBalanced(input.lines);
  const now = Date.now();
  const status = input.status ?? 'POSTED';
  const userId = input.createdBy ?? actor.id;

  const savedId = await db.transaction(
    'rw',
    db.journalEntries,
    db.journalLines,
    db.auditLogs,
    db.syncQueue,
    async () => {
      const entryNumber = await nextEntryNumber(input.companyId, input.entryDate);
      const entryId = newId();

      const entry: JournalEntry = {
        id: entryId,
        companyId: input.companyId,
        entryNumber,
        entryDate: input.entryDate,
        description: input.description,
        status,
        sourceType: input.sourceType ?? 'MANUAL',
        sourceId: input.sourceId,
        reversalOfId: input.reversalOfId,
        currency: input.currency ?? 'JOD',
        exchangeRate: input.exchangeRate ?? 1,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
        version: 1,
        syncStatus: 'PENDING',
      };

      const lines: JournalLine[] = input.lines.map((l) => ({
        id: newId(),
        companyId: input.companyId,
        journalEntryId: entryId,
        accountId: l.accountId,
        debit: round2(Number(l.debit || 0)),
        credit: round2(Number(l.credit || 0)),
        currency: entry.currency,
        exchangeRate: entry.exchangeRate,
        description: l.description,
        lineDate: l.lineDate ?? input.entryDate,
        costCenterId: l.costCenterId,
        projectId: l.projectId,
      }));

      await db.journalEntries.add(entry);
      await db.journalLines.bulkAdd(lines);
      await writeAudit(input.companyId, 'journalEntries', entryId, 'POST', undefined, { ...entry, totals, lines }, userId);
      await enqueue(input.companyId, 'CREATE', 'journalEntries', entryId, { entry, lines });
      return entryId;
    },
  );

  if (!input.skipBackup) await createBackup(input.companyId, 'AUTO_AFTER_POST');
  return savedId;
}

/** قيد معاكس: لا يُحذف الأصل، يُوسم REVERSED ويُسجَّل كاملًا في auditLogs. */
export async function reverseEntry(entryId: string, companyId: string, userId?: string, user?: CurrentUser): Promise<string> {
  const actor = user ?? getCurrentUser();
  assertCompanyAccess(actor, companyId);
  assertCan(actor, companyId, 'journal', 'reverse');
  const reversalId = await db.transaction(
    'rw',
    db.journalEntries,
    db.journalLines,
    db.auditLogs,
    db.syncQueue,
    async () => {
      const original = await db.journalEntries.get(entryId);
      if (!original || original.companyId !== companyId) throw new Error('القيد غير موجود');
      const exists = await db.journalEntries.where('reversalOfId').equals(entryId).count();
      if (exists) throw new Error('القيد معكوس مسبقًا');
      if (original.status !== 'POSTED') throw new Error('لا يمكن عكس قيد غير مرحّل');

      const lines = await db.journalLines.where('[companyId+journalEntryId]').equals([companyId, entryId]).toArray();
      const reversalId = await postBusinessTransaction({
        companyId,
        entryDate: new Date().toISOString().slice(0, 10),
        description: `عكس القيد ${original.entryNumber}`,
        sourceType: 'MANUAL',
        reversalOfId: entryId,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          debit: l.credit,
          credit: l.debit,
          description: `عكس: ${l.description ?? ''}`,
          lineDate: l.lineDate,
          costCenterId: l.costCenterId,
          projectId: l.projectId,
        })),
        createdBy: userId ?? actor.id,
        user: actor,
        skipBackup: true,
      });
      await db.journalEntries.update(entryId, {
        status: 'REVERSED',
        updatedAt: Date.now(),
        version: original.version + 1,
        syncStatus: 'PENDING',
      });
      await writeAudit(companyId, 'journalEntries', entryId, 'REVERSE', original, { status: 'REVERSED', reversalId }, userId);
      return reversalId;
    },
  );
  await createBackup(companyId, 'AUTO_AFTER_POST');
  return reversalId;
}

/** إبطال قيد مسودة/مرحّل دون حذفه. */
export async function voidEntry(entryId: string, companyId: string, userId?: string, user?: CurrentUser): Promise<void> {
  const actor = user ?? getCurrentUser();
  assertCompanyAccess(actor, companyId);
  assertCan(actor, companyId, 'journal', 'void');
  const entry = await db.journalEntries.get(entryId);
  if (!entry || entry.companyId !== companyId) throw new Error('القيد غير موجود');
  await db.transaction('rw', db.journalEntries, db.auditLogs, db.syncQueue, async () => {
    await db.journalEntries.update(entryId, { status: 'VOID', updatedAt: Date.now(), version: entry.version + 1, syncStatus: 'PENDING' });
    await writeAudit(companyId, 'journalEntries', entryId, 'VOID', entry, { status: 'VOID' }, userId);
    await enqueue(companyId, 'VOID', 'journalEntries', entryId, { id: entryId });
  });
  await createBackup(companyId, 'AUTO_AFTER_POST');
}
