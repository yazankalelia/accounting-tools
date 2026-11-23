/** SHA-256 hex — يُستخدم لتوقيع النسخ الاحتياطية والتحقق قبل الاستعادة. */
export async function sha256(text: string): Promise<string> {
  const c = (globalThis as any).crypto;
  if (!c?.subtle) throw new Error('Web Crypto غير متاح في هذه البيئة');
  const bytes = new TextEncoder().encode(text);
  const digest = await c.subtle.digest('SHA-256', bytes as any);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function byteLength(text: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
}
