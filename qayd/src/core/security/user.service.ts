import { db } from '../db/schema';
import { newId } from '../../utils/id';
import { writeAudit } from './audit.service';
import { getCurrentUser } from './auth.service';
import { assertCan, ROLE_PERMISSIONS, type CurrentUser, type PermissionMap, type Role } from './permissions';

export interface CreateUserInput {
  name: string;
  email?: string;
  companyId: string;
  role: Role;
  permissions?: PermissionMap;
  user?: CurrentUser;
}

export async function createUser(input: CreateUserInput): Promise<string> {
  const actor = input.user ?? getCurrentUser();
  assertCan(actor, input.companyId, 'users', 'manage');
  if (!input.role || !ROLE_PERMISSIONS[input.role]) throw new Error('دور غير صالح');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('اسم المستخدم مطلوب');

  const id = newId();
  const now = Date.now();
  await db.transaction('rw', db.users, db.userCompanies, db.auditLogs, async () => {
    await db.users.add({
      id, name, email: input.email || undefined,
      status: 'ACTIVE', createdAt: now, updatedAt: now,
    });
    await db.userCompanies.add({
      id: newId(), userId: id, companyId: input.companyId,
      role: input.role, status: 'ACTIVE',
      ...(input.permissions ? { permissions: input.permissions } : {}),
    });
    await writeAudit(input.companyId, 'users', id, 'CREATE', undefined,
      { name, email: input.email, role: input.role }, actor.id);
  });
  return id;
}

export async function setUserRole(
  userId: string, companyId: string, role: Role, permissions?: PermissionMap, user?: CurrentUser,
): Promise<void> {
  const actor = user ?? getCurrentUser();
  assertCan(actor, companyId, 'users', 'manage');
  if (!ROLE_PERMISSIONS[role]) throw new Error('دور غير صالح');
  const membership = await db.userCompanies.where('[userId+companyId]').equals([userId, companyId]).first();
  if (!membership) throw new Error('المستخدم ليس عضوًا في هذه الشركة');
  await db.userCompanies.update(membership.id, { role, permissions });
  await writeAudit(companyId, 'users', userId, 'UPDATE', { role: membership.role }, { role }, actor.id);
}

export async function suspendUser(userId: string, companyId: string, suspended: boolean, user?: CurrentUser): Promise<void> {
  const actor = user ?? getCurrentUser();
  assertCan(actor, companyId, 'users', 'manage');
  const membership = await db.userCompanies.where('[userId+companyId]').equals([userId, companyId]).first();
  if (!membership) throw new Error('العضوية غير موجودة');
  await db.userCompanies.update(membership.id, { status: suspended ? 'SUSPENDED' : 'ACTIVE' });
  await writeAudit(companyId, 'users', userId, 'UPDATE', { status: membership.status },
    { status: suspended ? 'SUSPENDED' : 'ACTIVE' }, actor.id);
}

/** المستخدمون المرتبطون بشركة واحدة فقط، بلا أي حقل سري. */
export async function listUsers(companyId: string, user?: CurrentUser): Promise<Array<any>> {
  const actor = user ?? getCurrentUser();
  assertCan(actor, companyId, 'users', 'view');

  const memberships = await db.userCompanies.where('companyId').equals(companyId).toArray();
  const users = await db.users.bulkGet(memberships.map((m) => m.userId));
  const secrets = ['password', 'passwordHash', 'password_hash', 'hash', 'secret', 'pin', 'token'];
  return users.filter(Boolean).map((u) => {
    const clean: Record<string, any> = { ...(u as Record<string, any>) };
    for (const key of secrets) delete clean[key];
    const own = memberships.filter((m) => m.userId === clean.id);
    return {
      ...clean,
      memberships: own,
      companyRole: own[0]?.role,
      companyStatus: own[0]?.status,
    };
  });
}

export async function listMemberships(companyId: string): Promise<any[]> {
  return db.userCompanies.where('companyId').equals(companyId).toArray();
}
