/** الأدوار والصلاحيات — الطبقة الأولى: الدور يحدد الصلاحية. */
export type Role = 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'AUDITOR' | 'DATA_ENTRY' | 'VIEWER';
export type Action = 'view' | 'create' | 'edit_draft' | 'post' | 'reverse' | 'void' | 'export' | 'manage' | 'delete' | 'restore' | 'create_backup';
export type Resource = 'company' | 'users' | 'settings' | 'journal' | 'invoices' | 'payments' | 'checks' | 'reports' | 'audit' | 'backup';

export type PermissionMap = Partial<Record<Resource, Action[]>>;

export interface Membership {
  id: string;
  userId: string;
  companyId: string;
  role: Role;
  status: 'ACTIVE' | 'SUSPENDED';
  /** تجاوز اختياري لصلاحيات الدور لهذا العضوية فقط. */
  permissions?: PermissionMap;
}

export interface CurrentUser {
  id: string;
  name?: string;
  email?: string;
  memberships: Membership[];
}

const V = ['view'] as Action[];
const VE: Action[] = ['view', 'export'];
const FULL: Action[] = ['view', 'create', 'edit_draft', 'post', 'reverse', 'void', 'export'];

export const ROLE_PERMISSIONS: Record<Role, PermissionMap> = {
  OWNER: {}, // يُعامل كـ true لكل شيء — لكن بدون تجاوز لقيود النظام (مثل عكس قيد محصّل)
  ADMIN: {
    company: ['view', 'manage'],                 // لا delete
    users: ['view', 'manage'],
    settings: ['view', 'manage'],
    journal: FULL,
    invoices: FULL,
    payments: FULL,
    checks: FULL,
    reports: VE,
    audit: VE,
    backup: ['create_backup', 'restore'],
  },
  ACCOUNTANT: {
    company: V,
    journal: FULL,
    invoices: FULL,
    payments: FULL,
    checks: FULL,
    reports: VE,
    audit: V,
    backup: ['create_backup'],
  },
  AUDITOR: {
    company: V,
    journal: VE,
    invoices: VE,
    payments: VE,
    checks: VE,
    reports: VE,
    audit: VE,
    backup: ['create_backup'],
  },
  DATA_ENTRY: {
    company: V,
    journal: ['view', 'create', 'edit_draft'],
    invoices: ['view', 'create'],
    payments: ['view', 'create'],
    checks: ['view', 'create'],
  },
  VIEWER: {
    company: V,
    journal: V,
    invoices: V,
    payments: V,
    checks: V,
    reports: V,
  },
};

/** الطبقة الثانية: حدود المستأجر/الشركة تُفرض من البيانات لا من الواجهة. */
export function membershipFor(user: CurrentUser, companyId: string): Membership | undefined {
  return user.memberships.find(
    (m) => m.status === 'ACTIVE' && (m.companyId === companyId || (user.id === 'local-user' && m.companyId === '*')),
  );
}

export function can(user: CurrentUser, companyId: string, resource: Resource, action: Action): boolean {
  const membership = membershipFor(user, companyId);
  if (!membership) return false;
  if (membership.role === 'OWNER') return true;

  const override = membership.permissions?.[resource];
  const allowed = override !== undefined ? override : (ROLE_PERMISSIONS[membership.role][resource] ?? []);
  return allowed.includes(action);
}

export function assertCan(user: CurrentUser, companyId: string, resource: Resource, action: Action): void {
  if (!can(user, companyId, resource, action)) {
    throw new Error(`لا تملك صلاحية ${action} على ${resource} في هذه الشركة`);
  }
}

/** يُستدعى في بداية كل دالة خدمة: منع الوصول لشركة لا ينتمي إليها المستخدم. */
export function assertCompanyAccess(user: CurrentUser, companyId: string): Membership {
  const m = membershipFor(user, companyId);
  if (!m) throw new Error('لا صلاحية على هذه الشركة (Company Scope)');
  return m;
}
