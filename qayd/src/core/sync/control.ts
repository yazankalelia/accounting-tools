const PAUSE_KEY = 'qayd:syncPaused';

/** أثناء الاستعادة نوقف المزامنة كي لا نُرسل حالة نصف مستعادة. */
export function pauseSync(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PAUSE_KEY, '1');
  } catch { /* تجاهل */ }
}

export function resumeSync(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(PAUSE_KEY);
  } catch { /* تجاهل */ }
}

export function isSyncPaused(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(PAUSE_KEY) === '1';
  } catch {
    return false;
  }
}
