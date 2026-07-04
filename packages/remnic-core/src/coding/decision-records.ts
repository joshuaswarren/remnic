/**
 * Decision records — pure storage contract (issue #1548 Track A PR 1).
 *
 * The four-memory-shape memory layer stores architectural decisions as
 * markdown files with YAML frontmatter under the coding namespace. This
 * module is the **pure contract**: data shape, parse, serialise, validate,
 * and the supersede mutation. No filesystem, no orchestrator — callers
 * (PR 2's MCP/HTTP/CLI surfaces and the orchestrator's normal persist
 * pipeline) hang these helpers onto real storage.
 *
 * Why markdown + frontmatter?
 *  - QMD searches the body for free (rule 43 — storage chokepoint means the
 *    orchestrator persist pipeline fires for catalog + reindex + dedup).
 *  - Human-reviewable diff via the same tooling as any other memory page.
 *  - The body carries prose; the frontmatter carries the searchable,
 *    structured fields.
 *
 * Why this parser/serialiser and not a YAML dep?
 *  - The surface used here is intentionally narrow: scalar strings and
 *    flow-style arrays of strings. A full YAML dependency is heavier than
 *    the parser we need and would unlock a footgun (block-scalar
 *    representations, anchors, multiple-document streams) we deliberately
 *    want to be impossible.
 *
 * Supersede ordering (rule 25): the replacement record MUST land on disk
 * BEFORE the superseded record's `status` flips, so a process crash between
 * the two writes leaves the new decision discoverable rather than nothing.
 *
 * Pure module — type-only import of the plugin config interface keeps this
 * dependency-free (the entry types live in `../types.ts`).
 */
import type { CodingKnowledgeConfig } from "../types.js";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export type DecisionStatus = "proposed" | "accepted" | "superseded" | "rejected";

export const DECISION_STATUSES = [
  "proposed",
  "accepted",
  "superseded",
  "rejected",
] as const satisfies readonly DecisionStatus[];

/**
 * The "active" statuses callers surface in standing-decisions lists, briefing
 * text, and the search-by-default index. Exported as a frozen set so the
 * decision-records tests, the briefing helper, and the future list surface
 * share one declaration (rule 53 — single source of truth for classification).
 *
 * Stand-up note: superseded + rejected are intentionally excluded. A supersede
 * edge (`b.supersedes = "a"`) tells callers what to fall back to.
 */
export const ACTIVE_DECISION_STATUSES: ReadonlySet<DecisionStatus> = new Set<DecisionStatus>([
  "proposed",
  "accepted",
]);

/**
 * Least-privileged default for a parsed record whose frontmatter omits
 * `status` (rule 48). "Proposed" — never "accepted" — because accepting a
 * decision is a deliberate operator action.
 */
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
// Gate / type guard
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
// Serialise
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
  // Trailing newline keeps the file POSIX-well-formed for `cat`/editors.
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
  // Inside a double-quoted YAML scalar, escape backslashes and double-quotes
  // AND emit real newlines as a `\n` escape (the parser below mirrors this).
  // Keeping all scalars single-line makes the line-based frontmatter parser
  // safe and the file diff-friendly.
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Parse
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

  // Surface unexpected keys early — silent drift is rule 51's worst case.
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

  // The parser is intentionally permissive about the on-disk shape. A
  // record with `status: "superseded"` and no `supersedes` field is the
  // shape `applySupersede` writes for the replaced record — the
  // `supersedes` edge lives on the *replacement*, not the superseded one,
  // so this branch must accept the canonical serialised form and stay
  // round-trippable. Excluding superseded records from "active" listings is
  // `listActive`'s job (rule 53, single classification source), not the
  // parser's.

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
  // Body is preserved byte-for-byte on serialise; we don't introspect it
  // here so format-neutral round-trips stay open (rule 38).
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
// YAML frontmatter subset (intentionally narrow)
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
    // Restore escapes — order matters: handle the backslash-pair first so
    // the literal `\\n` we emit from `escapeYamlString` decodes to a real
    // newline (NOT a backslash-n).
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
  // Track whether we are sitting on a backslash so that `\"` inside a
  // quoted element is recognised as an escaped quote rather than a
  // closing quote. Without this flag, a ref containing a literal `"`
  // (e.g. an entity id like `org/dept/\"lead\"`) would close its own
  // element early and the next comma would split a string in half
  // (cursor bug d16b2a18, review round on PR #1590).
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
// Supersede
// ──────────────────────────────────────────────────────────────────────────

/**
 * Pure supersede mutation: given the current record set, the id of a record
 * to supersede, and the replacement record (already accepted), returns a new
 * list with the replacement appended and the old record flipped to
 * `superseded`.
 *
 * The hook fires `event: "write:<replacementId>"` BEFORE
 * `event: "mutate:<oldId>:superseded"` so storage callers can guarantee
 * disk-order matches the rule-25 requirement (the replacement lands before
 * the old record's status flips).
 */
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
  // Reject a collision where `replacement.id` already exists in the record
  // set. Without this guard, an operator typo or MCP rename can silently
  // overwrite an unrelated decision with a record that `supersedes` itself,
  // corrupting the decision history (chatgpt-codex-connector review on
  // PR #1590). The replacement must either be a NEW id (append) or the
  // same id as the target (in-place replacement — supported as a separate
  // edge case below).
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
  // Same-id replacement path: a single record swaps its body in place. The
  // entry keeps its place in the array (so the listing order is preserved)
  // and the new record still carries the supersede edge for traceability.
  if (replacement.id === targetId) {
    const idx = next.findIndex((r) => r.id === targetId);
    next[idx] = replacementWithEdge;
  } else {
    next.push(replacementWithEdge);
  }

  // Same-id replacement path: the write and mutate targets are the same
  // record, so the mutate would erase the in-place edit. Skip the mutate
  // hook (chatgpt-codex-connector P2 review on PR #1593 round 8).
  const isSameIdReplacement = replacement.id === targetId;
  hook?.(`write:${replacement.id}`);
  if (!isSameIdReplacement) {
    hook?.(`mutate:${targetId}:superseded`);
  }

  return next;
}

// ──────────────────────────────────────────────────────────────────────────
// Listing
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
// Coding-knowledge feature gate (Track A PR 1 wiring boundary)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Single source of truth for "are decision records active for this operator?"
 * (rule 39 — every behaviour dependent on Track A consults this, not raw
 * config reads). The master gate is `codingKnowledge.enabled`; the
 * decision-record subsystem has its own on-switch.
 */
export function isDecisionRecordsEnabled(config: CodingKnowledgeConfig): boolean {
  return config.enabled === true && config.decisionRecords === true;
}
