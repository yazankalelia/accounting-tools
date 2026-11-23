import { db } from '../db/schema';
import { newId } from '../../utils/id';
import { round2 } from '../ledger/validation';
import { postBusinessTransaction, reverseEntry } from '../ledger/journal.service';
import type { CurrentUser } from '../security/permissions';

export type CheckType = 'INCOMING' | 'OUTGOING';

export interface CreateCheckInput {
  companyId: string;
  checkType: CheckType;
  checkNumber: string;
  partnerId?: string;
  bankId?: string;
  issueDate: string;
  dueDate?: string;
  amount: number;
  notes?: string;
  user?: CurrentUser;
}

/** الشيك يُسجَّل أولًا دون قيد؛ القيد يُنشأ عند التحصيل/الصرف. */
export async function createCheck(input: CreateCheckInput): Promise<string> {
  const id = newId();
  const now = Date.now();
  await db.transaction('rw', db.checks, db.checkEvents, async () => {
    await db.checks.add({
      id,
      companyId: input.companyId,
      checkType: input.checkType,
      checkNumber: input.checkNumber,
      bankId: input.bankId,
      partnerId: input.partnerId,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      amount: round2(input.amount),
      currency: 'JOD',
      status: 'PENDING',
      notes: input.notes,
      createdBy: input.user?.id,
      createdAt: now,
      updatedAt: now,
      version: 1,
      syncStatus: 'PENDING',
    });
    await db.checkEvents.add({
      id: newId(), companyId: input.companyId, checkId: id, eventType: 'CREATED',
      eventDate: input.issueDate, notes: input.notes, createdBy: input.user?.id, createdAt: now,
    });
  });
  return id;
}

/** تحصيل وارد: Dr 1200 / Cr 1300 · صرف صادر: Dr 2100 / Cr 1200 — مع تحديث الشيك وحدثه في نفس المعاملة. */
export async function settleCheck(checkId: string, companyId: string, user?: CurrentUser): Promise<string> {
  const check = await db.checks.get(checkId);
  if (!check || check.companyId !== companyId) throw new Error('الشيك غير موجود');
  if (check.status !== 'PENDING') throw new Error('الشيك مُسوَّى مسبقًا');

  const entryId = newId();
  const today = new Date().toISOString().slice(0, 10);
  const amount = round2(Number(check.amount));
  const incoming = check.checkType === 'INCOMING';

  await postBusinessTransaction({
    companyId,
    entryId,
    entryDate: today,
    description: `${incoming ? 'تحصيل' : 'صرف'} شيك ${check.checkNumber}`,
    sourceType: 'CHECK',
    sourceId: checkId,
    user,
    lines: incoming
      ? [{ accountId: '1200', debit: amount, credit: 0, description: 'البنك' },
         { accountId: '1300', debit: 0, credit: amount, description: 'المدينون' }]
      : [{ accountId: '2100', debit: amount, credit: 0, description: 'الدائنون' },
         { accountId: '1200', debit: 0, credit: amount, description: 'البنك' }],
    extraWrites: async (tx) => {
      await tx.table('checks').update(checkId, {
        status: incoming ? 'COLLECTED' : 'PAID',
        updatedAt: Date.now(),
        version: Number((check as any).version || 1) + 1,
        syncStatus: 'PENDING',
      });
      await tx.table('checkEvents').add({
        id: newId(), companyId, checkId, eventType: incoming ? 'COLLECTED' : 'PAID',
        eventDate: today, amount, journalEntryId: entryId, createdBy: user?.id, createdAt: Date.now(),
      });
    },
  });
  return entryId;
}

/** ارتداد الشيك: قيد معاكس + تحديث الحالة + حدث تدقيقي. */
export async function bounceCheck(checkId: string, companyId: string, user?: CurrentUser): Promise<void> {
  const check = await db.checks.get(checkId);
  if (!check || check.companyId !== companyId) throw new Error('الشيك غير موجود');
  if (check.status !== 'COLLECTED' && check.status !== 'PAID') throw new Error('لا يمكن ارتداد شيك غير مُسوَّى');

  const settle = await db.journalEntries
    .where('[companyId+sourceType+sourceId]')
    .equals([companyId, 'CHECK', checkId])
    .first();
  if (settle) await reverseEntry(settle.id, companyId, undefined, user);

  await db.transaction('rw', db.checks, db.checkEvents, async () => {
    await db.checks.update(checkId, {
      status: 'BOUNCED', updatedAt: Date.now(),
      version: Number((check as any).version || 1) + 1, syncStatus: 'PENDING',
    });
    await db.checkEvents.add({
      id: newId(), companyId, checkId, eventType: 'BOUNCED',
      eventDate: new Date().toISOString().slice(0, 10),
      amount: round2(Number(check.amount)), journalEntryId: settle?.id,
      createdBy: user?.id, createdAt: Date.now(),
    });
  });
}
