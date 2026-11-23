import { db } from '../db/schema';
import { newId } from '../../utils/id';
import { round2 } from '../ledger/validation';
import { postBusinessTransaction } from '../ledger/journal.service';
import type { CurrentUser } from '../security/permissions';

export type InvoiceType = 'SALE' | 'PURCHASE';

export interface InvoiceItemInput {
  description: string;
  quantity: number;
  unitPrice: number;
  /** حساب الإيراد للمبيعات أو المصروف للمشتريات؛ الافتراضي 4100 / 5100. */
  accountId?: string;
}

export interface CreateInvoiceInput {
  companyId: string;
  partnerId: string;
  type: InvoiceType;
  invoiceDate: string;
  items: InvoiceItemInput[];
  taxRate?: number;          // نسبة مئوية؛ الافتراضي 15
  currency?: string;
  notes?: string;
  user?: CurrentUser;
}

export interface CreatedInvoice {
  invoiceId: string;
  entryId: string;
  invoiceNumber: string;
  total: number;
  taxTotal: number;
}

async function nextInvoiceNumber(companyId: string, type: InvoiceType, date: string): Promise<string> {
  const prefix = `${type === 'SALE' ? 'F' : 'P'}-${date.slice(0, 4)}-`;
  const last = await db.invoices
    .where('[companyId+invoiceType+invoiceNumber]')
    .between([companyId, type, prefix], [companyId, type, prefix + '\uffff'])
    .last();
  const n = last ? Number(last.invoiceNumber.split('-').pop() || 0) + 1 : 1;
  return `${prefix}${String(n).padStart(4, '0')}`;
}

/**
 * الفاتورة وسطورها والقيد المرحّل تُكتب داخل معاملة واحدة.
 * مبيعات: Dr 1300 / Cr إيراد + Cr 2200 · مشتريات: Dr مصروف + Dr 2210 / Cr 2100.
 */
export async function createInvoice(input: CreateInvoiceInput): Promise<CreatedInvoice> {
  if (!input.items.length) throw new Error('الفاتورة بلا بنود');
  const rate = input.taxRate ?? 15;
  const subtotal = round2(input.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0));
  const taxTotal = round2(subtotal * rate / 100);
  const total = round2(subtotal + taxTotal);

  const invoiceId = newId();
  const invoiceNumber = await nextInvoiceNumber(input.companyId, input.type, input.invoiceDate);
  const now = Date.now();
  const currency = input.currency ?? 'JOD';

  const invoice = {
    id: invoiceId,
    companyId: input.companyId,
    invoiceType: input.type,
    invoiceNumber,
    invoiceDate: input.invoiceDate,
    partnerId: input.partnerId,
    currency,
    exchangeRate: 1,
    subtotal,
    discountTotal: 0,
    taxTotal,
    total,
    paidAmount: 0,
    creditNoteAmount: 0,
    balanceDue: total,
    status: 'POSTED',
    notes: input.notes,
    createdBy: input.user?.id,
    createdAt: now,
    updatedAt: now,
    version: 1,
    syncStatus: 'PENDING',
  };

  const lines = input.items.map((i) => ({
    id: newId(),
    companyId: input.companyId,
    invoiceId,
    description: i.description,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
    discountRate: 0,
    discountAmount: 0,
    taxRate: rate,
    taxAmount: round2(i.quantity * i.unitPrice * rate / 100),
    lineTotal: round2(i.quantity * i.unitPrice),
  }));

  const journalLines = input.type === 'SALE'
    ? [
        { accountId: '1300', debit: total, credit: 0, description: `فاتورة ${invoiceNumber}` },
        { accountId: input.items[0].accountId ?? '4100', debit: 0, credit: subtotal, description: 'إيرادات المبيعات' },
        ...(taxTotal > 0 ? [{ accountId: '2200', debit: 0, credit: taxTotal, description: 'ضريبة المخرجات' }] : []),
      ]
    : [
        { accountId: input.items[0].accountId ?? '5100', debit: subtotal, credit: 0, description: 'مصروف مشتريات' },
        ...(taxTotal > 0 ? [{ accountId: '2210', debit: taxTotal, credit: 0, description: 'ضريبة المدخلات' }] : []),
        { accountId: '2100', debit: 0, credit: total, description: `فاتورة ${invoiceNumber}` },
      ];

  const entryId = await postBusinessTransaction({
    companyId: input.companyId,
    entryDate: input.invoiceDate,
    description: `فاتورة ${input.type === 'SALE' ? 'مبيعات' : 'مشتريات'} ${invoiceNumber}`,
    sourceType: 'INVOICE',
    sourceId: invoiceId,
    currency,
    user: input.user,
    lines: journalLines,
    extraWrites: async (tx) => {
      await tx.table('invoices').add(invoice);
      await tx.table('invoiceLines').bulkAdd(lines);
    },
  });

  return { invoiceId, entryId, invoiceNumber, total, taxTotal };
}

export async function listInvoices(companyId: string): Promise<any[]> {
  return db.invoices.where('companyId').equals(companyId).reverse().sortBy('invoiceDate');
}
