import Dexie, { type Table } from 'dexie';

export type ID = string;
export type SyncStatus = 'LOCAL' | 'PENDING' | 'SYNCED' | 'CONFLICT';
export type EntryStatus = 'DRAFT' | 'POSTED' | 'REVERSED' | 'VOID';
export type SourceType = 'MANUAL' | 'INVOICE' | 'PAYMENT' | 'CHECK' | 'BANK_RECONCILIATION' | 'TAX_RETURN';

export interface Company {
  id: ID;
  name: string;
  slug: string;
  currency: string;
  taxNumber?: string;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: number;
  updatedAt: number;
}

export interface JournalEntry {
  id: ID;
  companyId: ID;
  entryNumber: string;
  entryDate: string;
  description: string;
  status: EntryStatus;
  sourceType: SourceType;
  sourceId?: string;
  reversalOfId?: string;
  currency: string;
  exchangeRate: number;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  syncStatus: SyncStatus;
}

export interface JournalLine {
  id: ID;
  companyId: ID;
  journalEntryId: ID;
  accountId: ID;
  debit: number;
  credit: number;
  currency: string;
  exchangeRate: number;
  description?: string;
  lineDate: string;
  costCenterId?: string;
  projectId?: string;
}

export interface AuditLog {
  id: ID;
  companyId: ID;
  userId?: string;
  tableName: string;
  recordId: string;
  action: 'CREATE' | 'UPDATE' | 'VOID' | 'REVERSE' | 'POST' | 'MIGRATION' | 'RESTORE' | 'BACKUP' | 'IMPORT_REJECTED_UNBALANCED';
  changedAt: number;
  beforeData?: unknown;
  afterData?: unknown;
  deviceId?: string;
}

export interface SyncQueueItem {
  id: ID;
  companyId: ID;
  operation: 'CREATE' | 'UPDATE' | 'VOID';
  tableName: string;
  recordId: string;
  payload: unknown;
  status: 'PENDING' | 'IN_FLIGHT' | 'DONE' | 'FAILED';
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** قاعدة بيانات QAYD — الإصدار 4. كل جدول يحمل companyId صريحًا. */
export class QaydDB extends Dexie {
  users!: Table<any, string>;
  userCompanies!: Table<any, string>;
  companies!: Table<Company, string>;
  companySettings!: Table<any, string>;
  fiscalYears!: Table<any, string>;
  fiscalPeriods!: Table<any, string>;

  accounts!: Table<any, string>;
  journalEntries!: Table<JournalEntry, string>;
  journalLines!: Table<JournalLine, string>;

  partners!: Table<any, string>;
  products!: Table<any, string>;

  invoices!: Table<any, string>;
  invoiceLines!: Table<any, string>;
  payments!: Table<any, string>;
  paymentAllocations!: Table<any, string>;

  checks!: Table<any, string>;
  checkEvents!: Table<any, string>;

  banks!: Table<any, string>;
  bankTransactions!: Table<any, string>;
  taxRates!: Table<any, string>;
  taxReturns!: Table<any, string>;

  inventoryItems!: Table<any, string>;
  warehouses!: Table<any, string>;
  inventoryMovements!: Table<any, string>;

  auditLogs!: Table<AuditLog, string>;
  syncQueue!: Table<SyncQueueItem, string>;
  syncState!: Table<any, string>;
  backups!: Table<any, string>;
  /** حمل النسخة الكاملة في IndexedDB (لا localStorage). */
  backups_data!: Table<{ id: string; payload: unknown }, string>;
  attachments!: Table<any, string>;

  constructor() {
    super('qayd_db');
    this.version(4).stores({
      users: 'id, email, name, status, [email+status]',
      userCompanies: 'id, userId, companyId, role, status, [userId+companyId], [companyId+userId]',
      companies: 'id, name, slug, currency, taxNumber, status, [name+status]',
      companySettings: 'id, companyId, key, value, [companyId+key]',
      fiscalYears: 'id, companyId, startDate, endDate, status, [companyId+status], [companyId+startDate]',
      fiscalPeriods: 'id, companyId, fiscalYearId, startDate, endDate, isClosed, [companyId+isClosed]',

      accounts: 'id, companyId, code, name, type, normalBalance, parentId, currency, status, [companyId+code], [companyId+type], [companyId+parentId], [companyId+status]',
      journalEntries: 'id, companyId, entryNumber, entryDate, description, status, sourceType, sourceId, reversalOfId, currency, exchangeRate, createdBy, createdAt, updatedAt, version, syncStatus, [companyId+entryNumber], [companyId+entryDate], [companyId+status], [companyId+sourceType+sourceId], [companyId+syncStatus]',
      journalLines: 'id, companyId, journalEntryId, accountId, debit, credit, currency, exchangeRate, description, lineDate, costCenterId, projectId, [companyId+journalEntryId], [companyId+accountId+lineDate], [companyId+accountId], [companyId+syncStatus]',

      partners: 'id, companyId, name, partnerType, taxNumber, phone, email, address, openingBalance, openingBalanceDirection, status, [companyId+name], [companyId+partnerType], [companyId+status]',
      products: 'id, companyId, name, sku, unit, salePrice, costPrice, taxRateId, status, [companyId+name], [companyId+sku]',

      invoices: 'id, companyId, invoiceType, invoiceNumber, invoiceDate, dueDate, partnerId, currency, exchangeRate, subtotal, discountTotal, taxTotal, total, paidAmount, creditNoteAmount, balanceDue, status, notes, createdBy, createdAt, updatedAt, version, syncStatus, [companyId+invoiceType+invoiceNumber], [companyId+invoiceDate], [companyId+partnerId], [companyId+status], [companyId+syncStatus]',
      invoiceLines: 'id, companyId, invoiceId, productId, description, quantity, unitPrice, discountRate, discountAmount, taxRateId, taxAmount, lineTotal, [companyId+invoiceId], [companyId+productId]',

      payments: 'id, companyId, paymentType, paymentNumber, paymentDate, partnerId, bankAccountId, currency, exchangeRate, amount, status, reference, notes, createdBy, createdAt, updatedAt, version, syncStatus, [companyId+paymentNumber], [companyId+paymentDate], [companyId+partnerId], [companyId+status], [companyId+syncStatus]',
      paymentAllocations: 'id, companyId, paymentId, invoiceId, amount, currency, exchangeRate, [companyId+paymentId], [companyId+invoiceId]',

      checks: 'id, companyId, checkType, checkNumber, bankId, partnerId, issueDate, dueDate, amount, currency, status, invoiceId, notes, createdBy, createdAt, updatedAt, version, syncStatus, [companyId+checkType+status], [companyId+dueDate], [companyId+partnerId], [companyId+invoiceId], [companyId+syncStatus]',
      checkEvents: 'id, companyId, checkId, eventType, eventDate, amount, journalEntryId, notes, createdBy, createdAt, [companyId+checkId+eventDate], [companyId+checkId]',

      banks: 'id, companyId, name, accountNumber, currency, openingBalance, status, [companyId+name], [companyId+status]',
      bankTransactions: 'id, companyId, bankId, transactionDate, valueDate, description, reference, amount, direction, reconciliationStatus, matchedPaymentId, journalEntryId, [companyId+bankId+transactionDate], [companyId+reconciliationStatus]',
      taxRates: 'id, companyId, name, rate, taxType, appliesTo, isDefault, status, [companyId+taxType], [companyId+isDefault]',
      taxReturns: 'id, companyId, periodStart, periodEnd, status, outputTax, inputTax, netTax, journalEntryId, [companyId+periodStart], [companyId+status]',

      inventoryItems: 'id, companyId, productId, warehouseId, quantity, unitCost, currency, status, [companyId+productId], [companyId+warehouseId]',
      warehouses: 'id, companyId, name, status, [companyId+name]',
      inventoryMovements: 'id, companyId, productId, warehouseId, movementType, movementDate, quantity, unitCost, totalCost, sourceType, sourceId, [companyId+productId+movementDate], [companyId+warehouseId]',

      auditLogs: 'id, companyId, userId, tableName, recordId, action, changedAt, beforeData, afterData, ipAddress, deviceId, [companyId+tableName+recordId], [companyId+changedAt], [companyId+userId]',
      syncQueue: 'id, companyId, operation, tableName, recordId, payload, status, attempts, lastError, createdAt, updatedAt, [companyId+status], [companyId+tableName+recordId]',
      syncState: 'id, companyId, lastPulledAt, lastPushedAt, schemaVersion, [companyId+schemaVersion]',

      backups: 'id, companyId, createdAt, type, sizeBytes, status, storageLocation, checksum, [companyId+createdAt], [companyId+status]',
      backups_data: 'id',
      attachments: 'id, companyId, entityType, entityId, fileName, mimeType, sizeBytes, storageKey, createdAt, [companyId+entityType+entityId]',
    });
  }
}

export const db = new QaydDB();
