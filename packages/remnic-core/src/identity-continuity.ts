import type {
  ContinuityIncidentCloseInput,
  ContinuityIncidentOpenInput,
  ContinuityImprovementLoop,
  ContinuityLoopCadence,
  ContinuityLoopReviewInput,
  ContinuityLoopStatus,
  ContinuityLoopUpsertInput,
  ContinuityIncidentRecord,
  ContinuityIncidentState,
} from "./types.js";

function parseFrontmatterValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    parsed[key] = parseFrontmatterValue(value);
  }
  return parsed;
}

function emitSection(lines: string[], title: string, value?: string): void {
  if (!value || value.trim().length === 0) return;
  lines.push(`## ${title}`, "", value.trim(), "");
}

function parseSection(body: string, title: string): string | undefined {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`## ${escaped}\\n\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = body.match(re);
  if (!match) return undefined;
  const value = match[1].trim();
  return value.length > 0 ? value : undefined;
}

export function serializeContinuityIncident(incident: ContinuityIncidentRecord): string {
  const lines = [
    "---",
    `id: ${JSON.stringify(incident.id)}`,
    `state: ${JSON.stringify(incident.state)}`,
    `openedAt: ${JSON.stringify(incident.openedAt)}`,
    `updatedAt: ${JSON.stringify(incident.updatedAt)}`,
  ];
  if (incident.closedAt) lines.push(`closedAt: ${JSON.stringify(incident.closedAt)}`);
  if (incident.triggerWindow) lines.push(`triggerWindow: ${JSON.stringify(incident.triggerWindow)}`);
  lines.push("---", "");

  emitSection(lines, "Symptom", incident.symptom);
  emitSection(lines, "Suspected Cause", incident.suspectedCause);
  emitSection(lines, "Fix Applied", incident.fixApplied);
  emitSection(lines, "Verification Result", incident.verificationResult);
  emitSection(lines, "Preventive Rule", incident.preventiveRule);

  return lines.join("\n").trimEnd() + "\n";
}

export function parseContinuityIncident(raw: string): ContinuityIncidentRecord | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const frontmatter = parseFrontmatter(match[1]);
  const body = match[2] ?? "";

  const id = typeof frontmatter.id === "string" ? frontmatter.id : "";
  const stateRaw = frontmatter.state;
  const state: ContinuityIncidentState = stateRaw === "closed" ? "closed" : "open";
  const openedAt = typeof frontmatter.openedAt === "string" ? frontmatter.openedAt : "";
  const updatedAt = typeof frontmatter.updatedAt === "string" ? frontmatter.updatedAt : openedAt;
  const symptom = parseSection(body, "Symptom");

  if (!id || !openedAt || !updatedAt || !symptom) return null;

  return {
    id,
    state,
    openedAt,
    updatedAt,
    triggerWindow: typeof frontmatter.triggerWindow === "string" ? frontmatter.triggerWindow : undefined,
    symptom,
    suspectedCause: parseSection(body, "Suspected Cause"),
    fixApplied: parseSection(body, "Fix Applied"),
    verificationResult: parseSection(body, "Verification Result"),
    preventiveRule: parseSection(body, "Preventive Rule"),
    closedAt: typeof frontmatter.closedAt === "string" ? frontmatter.closedAt : undefined,
  };
}

export function createContinuityIncidentRecord(
  id: string,
  input: ContinuityIncidentOpenInput,
  nowIso: string,
): ContinuityIncidentRecord {
  return {
    id,
    state: "open",
    openedAt: nowIso,
    updatedAt: nowIso,
    triggerWindow: input.triggerWindow?.trim() || undefined,
    symptom: input.symptom.trim(),
    suspectedCause: input.suspectedCause?.trim() || undefined,
  };
}

export function closeContinuityIncidentRecord(
  incident: ContinuityIncidentRecord,
  closure: ContinuityIncidentCloseInput,
  nowIso: string,
): ContinuityIncidentRecord {
  return {
    ...incident,
    state: "closed",
    updatedAt: nowIso,
    closedAt: nowIso,
    fixApplied: closure.fixApplied.trim(),
    verificationResult: closure.verificationResult.trim(),
    preventiveRule: closure.preventiveRule?.trim() || incident.preventiveRule,
  };
}

const LOOP_HEADER = "# Continuity Improvement Loops";
const LOOP_CADENCES = new Set<ContinuityLoopCadence>(["daily", "weekly", "monthly", "quarterly"]);
const LOOP_STATUSES = new Set<ContinuityLoopStatus>(["active", "paused", "retired"]);
const STALE_LAST_REVIEWED_FALLBACK = "1970-01-01T00:00:00.000Z";

function normalizeLoopField(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.replace(/\s+/g, " ");
}

function isValidIso(value: string): boolean {
  const ts = Date.parse(value);
  return Number.isFinite(ts);
}

function normalizeContinuityLoop(
  input: ContinuityLoopUpsertInput | ContinuityImprovementLoop,
  nowIso: string,
): ContinuityImprovementLoop | null {
  const id = normalizeLoopField(input.id);
  const cadence = normalizeLoopField(input.cadence) as ContinuityLoopCadence | undefined;
  const status = normalizeLoopField(input.status) as ContinuityLoopStatus | undefined;
  const purpose = normalizeLoopField(input.purpose);
  const killCondition = normalizeLoopField(input.killCondition);
  const notes = normalizeLoopField(input.notes);
  const lastReviewedRaw =
    "lastReviewed" in input && typeof input.lastReviewed === "string" ? input.lastReviewed : undefined;
  const lastReviewed = normalizeLoopField(lastReviewedRaw) ?? nowIso;

  if (!id || !cadence || !status || !purpose || !killCondition) return null;
  if (!LOOP_CADENCES.has(cadence)) return null;
  if (!LOOP_STATUSES.has(status)) return null;
  if (!isValidIso(lastReviewed)) return null;

  return {
    id,
    cadence,
    purpose,
    status,
    killCondition,
    lastReviewed,
    notes,
  };
}

function serializeContinuityLoopSection(loop: ContinuityImprovementLoop): string {
  const lines = [
    `## ${loop.id}`,
    `cadence: ${loop.cadence}`,
    `purpose: ${loop.purpose}`,
    `status: ${loop.status}`,
    `killCondition: ${loop.killCondition}`,
    `lastReviewed: ${loop.lastReviewed}`,
  ];
  if (loop.notes) lines.push(`notes: ${loop.notes}`);
  return lines.join("\n");
}

type MarkdownSection = {
  title: string;
  body: string;
};

function splitLoopMarkdown(raw: string | null): { header: string; sections: MarkdownSection[] } {
  const text = (raw ?? "").replace(/\r/g, "");
  const lines = text.split("\n");
  const headerLines: string[] = [];
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;

  for (const line of lines) {
    // /^##\s(.+)$/ + the trim below is exactly equivalent to the original
    // /^##\s+(.+?)\s*$/ (same match/no-match and same trimmed title across all
    // inputs, including "## " → no-match and "##  " → empty title) but has no
    // adjacent overlapping quantifiers, so it cannot backtrack polynomially
    // (CodeQL js/polynomial-redos). \s matches a single fixed-width char and
    // .+ runs greedily to the line end — no \s+/.* overlap.
    const sectionMatch = line.match(/^##\s(.+)$/);
    if (sectionMatch) {
      if (current) sections.push({ title: current.title, body: current.body.trimEnd() });
      current = { title: sectionMatch[1].trim(), body: "" };
      continue;
    }
    if (!current) {
      headerLines.push(line);
      continue;
    }
    current.body += current.body.length > 0 ? `\n${line}` : line;
  }
  if (current) sections.push({ title: current.title, body: current.body.trimEnd() });

  const headerRaw = headerLines.join("\n").trim();
  const header = headerRaw.length > 0 ? headerRaw : LOOP_HEADER;
  return { header, sections };
}

function parseLoopFromSection(section: MarkdownSection, nowIso: string): ContinuityImprovementLoop | null {
  const fields: Record<string, string> = {};
  for (const line of section.body.split("\n")) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.+?)\s*$/);
    if (!kv) continue;
    fields[kv[1]] = kv[2];
  }
  const parsedLastReviewed = normalizeLoopField(fields.lastReviewed);
  const safeLastReviewed =
    parsedLastReviewed && isValidIso(parsedLastReviewed) ? parsedLastReviewed : STALE_LAST_REVIEWED_FALLBACK;
  return normalizeContinuityLoop(
    {
      id: section.title,
      cadence: (fields.cadence ?? "") as ContinuityLoopCadence,
      purpose: fields.purpose ?? "",
      status: (fields.status ?? "") as ContinuityLoopStatus,
      killCondition: fields.killCondition ?? "",
      lastReviewed: safeLastReviewed,
      notes: fields.notes,
    },
    nowIso,
  );
}

function joinLoopMarkdown(header: string, sections: MarkdownSection[]): string {
  const lines: string[] = [header.trim(), ""];
  for (const section of sections) {
    lines.push(`## ${section.title}`);
    if (section.body.trim().length > 0) {
      lines.push(section.body.trimEnd());
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function parseContinuityImprovementLoops(raw: string): ContinuityImprovementLoop[] {
  const parsed = splitLoopMarkdown(raw);
  const nowIso = new Date().toISOString();
  return parsed.sections
    .map((section) => parseLoopFromSection(section, nowIso))
    .filter((loop): loop is ContinuityImprovementLoop => loop !== null);
}

export function upsertContinuityLoopInMarkdown(
  raw: string | null,
  input: ContinuityLoopUpsertInput,
  nowIso: string,
): { markdown: string; loop: ContinuityImprovementLoop } {
  const normalized = normalizeContinuityLoop(input, nowIso);
  if (!normalized) {
    throw new Error("Invalid continuity loop input");
  }

  const parsed = splitLoopMarkdown(raw);
  let replaced = false;
  const nextSections = parsed.sections.map((section) => {
    if (normalizeLoopField(section.title) !== normalized.id) return section;
    replaced = true;
    return { title: normalized.id, body: serializeContinuityLoopSection(normalized).split("\n").slice(1).join("\n") };
  });

  if (!replaced) {
    nextSections.push({
      title: normalized.id,
      body: serializeContinuityLoopSection(normalized).split("\n").slice(1).join("\n"),
    });
  }

  return { markdown: joinLoopMarkdown(parsed.header, nextSections), loop: normalized };
}

export function reviewContinuityLoopInMarkdown(
  raw: string | null,
  id: string,
  input: ContinuityLoopReviewInput,
  nowIso: string,
): { markdown: string; loop: ContinuityImprovementLoop | null } {
  const parsed = splitLoopMarkdown(raw);
  const normalizedId = normalizeLoopField(id);
  if (!normalizedId) {
    return { markdown: joinLoopMarkdown(parsed.header, parsed.sections), loop: null };
  }
  let updatedLoop: ContinuityImprovementLoop | null = null;
  const nextSections = parsed.sections.map((section) => {
    if (normalizeLoopField(section.title) !== normalizedId) return section;
    const existing = parseLoopFromSection(section, nowIso);
    if (!existing) return section;
    const reviewed = applyContinuityLoopReview(existing, input, nowIso);
    updatedLoop = reviewed;
    return { title: reviewed.id, body: serializeContinuityLoopSection(reviewed).split("\n").slice(1).join("\n") };
  });

  return { markdown: joinLoopMarkdown(parsed.header, nextSections), loop: updatedLoop };
}

function applyContinuityLoopReview(
  existing: ContinuityImprovementLoop,
  input: ContinuityLoopReviewInput,
  nowIso: string,
): ContinuityImprovementLoop {
  const nextStatus = normalizeLoopField(input.status) as ContinuityLoopStatus | undefined;
  const nextNotes = normalizeLoopField(input.notes);
  const reviewedAt = normalizeLoopField(input.reviewedAt) ?? nowIso;

  return {
    ...existing,
    status: nextStatus && LOOP_STATUSES.has(nextStatus) ? nextStatus : existing.status,
    notes: nextNotes ?? existing.notes,
    lastReviewed: isValidIso(reviewedAt) ? reviewedAt : nowIso,
  };
}
