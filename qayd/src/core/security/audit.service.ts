import { db, type AuditLog } from '../db/schema';
import { newId } from '../../utils/id';
import { getCurrentUser } from './auth.service';
import { assertCan, assertCompanyAccess, type CurrentUser } from './permissions';

export type AuditAction = AuditLog['action'];

export async function writeAudit(
  companyId: string,
  tableName: string,
  recordId: string,
  action: AuditAction,
  beforeData?: unknown,
  afterData?: unknown,
  userId?: string,
): Promise<void> {
  await db.auditLogs.add({
    id: newId(),
    companyId,
    userId,
    tableName,
    recordId,
    action,
    changedAt: Date.now(),
    beforeData,
    afterData,
    deviceId: 'local',
  });
}

/** سجل التدقيق append-only: لا يُوفّر تعديل أو حذف. */
export async function auditSince(companyId: string, since = 0, user?: CurrentUser): Promise<AuditLog[]> {
  const actor = user ?? getCurrentUser();
  assertCompanyAccess(actor, companyId);
  assertCan(actor, companyId, 'audit', 'view');
  return db.auditLogs.where('[companyId+changedAt]').between([companyId, since], [companyId, Date.now() + 1]).toArray();
}
