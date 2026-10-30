/**
 * Heading and type flags for an entity markdown body.
 *
 * The heading rule matches `parseEntityFile`: a line must start with `# `
 * (hash, space) and the remainder must contain a name. A tab after `#`
 * is not a heading. The type rule matches a `**Type:**` line with a
 * non-empty value. A missing type line is still readable: the parser
 * defaults the type to `other`.
 */
function entityRecordFlags(content: string): { hasName: boolean; hasType: boolean } {
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
    if (hasName && hasType) return { hasName, hasType };
    if (newline === -1) break;
    start = newline + 1;
  }
  return { hasName, hasType };
}

/**
 * No `# ` name. A named file whose type line is absent stays readable:
 * `parseEntityFile` defaults the type to `other`.
 */
export function isUnnamedEntityRecord(content: string): boolean {
  return !entityRecordFlags(content).hasName;
}

function entityBodyHasText(content: string): boolean {
  const body = entityRecordBody(content);
  for (let i = 0; i < body.length; i++) {
    const char = body.charCodeAt(i);
    if (char !== 32 && char !== 9 && char !== 10 && char !== 13) return true;
  }
  return false;
}

/**
 * Unnamed entity body that still has text. An empty body under frontmatter
 * stays readable so a canonical filename can supply the type. A tab heading,
 * a blank `# ` heading, or prose with no name does not.
 */
export function isPopulatedUnnamedEntityRecord(content: string): boolean {
  return isUnnamedEntityRecord(content) && entityBodyHasText(content);
}

/**
 * Unnamed file that still looks like an entity record (`#` or `**Type:**`).
 * Direct filename recall keeps unstructured placeholders such as "content".
 */
export function isShapedUnnamedEntityRecord(content: string): boolean {
  if (!isUnnamedEntityRecord(content)) return false;
  const body = entityRecordBody(content);
  let start = 0;
  while (start <= body.length) {
    const newline = body.indexOf("\n", start);
    const end = newline === -1 ? body.length : newline;
    let line = body.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.startsWith("#") || line.startsWith("**Type:**")) return true;
    if (newline === -1) break;
    start = newline + 1;
  }
  return false;
}

/**
 * Migration gate. Canonical ids are derived from name and type, and the
 * old startup throw required an explicit `**Type:**` line. Files that
 * only have a heading stay on disk and are not renamed. Listing does not
 * use this predicate: `parseEntityFile` defaults a missing type to `other`.
 */
export function isMalformedEntityRecord(content: string): boolean {
  const flags = entityRecordFlags(content);
  return !flags.hasName || !flags.hasType;
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
