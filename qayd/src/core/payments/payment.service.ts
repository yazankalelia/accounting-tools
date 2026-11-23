import { db } from '../db/schema';
import { newId } from '../../utils/id';
import { round2 } from '../ledger/validation';
import { postBusinessTransaction } from '../ledger/journal.service';
import type { CurrentUser } from '../security/permissions';

export type PaymentType = 'RECEIPT' | 'PAYMENT';

export interface RecordPaymentInput {
  companyId: string;
  partnerId: string;
  amount: number;
  paymentDate: string;
  type: PaymentType;
  /** فاتورة تُسوَّى جزئيًا أو كليًا بهذه الدفعة (اختياري). */
  invoiceId?: string;
  bankAccountId?: string;
  reference?: string;
  notes?: string;
  user?: CurrentUser;
}

async function nextPaymentNumber(companyId: string, date: string): Promise<string> {
  const prefix = `PM-${date.slice(0, 4)}-`;
  const last = await db.payments
    .where('[companyId+paymentNumber]')
    .between([companyId, prefix], [companyId, prefix + '\uffff'])
    .last();
  const n = last ? Number(last.paymentNumber.split('-').pop() || 0) + 1 : 1;
  return `${prefix}${String(n).padStart(4, '0')}`;
}

/** الدفعة + تخصيصها + القيد تُكتب في معاملة واحدة.
 *  RECEIPT: Dr 1200 / Cr 1300 · PAYMENT: Dr 2100 / Cr 1200. */
export async function recordPayment(input: RecordPaymentInput): Promise<{ paymentId: string; entryId: string; paymentNumber: string }> {
  const amount = round2(Number(input.amount));
  if (amount <= 0) throw new Error('مبلغ الدفعة يجب أن يكون أكبر من صفر');

  const paymentId = newId();
  const paymentNumber = await nextPaymentNumber(input.companyId, input.paymentDate);
  const now = Date.now();
  const payment = {
    id: paymentId,
    companyId: input.companyId,
    paymentType: input.type,
    paymentNumber,
    paymentDate: input.paymentDate,
    partnerId: input.partnerId,
    bankAccountId: input.bankAccountId ?? '1200',
    currency: 'JOD',
    exchangeRate: 1,
    amount,
    status: 'POSTED',
    reference: input.reference,
    notes: input.notes,
    createdBy: input.user?.id,
    createdAt: now,
    updatedAt: now,
    version: 1,
    syncStatus: 'PENDING',
  };
  const allocation = input.invoiceId ? [{
    id: newId(),
    companyId: input.companyId,
    paymentId,
    invoiceId: input.invoiceId,
    amount,
    currency: 'JOD',
    exchangeRate: 1,
  }] : [];

  const entryId = await postBusinessTransaction({
    companyId: input.companyId,
    entryDate: input.paymentDate,
    description: `${input.type === 'RECEIPT' ? 'قبض' : 'دفع'} ${paymentNumber}`,
    sourceType: 'PAYMENT',
    sourceId: paymentId,
    user: input.user,
    lines: input.type === 'RECEIPT'
      ? [{ accountId: input.bankAccountId ?? '1200', debit: amount, credit: 0, description: 'البنك' },
         { accountId: '1300', debit: 0, credit: amount, description: 'المدينون' }]
      : [{ accountId: '2100', debit: amount, credit: 0, description: 'الدائنون' },
         { accountId: input.bankAccountId ?? '1200', debit: 0, credit: amount, description: 'البنك' }],
    extraWrites: async (tx) => {
      await tx.table('payments').add(payment);
      if (allocation.length) await tx.table('paymentAllocations').bulkAdd(allocation);
    },
  });

  if (input.invoiceId) {
    const inv = await db.invoices.get(input.invoiceId);
    if (inv && inv.companyId === input.companyId) {
      const paid = round2(Number((inv as any).paidAmount || 0) + amount);
      await db.invoices.update(input.invoiceId, {
        paidAmount: paid,
        balanceDue: round2(Number((inv as any).total || 0) - paid),
        updatedAt: Date.now(),
        version: Number((inv as any).version || 1) + 1,
        syncStatus: 'PENDING',
      });
    }
  }

  return { paymentId, entryId, paymentNumber };
}
