import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/core/db/schema';
import { createInvoice } from '../src/core/invoices/invoice.service';
import { recordPayment } from '../src/core/payments/payment.service';
import { incomeStatement, balanceSheet, cashFlow } from '../src/core/reports/financial-reports.service';
import { type CurrentUser } from '../src/core/security/permissions';

const CID = 'company_reports';
const accountant: CurrentUser = {
  id: 'a1',
  memberships: [{ id: 'uc1', userId: 'a1', companyId: CID, role: 'ACCOUNTANT', status: 'ACTIVE' }],
};
const dataEntry: CurrentUser = {
  id: 'd1',
  memberships: [{ id: 'uc2', userId: 'd1', companyId: CID, role: 'DATA_ENTRY', status: 'ACTIVE' }],
};

beforeEach(async () => {
  await db.delete();
  await db.open();
  const now = Date.now();
  await db.companies.put({ id: CID, name: 'شركة', slug: 's', currency: 'JOD', status: 'ACTIVE', createdAt: now, updatedAt: now });
});

describe('التقارير المالية', () => {
  it('قائمة الدخل من القيود المرحّلة', async () => {
    await createInvoice({
      companyId: CID, partnerId: 'p1', type: 'SALE', invoiceDate: '2026-11-23',
      items: [{ description: 'بيع', quantity: 1, unitPrice: 1000 }], taxRate: 15, user: accountant,
    });
    const r = await incomeStatement(CID, '2026-11-01', '2026-11-30', accountant);
    expect(r.revenue).toBe(1000);
    expect(r.expenses).toBe(0);
    expect(r.netIncome).toBe(1000);
  });

  it('الميزانية العمومية متوازنة بعد فاتورة مبيعات', async () => {
    await createInvoice({
      companyId: CID, partnerId: 'p1', type: 'SALE', invoiceDate: '2026-11-23',
      items: [{ description: 'بيع', quantity: 1, unitPrice: 1000 }], taxRate: 15, user: accountant,
    });
    const r = await balanceSheet(CID, '2026-11-30', accountant);
    expect(r.assets).toBe(1150);   // المدينون
    expect(r.liabilities).toBe(150); // ضريبة المخرجات
    expect(r.equity).toBe(1000);    // الأرباح المحتجزة
    expect(r.balanced).toBe(true);
  });

  it('قائمة التدفقات غير المباشرة تُحسب من صافي الربح والتغير في الذمم', async () => {
    const inv = await createInvoice({
      companyId: CID, partnerId: 'p1', type: 'SALE', invoiceDate: '2026-11-23',
      items: [{ description: 'بيع', quantity: 1, unitPrice: 1000 }], taxRate: 15, user: accountant,
    });
    await recordPayment({
      companyId: CID, partnerId: 'p1', amount: 1150, paymentDate: '2026-11-24',
      type: 'RECEIPT', invoiceId: inv.invoiceId, user: accountant,
    });
    const r = await cashFlow(CID, '2026-11-01', '2026-11-30', accountant);
    expect(r.netIncome).toBe(1000);
    expect(r.changeInReceivables).toBe(0);
    expect(r.operatingCashFlow).toBe(1000);
  });

  it('DATA_ENTRY لا يستطيع عرض التقارير', async () => {
    await expect(incomeStatement(CID, undefined, undefined, dataEntry)).rejects.toThrow('reports');
    await expect(balanceSheet(CID, undefined, dataEntry)).rejects.toThrow('reports');
  });
});
