export function isExpired(expiresAt: number, now = Date.now()): boolean {
  return now >= expiresAt;
}
