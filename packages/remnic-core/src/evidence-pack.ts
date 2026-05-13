export interface EvidencePackItem {
  id?: string;
  sessionId?: string;
  turnIndex?: number;
  role?: string;
  content: string;
  score?: number;
}

export interface EvidencePackOptions {
  title?: string;
  maxChars: number;
  maxItemChars?: number;
  query?: string;
}

const DEFAULT_MAX_ITEM_CHARS = 1_200;
const QUERY_FOCUS_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "between",
  "can",
  "could",
  "did",
  "does",
  "during",
  "for",
  "from",
  "have",
  "how",
  "into",
  "many",
  "should",
  "that",
  "the",
  "this",
  "till",
  "until",
  "want",
  "was",
  "were",
  "what",
  "when",
  "which",
  "with",
  "would",
  "you",
]);

export function buildEvidencePack(
  items: readonly EvidencePackItem[],
  options: EvidencePackOptions,
): string {
  const budget = normalizePositiveInteger(options.maxChars);
  if (budget <= 0 || items.length === 0) {
    return "";
  }

  const maxItemChars = normalizePositiveInteger(
    options.maxItemChars ?? DEFAULT_MAX_ITEM_CHARS,
  );
  if (maxItemChars <= 0) {
    return "";
  }

  const title = options.title ?? "Evidence";
  const lines: string[] = [`## ${title}`];
  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  let used = lines[0]!.length;

  for (const item of items) {
    const content = item.content.trim();
    if (!content) continue;

    const id = item.id ?? evidenceItemFallbackId(item);
    if (id && seenIds.has(id)) continue;

    const contentKey = normalizeEvidenceContent(content);
    if (seenContent.has(contentKey)) continue;

    const label = formatEvidenceLabel(item);
    const clipped = clipEvidenceContent(content, maxItemChars, options.query);
    const block = `${label}: ${clipped}`;
    const separatorLength = lines.length > 0 ? 2 : 0;
    const remaining = budget - used - separatorLength;
    if (remaining <= 0) break;

    const finalBlock =
      block.length > remaining ? clipText(block, remaining) : block;
    if (!finalBlock.trim()) break;

    lines.push(finalBlock);
    used += separatorLength + finalBlock.length;
    if (id) seenIds.add(id);
    seenContent.add(contentKey);
  }

  return lines.length === 1 ? "" : lines.join("\n\n");
}

export function insertAfterEvidenceHeading(
  evidence: string,
  title: string,
  insert: string,
): string {
  const heading = `## ${title}`;
  if (!evidence.startsWith(heading)) {
    return evidence;
  }
  return `${heading}${insert}${evidence.slice(heading.length)}`;
}

function normalizePositiveInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function evidenceItemFallbackId(item: EvidencePackItem): string | undefined {
  if (item.sessionId && typeof item.turnIndex === "number") {
    return `${item.sessionId}:${item.turnIndex}`;
  }
  return undefined;
}

function normalizeEvidenceContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

function formatEvidenceLabel(item: EvidencePackItem): string {
  const parts: string[] = [];
  if (item.sessionId) parts.push(item.sessionId);
  if (typeof item.turnIndex === "number") parts.push(`turn ${item.turnIndex}`);
  if (item.role) parts.push(item.role);
  if (typeof item.score === "number" && Number.isFinite(item.score)) {
    parts.push(`score ${item.score.toFixed(3)}`);
  }
  return parts.length > 0 ? `[${parts.join(", ")}]` : "[evidence]";
}

function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return text.slice(0, maxChars);
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function clipEvidenceContent(
  content: string,
  maxChars: number,
  query?: string,
): string {
  if (content.length <= maxChars) {
    return content;
  }

  const focused = buildQueryFocusedExcerpt(content, maxChars, query);
  return focused ?? clipText(content, maxChars);
}

function buildQueryFocusedExcerpt(
  content: string,
  maxChars: number,
  query?: string,
): string | undefined {
  const cues = collectQueryFocusCues(query ?? "");
  if (cues.length === 0) {
    return undefined;
  }

  const lines = content
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    return undefined;
  }

  const temporalIntent = hasTemporalFocusIntent(query ?? "");
  const scored = lines
    .map((line, index) => ({
      index,
      score: scoreEvidenceLine(line, cues, temporalIntent, index),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  if (scored.length === 0) {
    return undefined;
  }

  let selected = new Set<number>();
  for (let index = 0; index < Math.min(3, lines.length); index += 1) {
    if (isEvidenceMetadataLine(lines[index]!)) {
      selected.add(index);
    }
  }

  for (const entry of scored.slice(0, 8)) {
    const candidate = new Set(selected);
    const radius = lineWindowRadius(lines[entry.index]!, temporalIntent);
    for (
      let index = Math.max(0, entry.index - radius);
      index <= Math.min(lines.length - 1, entry.index + radius);
      index += 1
    ) {
      candidate.add(index);
    }
    if (renderSelectedEvidenceLines(lines, candidate).length <= maxChars) {
      selected = candidate;
    }
  }

  const excerpt = buildExcerptFromLineSelection(lines, selected, maxChars);
  return excerpt.length > 0 ? excerpt : undefined;
}

function collectQueryFocusCues(query: string): string[] {
  const words = (query.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])
    .map(trimBoundaryHyphens)
    .filter(
      (word) =>
        word.length >= 3 &&
        !/^\d+$/.test(word) &&
        !QUERY_FOCUS_STOPWORDS.has(word),
    );
  const cues = new Set<string>();
  for (const word of words) {
    cues.add(word);
  }
  for (let index = 0; index < words.length - 1; index += 1) {
    const left = words[index]!;
    const right = words[index + 1]!;
    if (left.length >= 4 && right.length >= 4) {
      cues.add(`${left} ${right}`);
    }
  }
  for (let index = 0; index < words.length - 2; index += 1) {
    const left = words[index]!;
    const middle = words[index + 1]!;
    const right = words[index + 2]!;
    if (left.length >= 4 && middle.length >= 4 && right.length >= 4) {
      cues.add(`${left} ${middle} ${right}`);
    }
  }
  return [...cues].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function trimBoundaryHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") {
    start += 1;
  }
  while (end > start && value[end - 1] === "-") {
    end -= 1;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

function hasTemporalFocusIntent(query: string): boolean {
  return /\b(?:after|before|between|date|deadline|during|finish(?:ing|ed)?|how many|timeline|week|weeks|when)\b/i.test(
    query,
  );
}

function scoreEvidenceLine(
  line: string,
  cues: readonly string[],
  temporalIntent: boolean,
  index: number,
): number {
  const normalized = line.toLowerCase();
  let score = 0;
  for (const cue of cues) {
    if (!normalized.includes(cue)) {
      continue;
    }
    score += cue.includes(" ") ? 8 : 3;
  }
  if (temporalIntent && hasDateLikeEvidence(line)) {
    score += 6;
  }
  if (
    temporalIntent &&
    /\b(?:deadline|deployment|finish(?:ing|ed)?|milestones?|schedule|timeline)\b/i.test(line)
  ) {
    score += 5;
  }
  if (/^\s{0,3}(?:#{1,6}\s*)?(?:milestones?|schedule|timeline)\b/i.test(line)) {
    score += 3;
  }
  if (isEvidenceMetadataLine(line)) {
    score += Math.max(0, 3 - index);
  }
  return score;
}

function hasDateLikeEvidence(line: string): boolean {
  return /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}\b/i.test(
    line,
  ) || /\b\d{4}-\d{2}-\d{2}\b/.test(line);
}

function isEvidenceMetadataLine(line: string): boolean {
  return /\b(?:chat_id|source_chat_id|session_id|plan_id|task_id|ability)=/.test(
    line,
  );
}

function lineWindowRadius(line: string, temporalIntent: boolean): number {
  if (temporalIntent && hasDateLikeEvidence(line)) {
    return 0;
  }
  if (temporalIntent && /^\s{0,3}(?:#{1,6}\s*)?(?:milestones?|schedule|timeline)\b/i.test(line)) {
    return 2;
  }
  return 1;
}

function buildExcerptFromLineSelection(
  lines: readonly string[],
  selected: ReadonlySet<number>,
  maxChars: number,
): string {
  const ordered = [...selected].sort((left, right) => left - right);
  const output: string[] = [];
  let used = 0;
  let lastIndex = -1;

  const append = (text: string): boolean => {
    const separator = output.length === 0 ? "" : "\n";
    const remaining = maxChars - used - separator.length;
    if (remaining <= 0) {
      return false;
    }
    const value = text.length > remaining ? clipText(text, remaining) : text;
    if (!value.trim()) {
      return false;
    }
    output.push(value);
    used += separator.length + value.length;
    return text.length <= remaining;
  };

  for (const index of ordered) {
    if (lastIndex >= 0 && index > lastIndex + 1 && !append("...")) {
      break;
    }
    if (!append(lines[index]!)) {
      break;
    }
    lastIndex = index;
  }

  return output.join("\n");
}

function renderSelectedEvidenceLines(
  lines: readonly string[],
  selected: ReadonlySet<number>,
): string {
  const ordered = [...selected].sort((left, right) => left - right);
  const output: string[] = [];
  let lastIndex = -1;
  for (const index of ordered) {
    if (lastIndex >= 0 && index > lastIndex + 1) {
      output.push("...");
    }
    output.push(lines[index]!);
    lastIndex = index;
  }
  return output.join("\n");
}
