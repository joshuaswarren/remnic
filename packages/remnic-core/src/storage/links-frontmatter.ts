import type { MemoryLink } from "../types.js";

// Parse links: block-sequence items of "key: value" fields under the
// links: key. Field order is free; an item missing targetId, a known
// linkType, or a 0-1 strength drops alone (issue #3568). Fields must sit
// at the item's own key column — deeper lines are nested scalar content
// (e.g. a "note: |" block), not link fields.
export function parseFrontmatterLinks(
  fmBlock: string,
  parseReason: (raw: string) => string,
): MemoryLink[] | undefined {
  const fmLines = fmBlock.split("\n");
  const linksKeyIdx = fmLines.findIndex((l) => l.trimEnd() === "links:");
  if (linksKeyIdx === -1) return undefined;

  const linksIndent = fmLines[linksKeyIdx].search(/\S/);
  const items: Record<string, string>[] = [];
  let fieldIndent = -1;
  for (let k = linksKeyIdx + 1; k < fmLines.length; k++) {
    const line = fmLines[k];
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const indent = line.search(/\S/);
    if (indent <= linksIndent) break;
    if (t.startsWith("- ")) {
      items.push({});
      const inline = t.slice(2);
      const colon = inline.indexOf(":");
      fieldIndent = colon > 0 ? indent + 2 : -1;
      if (colon > 0) {
        items[items.length - 1][inline.slice(0, colon).trim()] = inline.slice(colon + 1).trim();
      }
      continue;
    }
    if (items.length === 0) continue;
    const colon = t.indexOf(":");
    if (colon <= 0) continue;
    if (fieldIndent === -1) fieldIndent = indent;
    if (indent !== fieldIndent) continue;
    items[items.length - 1][t.slice(0, colon).trim()] = t.slice(colon + 1).trim();
  }

  const links: MemoryLink[] = [];
  for (const item of items) {
    const strength = Number(item.strength);
    if (
      !item.targetId ||
      !["follows", "references", "contradicts", "supports", "related"].includes(item.linkType ?? "") ||
      !Number.isFinite(strength) ||
      strength < 0 ||
      strength > 1
    ) continue;
    links.push({
      targetId: item.targetId,
      // SAFETY: linkType passed the closed literal list in the guard
      // above, so the string narrows to MemoryLink["linkType"].
      linkType: item.linkType as MemoryLink["linkType"],
      strength,
      reason:
        item.reason?.startsWith('"') && item.reason.endsWith('"')
          ? parseReason(item.reason.slice(1, -1))
          : item.reason,
    });
  }
  return links.length > 0 ? links : undefined;
}
