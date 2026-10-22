/**
 * An entity file the parser cannot read as a named, typed record.
 * Migration used to abort startup on this shape. Callers leave the file
 * in place and keep it out of the entity index instead.
 *
 * The heading rule matches `parseEntityFile`: a line must start with `# `
 * (hash, space) and the remainder must contain a name. A tab after `#`
 * is not a heading. The type rule matches a `**Type:**` line with a
 * non-empty value.
 */
export function isMalformedEntityRecord(content: string): boolean {
  const body = entityRecordBody(content);
  let hasName = false;
  let hasType = false;
  let start = 0;
  while (start <= body.length) {
    const newline = body.indexOf("\n", start);
    const end = newline === -1 ? body.length : newline;
    let line = body.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!hasName && line.startsWith("# ") && line.slice(2).trim().length > 0) hasName = true;
    if (!hasType && line.startsWith("**Type:**") && line.slice("**Type:**".length).trim().length > 0) {
      hasType = true;
    }
    if (hasName && hasType) return false;
    if (newline === -1) break;
    start = newline + 1;
  }
  return true;
}

function entityRecordBody(content: string): string {
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return content;
  const firstLine = content.slice(0, firstNewline).endsWith("\r")
    ? content.slice(0, firstNewline - 1)
    : content.slice(0, firstNewline);
  if (firstLine !== "---") return content;
  const close = content.indexOf("\n---", firstNewline + 1);
  if (close === -1) return content;
  let rest = close + "\n---".length;
  if (content.charAt(rest) === "\r") rest += 1;
  if (content.charAt(rest) === "\n") rest += 1;
  return content.slice(rest);
}
