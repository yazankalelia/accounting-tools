import { db } from '../db/schema';
import type { CurrentUser, Membership } from './permissions';

const CURRENT_USER_KEY = 'qayd:currentUser';

/** مستخدم محلي افتراضي بم دور OWNER لضمان عمل التطبيق أحادي المستخدم. */
export function localOwner(companyId = '*'): CurrentUser {
  return {
    id: 'local-user',
    name: 'المستخدم المحلي',
    memberships: [{
      id: 'uc-local',
      userId: 'local-user',
      companyId,
      role: 'OWNER',
      status: 'ACTIVE',
    }],
  };
}

export function getCurrentUser(): CurrentUser {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(CURRENT_USER_KEY);
      if (raw) return JSON.parse(raw) as CurrentUser;
    }
  } catch { /* بيئة اختبار أو تصفح خاص */ }
  return localOwner();
}

export function setCurrentUser(user: CurrentUser): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
  } catch { /* تجاهل */ }
}

/** قراءة العضويات من قاعدة البيانات (الوضع متعدد المستخدمين لاحقًا). */
export async function loadMemberships(userId: string): Promise<Membership[]> {
  return db.userCompanies.where('userId').equals(userId).toArray() as Promise<Membership[]>;
}

export async function hydrateCurrentUser(userId: string): Promise<CurrentUser> {
  const base = getCurrentUser();
  const memberships = await loadMemberships(userId);
  return { ...base, id: userId, memberships };
}
