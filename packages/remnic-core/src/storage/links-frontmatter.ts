import type { MemoryLink } from "../types.js";

// Parse links: block-sequence items of "key: value" fields under the
// links: key. Field order is free; an item missing targetId, a known
// linkType, or a 0-1 strength drops alone (issue #3568).
export function parseFrontmatterLinks(
  fmBlock: string,
  parseReason: (raw: string) => string,
): MemoryLink[] | undefined {
  const fmLines = fmBlock.split("\n");
  const linksKeyIdx = fmLines.findIndex((l) => l.trimEnd() === "links:");
  if (linksKeyIdx === -1) return undefined;

  const linksIndent = fmLines[linksKeyIdx].search(/\S/);
  const items: Record<string, string>[] = [];
  for (let k = linksKeyIdx + 1; k < fmLines.length; k++) {
    const t = fmLines[k].trim();
    if (!t) continue;
    if (fmLines[k].search(/\S/) <= linksIndent) break;
    if (t.startsWith("- ")) items.push({});
    const src = t.startsWith("- ") ? t.slice(2) : t;
    const colon = src.indexOf(":");
    if (items.length > 0 && colon > 0) {
      items[items.length - 1][src.slice(0, colon).trim()] = src.slice(colon + 1).trim();
    }
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
