/** معرّف فريد محليًا، مع بديل للبيئات التي لا تعرّف crypto.randomUUID. */
export function newId(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
