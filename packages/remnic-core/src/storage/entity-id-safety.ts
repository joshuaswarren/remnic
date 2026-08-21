const UNSAFE_ENTITY_ID_PATTERN = /[\/\\\p{Cc}\p{Zl}\p{Zp}]/u;

export function assertSafeEntityId(entityId: string): void {
  if (UNSAFE_ENTITY_ID_PATTERN.test(entityId)) {
    throw new Error("Refusing unsafe entity id containing a path separator or control character.");
  }
}
