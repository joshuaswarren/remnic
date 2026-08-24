/**
 * Strip Remnic-owned regions from a vault journal section (issue #1987).
 *
 * Loop prevention for vault journals: before daily-note text is treated
 * as journal text, every managed marker region and every configured
 * owned heading section is removed, so published output can never
 * re-enter the journal. Pure string-in/string-out. No filesystem.
 *
 * Fail-closed marker semantics — a partial Remnic region is NEVER kept:
 *  - an unterminated start marker strips to the end of the section and
 *    records a warning;
 *  - an end marker with no matching start (a pair split across the
 *    journal-section boundary) strips everything before it in the
 *    section, so pre-section published output cannot leak in, and
 *    records a warning.
 * Heading lines parse through the SAME exported ATX parser the
 * journal-section reader uses, so a heading the reader recognizes is
 * always a heading this stripper strips.
 */
import { parseAtxHeading } from "./journal-section.js";

const MARKER_OPEN = "<!-- remnic:";
const MARKER_CLOSE = "-->";
const START_SUFFIX = ":start";
const END_SUFFIX = ":end";

export interface StripResult {
  text: string;
  warnings: readonly string[];
}

type RegionMarker = { kind: "start" | "end"; name: string };

export function stripRemnicOwnedRegions(
  sectionText: string,
  ownedHeadings: readonly string[],
): StripResult {
  const warnings: string[] = [];
  const marked = stripMarkerRegions(sectionText, warnings);
  return { text: stripOwnedHeadings(marked, ownedHeadings), warnings };
}

function stripMarkerRegions(text: string, warnings: string[]): string {
  const lines = text.split("\n");
  const keep = lines.map(() => true);
  let openName: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = parseRegionMarker(lines[i]!);
    if (openName !== null) {
      keep[i] = false;
      if (marker && marker.kind === "end" && marker.name === openName) openName = null;
      continue;
    }
    if (marker) {
      keep[i] = false;
      if (marker.kind === "start") {
        openName = marker.name;
      } else {
        for (let j = 0; j < i; j++) keep[j] = false;
        // Stray end marker: the matching start lives outside this section
        // (a pair split across the section boundary). Everything before it
        // in the section is presumed published output — fail closed.
        warnings.push(`unmatched remnic region end "${marker.name}"`);

      }
    }
  }
  if (openName !== null) {
    warnings.push(`unclosed remnic region "${openName}"`);
  }
  return emitKeptLines(lines, keep);
}

function stripOwnedHeadings(text: string, ownedHeadings: readonly string[]): string {
  const wanted = ownedHeadingSet(ownedHeadings);
  if (wanted.size === 0 || text.length === 0) return text;
  const lines = text.split("\n");
  const keep = lines.map(() => true);
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue;
    const heading = parseAtxHeading(lines[i]!);
    if (!heading || !wanted.has(heading.text)) continue;
    keep[i] = false;
    for (let j = i + 1; j < lines.length; j++) {
      const next = parseAtxHeading(lines[j]!);
      if (next && next.level <= heading.level) break;
      keep[j] = false;
    }
  }
  return emitKeptLines(lines, keep);
}

/**
 * Emit kept lines, collapsing the one blank line each removal would
 * otherwise double. Text outside removals is preserved byte-for-byte.
 */
function emitKeptLines(lines: readonly string[], keep: readonly boolean[]): string {
  const out: string[] = [];
  let dropped = false;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      dropped = true;
      continue;
    }
    const line = lines[i]!;
    const previous = out.length > 0 ? out[out.length - 1]! : null;
    if (dropped && previous !== null && previous.trim().length === 0 && line.trim().length === 0) {
      dropped = false;
      continue;
    }
    out.push(line);
    dropped = false;
  }
  return out.join("\n");
}

function parseRegionMarker(line: string): RegionMarker | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(MARKER_OPEN) || !trimmed.endsWith(MARKER_CLOSE)) return null;
  const inner = trimmed.slice(MARKER_OPEN.length, trimmed.length - MARKER_CLOSE.length).trim();
  if (inner.endsWith(START_SUFFIX)) {
    const name = inner.slice(0, -START_SUFFIX.length);
    return name.length > 0 ? { kind: "start", name } : null;
  }
  if (inner.endsWith(END_SUFFIX)) {
    const name = inner.slice(0, -END_SUFFIX.length);
    return name.length > 0 ? { kind: "end", name } : null;
  }
  return null;
}

function ownedHeadingSet(ownedHeadings: readonly string[]): Set<string> {
  const wanted = new Set<string>();
  for (const entry of ownedHeadings) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) wanted.add(trimmed);
  }
  return wanted;
}
