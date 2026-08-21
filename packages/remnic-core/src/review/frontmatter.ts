export function splitMarkdownFrontmatter(content: string): { fields: string; body: string } | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;
  const after = end + "\n---".length;
  const body = content.startsWith("\n", after) ? content.slice(after + 1) : content.slice(after);
  return { fields: content.slice(4, end), body };
}

export function parseFrontmatterFields(content: string): Record<string, string> {
  const split = splitMarkdownFrontmatter(content);
  if (!split) return {};
  const fields: Record<string, string> = {};
  for (const line of split.fields.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    fields[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
  }
  return fields;
}
