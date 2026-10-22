/**
 * An entity file that has no name heading or no type. Migration used to
 * abort startup on this shape. Callers leave the file in place and keep
 * it out of the entity index instead.
 */
export function isMalformedEntityRecord(content: string): boolean {
  return !/^#[ \t]+[^\r\n \t]/m.test(content) || !/^\*\*Type:\*\*[ \t]*[^\r\n \t]/m.test(content);
}
