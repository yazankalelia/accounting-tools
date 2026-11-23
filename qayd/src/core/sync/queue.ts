import { db, type SyncQueueItem } from '../db/schema';
import { newId } from '../../utils/id';

/** outbox: يُستدعى داخل نفس المعاملة التي تكتب فيها العملية المالية. */
export async function enqueue(
  companyId: string,
  operation: SyncQueueItem['operation'],
  tableName: string,
  recordId: string,
  payload: unknown,
): Promise<void> {
  const now = Date.now();
  await db.syncQueue.add({
    id: newId(),
    companyId,
    operation,
    tableName,
    recordId,
    payload,
    status: 'PENDING',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
}

export async function pendingCount(companyId: string): Promise<number> {
  return db.syncQueue.where('[companyId+status]').equals([companyId, 'PENDING']).count();
}
