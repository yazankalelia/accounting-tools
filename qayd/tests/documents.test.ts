import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/core/db/schema';
import { newId } from '../src/utils/id';
import { postBusinessTransaction } from '../src/core/ledger/journal.service';
import { createInvoice } from '../src/core/invoices/invoice.service';
import { recordPayment } from '../src/core/payments/payment.service';
import { createCheck, settleCheck, bounceCheck } from '../src/core/checks/check.service';
import { type CurrentUser } from '../src/core/security/permissions';

const CID = 'company_docs';

const owner: CurrentUser = {
  id: 'acc-1',
  memberships: [{ id: 'uc1', userId: 'acc-1', companyId: CID, role: 'ACCOUNTANT', status: 'ACTIVE' }],
};
const dataEntry: CurrentUser = {
  id: 'de-1',
  memberships: [{ id: 'uc2', userId: 'de-1', companyId: CID, role: 'DATA_ENTRY', status: 'ACTIVE' }],
};

beforeEach(async () => {
  await db.delete();
  await db.open();
  const now = Date.now();
  await db.companies.put({ id: CID, name: 'شركة', slug: 's', currency: 'JOD', status: 'ACTIVE', createdAt: now, updatedAt: now });
});

describe('المستندات والقيود في معاملة واحدة', () => {
  it('فاتورة مبيعات 2×500 + 15% تنشئ الفاتورة والقيد معًا', async () => {
    const r = await createInvoice({
      companyId: CID, partnerId: 'p1', type: 'SALE', invoiceDate: '2026-11-23',
      items: [{ description: 'صنف', quantity: 2, unitPrice: 500 }],
      taxRate: 15, user: owner,
    });
    const inv: any = await db.invoices.get(r.invoiceId);
    expect(inv.invoiceNumber).toMatch(/^F-2026-\d{4}$/);
    expect(inv.total).toBe(1150);
    expect(inv.taxTotal).toBe(150);

    const lines = await db.journalLines.where('[companyId+journalEntryId]').equals([CID, r.entryId]).toArray();
    const pairs = lines.map((l) => ({ acc: l.accountId, d: l.debit, c: l.credit }));
    expect(pairs).toEqual(expect.arrayContaining([
      { acc: '1300', d: 1150, c: 0 },
      { acc: '4100', d: 0, c: 1000 },
      { acc: '2200', d: 0, c: 150 },
    ]));
    expect(await db.invoiceLines.where('invoiceId').equals(r.invoiceId).count()).toBe(1);
    const entry = await db.journalEntries.get(r.entryId);
    expect(entry?.sourceType).toBe('INVOICE');
    expect(entry?.sourceId).toBe(r.invoiceId);
  });

  it('فاتورة مشتريات: Dr مصروف + Dr 2210 / Cr 2100', async () => {
    const r = await createInvoice({
      companyId: CID, partnerId: 'p2', type: 'PURCHASE', invoiceDate: '2026-11-23',
      items: [{ description: 'مصنوع', quantity: 1, unitPrice: 1000 }],
      taxRate: 15, user: owner,
    });
    const lines = await db.journalLines.where('[companyId+journalEntryId]').equals([CID, r.entryId]).toArray();
    expect(lines.map((l) => ({ acc: l.accountId, d: l.debit, c: l.credit }))).toEqual(expect.arrayContaining([
      { acc: '5100', d: 1000, c: 0 },
      { acc: '2210', d: 150, c: 0 },
      { acc: '2100', d: 0, c: 1150 },
    ]));
  });

  it('فشل كتابة المستند يُرجع القيد كاملًا (ذرّية)', async () => {
    const invoiceId = newId();
    await expect(postBusinessTransaction({
      companyId: CID, entryDate: '2026-11-23', description: 'فشل متعمّد', user: owner,
      lines: [{ accountId: '1100', debit: 10 }, { accountId: '4100', credit: 10 }],
      extraWrites: async (tx) => {
        await tx.table('invoices').add({ id: invoiceId, companyId: CID, invoiceNumber: 'X-1', total: 10 });
        throw new Error('فشل المستند');
      },
    })).rejects.toThrow('فشل المستند');
    expect(await db.invoices.get(invoiceId)).toBeUndefined();
    expect(await db.journalEntries.where('companyId').equals(CID).count()).toBe(0);
    expect(await db.journalLines.count()).toBe(0);
  });

  it('القبض يسجّل الدفعة والتخصيص والقيد ويحدّث رصيد الفاتورة', async () => {
    const inv = await createInvoice({
      companyId: CID, partnerId: 'p1', type: 'SALE', invoiceDate: '2026-11-23',
      items: [{ description: 'خدمة', quantity: 1, unitPrice: 1000 }], taxRate: 15, user: owner,
    });
    const pay = await recordPayment({
      companyId: CID, partnerId: 'p1', amount: 1150, paymentDate: '2026-11-24',
      type: 'RECEIPT', invoiceId: inv.invoiceId, user: owner,
    });
    const lines = await db.journalLines.where('[companyId+journalEntryId]').equals([CID, pay.entryId]).toArray();
    expect(lines.map((l) => ({ acc: l.accountId, d: l.debit, c: l.credit }))).toEqual(expect.arrayContaining([
      { acc: '1200', d: 1150, c: 0 }, { acc: '1300', d: 0, c: 1150 },
    ]));
    expect(await db.paymentAllocations.where('paymentId').equals(pay.paymentId).count()).toBe(1);
    const updated: any = await db.invoices.get(inv.invoiceId);
    expect(updated.paidAmount).toBe(1150);
    expect(updated.balanceDue).toBe(0);
  });

  it('تحصيل شيك وارد ثم ارتداده ينشئ قيدًا معاكسًا', async () => {
    const checkId = await createCheck({
      companyId: CID, checkType: 'INCOMING', checkNumber: '2511', partnerId: 'p1',
      issueDate: '2026-11-23', dueDate: '2026-11-30', amount: 5000, user: owner,
    });
    const entryId = await settleCheck(checkId, CID, owner);
    const check: any = await db.checks.get(checkId);
    expect(check.status).toBe('COLLECTED');
    const lines = await db.journalLines.where('[companyId+journalEntryId]').equals([CID, entryId]).toArray();
    expect(lines.map((l) => ({ acc: l.accountId, d: l.debit, c: l.credit }))).toEqual(expect.arrayContaining([
      { acc: '1200', d: 5000, c: 0 }, { acc: '1300', d: 0, c: 5000 },
    ]));

    await bounceCheck(checkId, CID, owner);
    expect((await db.checks.get(checkId))?.status).toBe('BOUNCED');
    const reversals = await db.journalEntries.where('reversalOfId').equals(entryId).count();
    expect(reversals).toBe(1);
  });

  it('DATA_ENTRY لا يستطيع ترحيل فاتورة', async () => {
    await expect(createInvoice({
      companyId: CID, partnerId: 'p1', type: 'SALE', invoiceDate: '2026-11-23',
      items: [{ description: 'صنف', quantity: 1, unitPrice: 10 }], user: dataEntry,
    })).rejects.toThrow('لا تملك صلاحية post على journal');
    expect(await db.invoices.count()).toBe(0);
  });
});
