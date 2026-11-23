export interface BalanceLine {
  debit?: number | string | null;
  credit?: number | string | null;
}

/** تقريب مالي إلى منزلتين — يمنع 0.1 + 0.2 = 0.30000000000000004. */
export function round2(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** القاعدة الإلزامية: مجموع المدين = مجموع الدائن. */
export function assertBalanced<T extends BalanceLine>(lines: T[]): { debit: number; credit: number } {
  if (!lines.length) throw new Error('القيد فارغ');
  const debit = round2(lines.reduce((s, l) => s + Number(l.debit || 0), 0));
  const credit = round2(lines.reduce((s, l) => s + Number(l.credit || 0), 0));
  if (debit !== credit) {
    throw new Error(`القيد غير متوازن: مدين ${debit} ≠ دائن ${credit}`);
  }
  if (debit <= 0) throw new Error('مبلغ القيد يجب أن يكون أكبر من صفر');
  return { debit, credit };
}

/** تحقق إضافي: لا يمكن أن يكون السطر مدينًا ودائنًا في آن واحد. */
export function assertLineShape(lines: BalanceLine[]): void {
  for (const [i, l] of lines.entries()) {
    const d = Number(l.debit || 0);
    const c = Number(l.credit || 0);
    if (d < 0 || c < 0) throw new Error(`السطر ${i + 1}: المبالغ لا تكون سالبة`);
    if (d > 0 && c > 0) throw new Error(`السطر ${i + 1}: لا يمكن أن يكون مدينًا ودائنًا معًا`);
    if (d === 0 && c === 0) throw new Error(`السطر ${i + 1}: فارغ`);
  }
}
