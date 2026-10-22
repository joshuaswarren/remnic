const UNSAFE_ENTITY_ID_PATTERN = /[\/\\\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * An entity file that has no name heading or no type. Migration used to
 * abort startup on this shape. Callers leave the file in place and keep
 * it out of the entity index instead.
 */
export function isMalformedEntityRecord(content: string): boolean {
  return !/^#[ \t]+[^\r\n \t]/m.test(content)
    || !/^\*\*Type:\*\*[ \t]*[^\r\n \t]/m.test(content);
}

export function assertSafeEntityId(entityId: string): void {
  if (UNSAFE_ENTITY_ID_PATTERN.test(entityId)) {
    throw new Error("Refusing unsafe entity id containing a path separator or control character.");
  }
}
