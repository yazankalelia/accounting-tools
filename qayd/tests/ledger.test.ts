import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/core/db/schema';
import { postBusinessTransaction, reverseEntry } from '../src/core/ledger/journal.service';
import { assertBalanced } from '../src/core/ledger/validation';
import { getAccountBalance, trialBalance } from '../src/core/ledger/balance.service';

const CID = 'test-company';

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('القيد المزدوج', () => {
  it('يرفض القيد غير المتوازن', () => {
    expect(() => assertBalanced([
      { debit: 100, credit: 0 },
      { debit: 0, credit: 99 },
    ])).toThrow('القيد غير متوازن');
  });

  it('يتعامل مع 0.1 + 0.2 دون انحراف عائم', () => {
    const r = assertBalanced([{ debit: 0.3, credit: 0 }, { debit: 0, credit: 0.1 }, { debit: 0, credit: 0.2 }]);
    expect(r.debit).toBe(0.3);
    expect(r.credit).toBe(0.3);
  });

  it('يمنع سطرًا مدينًا ودائنًا معًا', async () => {
    await expect(postBusinessTransaction({
      companyId: CID,
      entryDate: '2026-11-23',
      description: 'قيد خاطئ',
      lines: [{ accountId: '1300', debit: 10, credit: 10 }],
    })).rejects.toThrow('لا يمكن أن يكون مدينًا ودائنًا معًا');
  });

  it('يرحّل فاتورة مبيعات 1000 + 15% بثلاثة سطور', async () => {
    const id = await postBusinessTransaction({
      companyId: CID,
      entryDate: '2026-11-23',
      description: 'فاتورة مبيعات F-2026-0001',
      sourceType: 'INVOICE',
      sourceId: 'F-2026-0001',
      lines: [
        { accountId: '1300', debit: 1150, credit: 0 },
        { accountId: '4100', debit: 0, credit: 1000 },
        { accountId: '2200', debit: 0, credit: 150 },
      ],
    });
    const entry = await db.journalEntries.get(id);
    const lines = await db.journalLines.where('[companyId+journalEntryId]').equals([CID, id]).toArray();
    expect(entry?.status).toBe('POSTED');
    expect(entry?.sourceType).toBe('INVOICE');
    expect(entry?.entryNumber).toMatch(/^JE-202611-\d{4}$/);
    expect(lines).toHaveLength(3);
    expect(await getAccountBalance(CID, '1300')).toBe(1150);
  });

  it('ينشئ قيدًا معاكسًا ويعيد الرصيد إلى صفر', async () => {
    const id = await postBusinessTransaction({
      companyId: CID,
      entryDate: '2026-11-23',
      description: 'تحصيل شيك',
      sourceType: 'CHECK',
      lines: [
        { accountId: '1200', debit: 1150 },
        { accountId: '1300', credit: 1150 },
      ],
    });
    const reversalId = await reverseEntry(id, CID, 'test-user');
    const original = await db.journalEntries.get(id);
    const reversalLines = await db.journalLines.where('[companyId+journalEntryId]').equals([CID, reversalId]).toArray();
    expect(original?.status).toBe('REVERSED');
    const pairs = reversalLines.map((l) => [l.debit, l.credit]).sort((a, b) => a[0] - b[0]);
    expect(pairs).toEqual([[0, 1150], [1150, 0]]);
    expect(await getAccountBalance(CID, '1200')).toBe(0);
    expect(await getAccountBalance(CID, '1300')).toBe(0);
  });

  it('يمنع عكس القيد مرتين', async () => {
    const id = await postBusinessTransaction({
      companyId: CID,
      entryDate: '2026-11-23',
      description: 'قيد',
      lines: [{ accountId: '1100', debit: 5 }, { accountId: '4100', credit: 5 }],
    });
    await reverseEntry(id, CID);
    await expect(reverseEntry(id, CID)).rejects.toThrow('معكوس مسبقًا');
  });

  it('يحسب ميزان المراجعة من السطور لا من رصيد مخزّن', async () => {
    await postBusinessTransaction({
      companyId: CID,
      entryDate: '2026-11-23',
      description: 'قيد',
      lines: [{ accountId: '1100', debit: 100 }, { accountId: '4100', credit: 100 }],
    });
    const rows = await trialBalance(CID);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.debit, 0)).toBe(100);
    expect(rows.reduce((s, r) => s + r.credit, 0)).toBe(100);
  });
});
