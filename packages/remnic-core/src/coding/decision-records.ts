import type { CodingKnowledgeConfig } from "../types.js";

// ──────────────────────────────────────────────────────────────────────────

export type DecisionStatus = "proposed" | "accepted" | "superseded" | "rejected";

export const DECISION_STATUSES = [
  "proposed",
  "accepted",
  "superseded",
  "rejected",
] as const satisfies readonly DecisionStatus[];

export const ACTIVE_DECISION_STATUSES: ReadonlySet<DecisionStatus> = new Set<DecisionStatus>([
  "proposed",
  "accepted",
]);

export const DEFAULT_DECISION_STATUS: DecisionStatus = "proposed";

export interface DecisionRecord {
  /** Stable identifier — typically `ADR-XXXX` or `MADR-XXXX`. Must be unique. */
  id: string;
  /** One-line summary surfaced in briefings and `list` output. */
  title: string;
  /** Status lifecycle (rule 51: only the four declared values). */
  status: DecisionStatus;
  /** The problem / context the decision addresses. */
  context: string;
  /** The decision itself. */
  decision: string;
  /** Trade-offs, follow-ups, consequences. Optional — free-form. */
  consequences: string | undefined;
  /** Entity references (entity IDs, doc anchors, code paths). May be empty. */
  entityRefs: string[];
  /** The record this one supersedes — set by `applySupersede`, never by hand. */
  supersedes?: string;
}

/**
 * Input shape for `serializeDecisionRecord`. Mirrors `DecisionRecord` but
 * keeps `supersedes` reachable so callers writing the replacement before
 * applying supersede can serialise the new record alone.
 */
export type DecisionRecordInput = Omit<DecisionRecord, "supersedes"> & {
  supersedes?: string;
};

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

const DECISION_STATUS_BY_VALUE: Record<string, DecisionStatus> = Object.freeze({
  proposed: "proposed",
  accepted: "accepted",
  superseded: "superseded",
  rejected: "rejected",
}) as Record<string, DecisionStatus>;

export function isDecisionStatus(value: unknown): value is DecisionStatus {
  return (
    typeof value === "string"
    && Object.prototype.hasOwnProperty.call(DECISION_STATUS_BY_VALUE, value)
  );
}

const FRONTMATTER_KEYS = Object.freeze([
  "id",
  "title",
  "status",
  "context",
  "decision",
  "consequences",
  "entityRefs",
  "supersedes",
] as const satisfies readonly (keyof DecisionRecord | "id")[]);

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Render a decision record as markdown with a YAML frontmatter block.
 *
 * Frontmatter keys are sorted ascending (rule 38). Strings are double-quoted
 * so reserved YAML characters (`#`, `:`, leading-digits, list-like prefixes)
 * survive a round-trip without the caller caring.
 */
export function serializeDecisionRecord(record: DecisionRecordInput): string {
  const lines: string[] = ["---"];
  for (const key of FRONTMATTER_KEYS) {
    const present =
      key === "supersedes"
        ? record.supersedes !== undefined
        : key === "consequences"
          ? record.consequences !== undefined
          : true;
    if (!present) continue;
    lines.push(`${key}: ${encodeFrontmatterValue(key, record)}`);
  }
  lines.push("---", "");
  if (record.context) lines.push(record.context);
  lines.push("");
  lines.push("# Decision");
  lines.push("");
  if (record.decision) lines.push(record.decision);
  if (record.consequences !== undefined && record.consequences.length > 0) {
    lines.push("");
    lines.push("# Consequences");
    lines.push("");
    lines.push(record.consequences);
  }
  if (record.entityRefs.length > 0) {
    lines.push("");
    lines.push("# Entity references");
    for (const ref of record.entityRefs) lines.push(`- ${ref}`);
  }
  lines.push("");
  return lines.join("\n");
}

function encodeFrontmatterValue(
  key: (typeof FRONTMATTER_KEYS)[number],
  record: DecisionRecordInput,
): string {
  if (key === "entityRefs") {
    const refs = record.entityRefs;
    if (refs.length === 0) return "[]";
    const inner = refs.map((ref) => `"${escapeYamlString(ref)}"`).join(", ");
    return `[${inner}]`;
  }
  if (key === "status") return `"${record.status}"`;
  if (key === "supersedes") return `"${record.supersedes ?? ""}"`;
  if (key === "consequences") return `"${escapeYamlString(record.consequences ?? "")}"`;
  const value = record[key];
  return `"${escapeYamlString(typeof value === "string" ? value : String(value))}"`;
}

function escapeYamlString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

interface ParsedFrontmatter {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly body: string;
}

/**
 * Parse a decision record from a markdown string with a YAML frontmatter
 * block. Throws (with a message listing the valid statuses, rule 51) when
 * the document does not match the contract.
 *
 * Missing / undefined `status` defaults to `"proposed"` (rule 48 — least
 * privileged).
 */
export function parseDecisionRecord(raw: string): DecisionRecord {
  const { fields, body } = extractFrontmatter(raw);

  for (const fieldKey of Object.keys(fields)) {
    if (!FRONTMATTER_KEYS.includes(fieldKey as (typeof FRONTMATTER_KEYS)[number])) {
      throw new Error(
        `decision record frontmatter contains unknown key '${fieldKey}'; valid keys are ${FRONTMATTER_KEYS.join(", ")}.`,
      );
    }
  }

  const id = requireString(fields.id, "id");
  const title = requireString(fields.title, "title");
  const context = requireString(fields.context, "context");
  const decision = requireString(fields.decision, "decision");
  const consequences =
    fields.consequences === undefined ? undefined : requireString(fields.consequences, "consequences");

  let status: DecisionStatus = DEFAULT_DECISION_STATUS;
  if (fields.status !== undefined && fields.status !== null) {
    if (!isDecisionStatus(fields.status)) {
      throw new Error(
        `decision '${id}' has invalid status '${JSON.stringify(fields.status)}'; valid statuses are ${DECISION_STATUSES.join(", ")}.`,
      );
    }
    status = fields.status;
  }

  const entityRefs = parseEntityRefs(fields.entityRefs);
  const supersedes =
    fields.supersedes === undefined ? undefined : requireString(fields.supersedes, "supersedes");


  const record: DecisionRecord = {
    id,
    title,
    status,
    context,
    decision,
    consequences,
    entityRefs,
    ...(supersedes !== undefined ? { supersedes } : {}),
  };
  void body;
  return record;
}

function requireString(field: unknown, key: string): string {
  if (field === undefined || field === null) {
    throw new Error(`decision record frontmatter is missing required field '${key}'.`);
  }
  if (typeof field !== "string") {
    throw new Error(
      `decision record frontmatter field '${key}' must be a string; got ${JSON.stringify(field)}.`,
    );
  }
  return field;
}

function parseEntityRefs(field: unknown): string[] {
  if (field === undefined) return [];
  if (!Array.isArray(field)) {
    throw new Error(
      `decision record frontmatter field 'entityRefs' must be an array of strings; got ${JSON.stringify(field)}.`,
    );
  }
  for (const entry of field) {
    if (typeof entry !== "string") {
      throw new Error(
        `decision record frontmatter 'entityRefs' entries must be strings; got ${JSON.stringify(entry)}.`,
      );
    }
  }
  return [...field];
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

function extractFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!text.startsWith("---\n")) {
    throw new Error(
      "decision record must start with a YAML frontmatter fence (`---\\n`); got a document with no leading fence.",
    );
  }
  const closeAt = text.indexOf("\n---", 4);
  if (closeAt === -1) {
    throw new Error(
      "decision record frontmatter is missing its closing fence (`\\n---`); the document is truncated.",
    );
  }
  const yamlBody = text.slice(4, closeAt);
  const after = text.slice(closeAt + 4);
  const body = after.startsWith("\n") ? after.slice(1) : after;
  return { fields: parseYamlMapping(yamlBody), body };
}

function parseYamlMapping(input: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const rawLine of input.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.startsWith("#")) continue;
    const colonAt = line.indexOf(":");
    if (colonAt === -1) {
      throw new Error(`decision record frontmatter line is not a key:value pair: "${line}".`);
    }
    const key = line.slice(0, colonAt).trim();
    const valueText = line.slice(colonAt + 1).trim();
    if (key.length === 0) {
      throw new Error(`decision record frontmatter has an empty key in line: "${line}".`);
    }
    fields[key] = decodeScalar(valueText);
  }
  return fields;
}

function decodeScalar(valueText: string): unknown {
  if (valueText.length === 0) return "";
  const lower = valueText.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (lower === "null" || lower === "~") return null;
  if (/^-?\d+$/.test(valueText)) return Number(valueText);
  if (/^".*"$/.test(valueText)) {
    return valueText
      .slice(1, -1)
      .replace(/\\\\/g, "\u0000")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\u0000/g, "\\");
  }
  if (/^\[.*\]$/.test(valueText)) return parseFlowList(valueText);
  return valueText;
}

function parseFlowList(valueText: string): unknown[] {
  const inner = valueText.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const out: string[] = [];
  let buf = "";
  let inQuotes = false;
  let escaped = false;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i]!;
    if (escaped) {
      buf += c;
      escaped = false;
      continue;
    }
    if (c === "\\") {
      buf += c;
      escaped = true;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      buf += c;
      continue;
    }
    if (c === "," && !inQuotes) {
      out.push(stripFlowStringQuotes(buf.trim()));
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.length > 0) out.push(stripFlowStringQuotes(buf.trim()));
  return out;
}

function stripFlowStringQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\\\/g, "\u0000")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\u0000/g, "\\");
  }
  return value;
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

export function applySupersede(
  records: readonly DecisionRecord[],
  targetId: string,
  replacement: DecisionRecord,
  hook?: (event: string) => void,
): DecisionRecord[] {
  const target = records.find((r) => r.id === targetId);
  if (!target) {
    throw new Error(
      `applySupersede cannot find target record '${targetId}' in the current record set.`,
    );
  }
  const existing = records.find((r) => r.id === replacement.id);
  if (existing && replacement.id !== targetId) {
    throw new Error(
      `applySupersede replacement id '${replacement.id}' already exists in the record set; ` +
        `pick a new id to avoid silently overwriting an unrelated decision.`,
    );
  }
  const next: DecisionRecord[] = records.map((r) =>
    r.id === targetId
      ? { ...r, status: "superseded" as DecisionStatus, supersedes: undefined }
      : r,
  );
  const replacementWithEdge: DecisionRecord = { ...replacement, supersedes: targetId };
  if (replacement.id === targetId) {
    const idx = next.findIndex((r) => r.id === targetId);
    next[idx] = replacementWithEdge;
  } else {
    next.push(replacementWithEdge);
  }

  hook?.(`write:${replacement.id}`);
  hook?.(`mutate:${targetId}:superseded`);

  return next;
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Filter a record set down to "standing" decisions (proposed + accepted).
 * Uses the explicitly-exported `ACTIVE_DECISION_STATUSES` set (rule 53 — one
 * classification source) so callers cannot drift.
 */
export function listActive(records: readonly DecisionRecord[]): DecisionRecord[] {
  return records.filter((r) => ACTIVE_DECISION_STATUSES.has(r.status));
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

export function isDecisionRecordsEnabled(config: CodingKnowledgeConfig): boolean {
  return config.enabled === true && config.decisionRecords === true;
}
