import { db } from './schema';

export { db };

export const ACTIVE_COMPANY_KEY = 'qayd:activeCompany';

/** الشركة النشطة محليًا. يمكن أن تتغير بتبديل الشركة دون إعادة تحميل الصفحة. */
export function getActiveCompanyId(): string {
  try {
    return localStorage.getItem(ACTIVE_COMPANY_KEY) || '';
  } catch {
    return '';
  }
}

export function setActiveCompanyId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_COMPANY_KEY, id);
  } catch {
    /* الوضع الخاص/التصفح الخفي */
  }
}

/** مرشّح يُحقن companyId في أي استعلام. */
export function companyFilter<T extends { companyId?: string }>(companyId: string) {
  return (row: T): boolean => row.companyId === companyId;
}

/** كل الجداول التي تحمل companyId (للنسخ الاحتياطي والمزامنة). */
export const COMPANY_TABLES = [
  'users', 'userCompanies', 'companies', 'companySettings', 'fiscalYears', 'fiscalPeriods',
  'accounts', 'journalEntries', 'journalLines', 'partners', 'products',
  'invoices', 'invoiceLines', 'payments', 'paymentAllocations', 'checks', 'checkEvents',
  'banks', 'bankTransactions', 'taxRates', 'taxReturns',
  'inventoryItems', 'warehouses', 'inventoryMovements',
  'auditLogs', 'syncQueue', 'syncState', 'backups', 'attachments',
] as const;
