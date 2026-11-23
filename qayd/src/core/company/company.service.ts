import { db, type Company } from '../db/schema';
import { newId } from '../../utils/id';
import { writeAudit } from '../security/audit.service';
import { getCurrentUser } from '../security/auth.service';
import { assertCan, type CurrentUser } from '../security/permissions';

export interface CreateCompanyInput {
  name: string;
  currency?: string;
  taxNumber?: string;
  user?: CurrentUser;
}

/** إنشاء شركة + عضوية OWNER للمستخدم الحالي + سطر تدقيق، في معاملة واحدة. */
export async function createCompany(input: CreateCompanyInput): Promise<Company> {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('اسم الشركة مطلوب');
  const id = newId();
  const actor = input.user ?? getCurrentUser();
  assertCan(actor, id, 'company', 'manage');

  const now = Date.now();
  const company: Company = {
    id,
    name,
    slug: name.replace(/\s+/g, '-').slice(0, 40).toLowerCase(),
    currency: input.currency || 'JOD',
    taxNumber: input.taxNumber || undefined,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };

  await db.transaction('rw', db.companies, db.userCompanies, db.auditLogs, async () => {
    await db.companies.add(company);
    await db.userCompanies.add({
      id: newId(), userId: actor.id, companyId: id, role: 'OWNER', status: 'ACTIVE',
    });
    await writeAudit(id, 'companies', id, 'CREATE', undefined, company, actor.id);
  });
  return company;
}

/** الشركات التي يملك المستخدم عضوية فعّالة فيها فقط — لا تُعرض كل الشركات. */
export async function listCompanies(user?: CurrentUser): Promise<Company[]> {
  const actor = user ?? getCurrentUser();
  const memberships = await db.userCompanies.where('userId').equals(actor.id).toArray();
  const activeIds = memberships
    .filter((m) => m.status === 'ACTIVE' && m.companyId !== '*')
    .map((m) => m.companyId);
  const wildcard = actor.id === 'local-user' && (
    memberships.some((m) => m.companyId === '*' && m.status === 'ACTIVE') ||
    actor.memberships.some((m) => m.companyId === '*' && m.status === 'ACTIVE')
  );

  const rows = wildcard
    ? await db.companies.toArray()
    : ((await db.companies.bulkGet(activeIds)).filter(Boolean) as Company[]);
  return rows
    .filter((c) => c.status === 'ACTIVE')
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function renameCompany(id: string, name: string, user?: CurrentUser): Promise<void> {
  const actor = user ?? getCurrentUser();
  assertCan(actor, id, 'company', 'manage');
  const old = await db.companies.get(id);
  if (!old) throw new Error('الشركة غير موجودة');
  await db.companies.update(id, { name, updatedAt: Date.now() });
  await writeAudit(id, 'companies', id, 'UPDATE', old, { name }, actor.id);
}
