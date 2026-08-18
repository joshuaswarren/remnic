/**
 * skill-projection.ts — project active `procedure` memories into portable
 * `skills/<slug>/SKILL.md` bundles, and parse hand-authored bundles back into
 * procedure candidates (issue #2369).
 *
 * Pure module: no filesystem, no host coupling. The Codex materializer, the
 * `remnic export skills` CLI, and `remnic import skills` all consume these
 * functions so one slug + format contract serves every surface.
 *
 * Import is INERT by construction: this module only ever returns text and
 * parsed steps. It never resolves, loads, or executes a bundle resource.
 */

import { coerceBool, coerceNumber } from "../connectors/coerce.js";
import { isValidSkillSlug } from "../skills-registry.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import type { MemoryFile, MemoryStatus } from "../types.js";
import { parseProcedureStepsFromBody, type ProcedureStep } from "./procedure-types.js";

/** Provenance frontmatter keys. Namespaced so hosts treat them as opaque. */
export const SKILL_MEMORY_ID_KEY = "x-remnic-memory-id";
export const SKILL_UPDATED_KEY = "x-remnic-updated";
export const SKILL_SOURCE_KEY = "x-remnic-source";

/** File name every bundle directory must contain. */
export const SKILL_FILE_NAME = "SKILL.md";

/** Source tag written on imported procedure memories. */
export const SKILL_IMPORT_SOURCE = "skill-import";

/**
 * The ONLY statuses that may be projected (Review Prevention Checklist §41 —
 * define the active set, never an exclusion list). `pending_review`,
 * `rejected`, `quarantined`, `superseded`, `archived`, and `forgotten` are
 * withheld because a projected skill is loaded by a host with no further gate.
 */
const PROJECTABLE_STATUSES: Partial<Record<MemoryStatus, true>> = { active: true };

/** Default projection cap. `0` disables projection entirely. */
export const DEFAULT_SKILL_PROJECTION_MAX_SKILLS = 20;

/** Hard ceiling so a misconfigured cap cannot flood a host skills directory. */
const MAX_SKILL_PROJECTION_MAX_SKILLS = 500;

const MAX_SLUG_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 300;

export interface SkillBundleProvenance {
  /** Remnic memory id this bundle was projected from. */
  memoryId: string;
  /** `frontmatter.updated` of the source memory. */
  updated: string;
  /** `frontmatter.source` of the source memory, when present. */
  source?: string;
}

export interface SkillBundle {
  slug: string;
  frontmatter: { name: string; description: string };
  /** Markdown body: the stored procedure body (title line + `## Step N`). */
  body: string;
  provenance: SkillBundleProvenance;
}

export interface ProjectProceduresOptions {
  /** Cap on projected bundles. `0` projects nothing. Default 20. */
  maxSkills?: number;
  /** Slugs a projected bundle must not take (e.g. `BUILTIN_SKILLS` slugs). */
  reservedSlugs?: readonly string[];
}

export interface SkillProjectionConfig {
  enabled: boolean;
  maxSkills: number;
}

/**
 * Parse the `procedural.skillProjection` config block. Mirrors
 * `parseProceduralMaintenanceConfig`: string forms (`"false"`, `"0"`) coerce,
 * unrecognized values throw rather than silently defaulting.
 */
export function parseSkillProjectionConfig(raw: unknown): SkillProjectionConfig {
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error(
      `procedural.skillProjection must be an object (got ${JSON.stringify(raw)}). Omit the key to keep skill projection disabled (issue #2369).`,
    );
  }
  const block = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  let enabled = false;
  if (block.enabled !== undefined) {
    const coerced = coerceBool(block.enabled);
    if (coerced === undefined) {
      throw new Error(
        `procedural.skillProjection.enabled must be a boolean or one of "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off" (got ${JSON.stringify(block.enabled)}).`,
      );
    }
    enabled = coerced;
  }

  let maxSkills = DEFAULT_SKILL_PROJECTION_MAX_SKILLS;
  if (block.maxSkills !== undefined) {
    const coerced = coerceNumber(block.maxSkills);
    if (coerced === undefined || !Number.isFinite(coerced)) {
      throw new Error(
        `procedural.skillProjection.maxSkills must be a finite number (got ${JSON.stringify(block.maxSkills)}).`,
      );
    }
    if (!Number.isInteger(coerced)) {
      throw new Error(
        `procedural.skillProjection.maxSkills must be an integer (got ${JSON.stringify(block.maxSkills)}).`,
      );
    }
    if (coerced < 0 || coerced > MAX_SKILL_PROJECTION_MAX_SKILLS) {
      throw new Error(
        `procedural.skillProjection.maxSkills must be between 0 and ${MAX_SKILL_PROJECTION_MAX_SKILLS} (got ${JSON.stringify(block.maxSkills)}). 0 disables projection.`,
      );
    }
    // `0` is a documented disable value (§33) — never clamp it up.
    maxSkills = coerced;
  }

  return { enabled, maxSkills };
}

/**
 * Sanitize arbitrary text into a slug `isValidSkillSlug` accepts.
 * Deterministic: the same title always yields the same slug.
 */
export function sanitizeSkillSlug(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_LENGTH);
  const trimmed = trimDashes(base);
  return trimmed.length > 0 && isValidSkillSlug(trimmed) ? trimmed : "procedure";
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}

/** Append a suffix while keeping the slug valid and within the length cap. */
function withSuffix(base: string, suffix: string): string {
  const room = MAX_SLUG_LENGTH - suffix.length;
  const head = trimDashes(base.slice(0, Math.max(1, room)));
  const candidate = `${head.length > 0 ? head : "procedure"}${suffix}`;
  return isValidSkillSlug(candidate) ? candidate : `procedure${suffix}`;
}

/**
 * Reserve a slug: prefix reserved (built-in) collisions with `user-`, then
 * disambiguate duplicates with a stable `-2`, `-3`, … tiebreak so a batch with
 * repeated titles never writes two bundles to one directory (§37).
 */
function allocateSlug(base: string, used: Set<string>, reserved: ReadonlySet<string>): string {
  let candidate = reserved.has(base) ? withSuffix(`user-${base}`, "") : base;
  if (!isValidSkillSlug(candidate)) candidate = "procedure";
  if (!used.has(candidate) && !reserved.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  for (let n = 2; n < 10_000; n++) {
    const next = withSuffix(candidate, `-${n}`);
    if (!used.has(next) && !reserved.has(next)) {
      used.add(next);
      return next;
    }
  }
  // Unreachable in practice (10k distinct suffixes per base slug).
  throw new Error(`skill-projection: could not allocate a unique slug for ${base}`);
}

/** First non-empty line of the body, with a leading markdown heading stripped. */
export function procedureTitleFromBody(body: string): string {
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/^##\s+Step\s+\d+/i.test(trimmed)) break;
    return trimmed.replace(/^#{1,6}\s*/, "").trim();
  }
  return "";
}

/** Total comparator: newest first, `id` as the stable tiebreak (§12). */
function compareProcedures(a: MemoryFile, b: MemoryFile): number {
  const aTs = Date.parse(a.frontmatter.updated ?? "");
  const bTs = Date.parse(b.frontmatter.updated ?? "");
  const aVal = Number.isFinite(aTs) ? aTs : 0;
  const bVal = Number.isFinite(bTs) ? bTs : 0;
  if (aVal !== bVal) return bVal - aVal;
  const aId = a.frontmatter.id ?? "";
  const bId = b.frontmatter.id ?? "";
  if (aId < bId) return -1;
  if (aId > bId) return 1;
  return 0;
}

/**
 * Project procedure memories into skill bundles. Filters to `active`
 * procedures, orders deterministically, caps at `maxSkills`, and assigns
 * collision-free slugs.
 */
export function projectProceduresToSkills(
  memories: readonly MemoryFile[],
  options: ProjectProceduresOptions = {},
): SkillBundle[] {
  const maxSkills =
    typeof options.maxSkills === "number" && Number.isInteger(options.maxSkills) && options.maxSkills >= 0
      ? Math.min(MAX_SKILL_PROJECTION_MAX_SKILLS, options.maxSkills)
      : DEFAULT_SKILL_PROJECTION_MAX_SKILLS;
  if (maxSkills === 0) return [];

  const reserved = new Set((options.reservedSlugs ?? []).map((s) => s.trim().toLowerCase()));
  const candidates = memories
    .filter(
      (m) =>
        m.frontmatter.category === "procedure" &&
        PROJECTABLE_STATUSES[(m.frontmatter.status ?? "active") as MemoryStatus] === true &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    )
    .sort(compareProcedures)
    .slice(0, maxSkills);

  const used = new Set<string>();
  const bundles: SkillBundle[] = [];
  for (const memory of candidates) {
    // Drop the machine "[Attributes: ...]" footer writeMemory appends: a human
    // skill body must not carry it, and leaving it in would let the footer be
    // absorbed into the final step's intent on re-parse.
    const body = stripAttributesSuffix(memory.content.replace(/\r\n/g, "\n")).trim();
    const title = procedureTitleFromBody(body) || memory.frontmatter.id;
    const slug = allocateSlug(sanitizeSkillSlug(title), used, reserved);
    bundles.push({
      slug,
      frontmatter: {
        name: slug,
        description: title.slice(0, MAX_DESCRIPTION_LENGTH),
      },
      body: `${body}\n`,
      provenance: {
        memoryId: memory.frontmatter.id,
        updated: memory.frontmatter.updated,
        ...(memory.frontmatter.source ? { source: memory.frontmatter.source } : {}),
      },
    });
  }
  return bundles;
}

/**
 * Render one bundle as SKILL.md text. Scalars are emitted as YAML
 * double-quoted strings so a title containing `:` or `#` cannot corrupt the
 * frontmatter block.
 */
export function renderSkillBundle(bundle: SkillBundle): string {
  const lines = [
    "---",
    `name: ${yamlScalar(bundle.frontmatter.name)}`,
    `description: ${yamlScalar(bundle.frontmatter.description)}`,
    `${SKILL_MEMORY_ID_KEY}: ${yamlScalar(bundle.provenance.memoryId)}`,
    `${SKILL_UPDATED_KEY}: ${yamlScalar(bundle.provenance.updated)}`,
  ];
  if (bundle.provenance.source) {
    lines.push(`${SKILL_SOURCE_KEY}: ${yamlScalar(bundle.provenance.source)}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n${bundle.body.trimEnd()}\n`;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, " ").trim());
}

export interface ParsedSkillBundle {
  /** Directory name the bundle was read from (already sanitized by the caller). */
  slug: string;
  name?: string;
  description?: string;
  /** Markdown body with the frontmatter block removed. */
  body: string;
  /** Parsed `## Step N` sections, or `null` for a step-less body. */
  steps: ProcedureStep[] | null;
  provenance: { memoryId?: string; updated?: string; source?: string };
}

/**
 * Parse SKILL.md text. Frontmatter is optional; unknown keys are ignored.
 * Returns `null` when there is no body to import.
 */
export function parseSkillBundle(text: string, slug: string): ParsedSkillBundle | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Line scan rather than a lazy `[\s\S]*?` fence regex (issue #2439).
  let frontmatter: Record<string, string> = {};
  let bodyLines = lines;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
    if (close !== -1) {
      frontmatter = parseFlatFrontmatter(lines.slice(1, close).join("\n"));
      bodyLines = lines.slice(close + 1);
    }
  }
  const body = bodyLines.join("\n").trim();
  if (body.length === 0) return null;
  return {
    slug,
    name: frontmatter.name,
    description: frontmatter.description,
    body,
    steps: parseProcedureStepsFromBody(body),
    provenance: {
      memoryId: frontmatter[SKILL_MEMORY_ID_KEY],
      updated: frontmatter[SKILL_UPDATED_KEY],
      source: frontmatter[SKILL_SOURCE_KEY],
    },
  };
}

/**
 * Minimal flat `key: value` frontmatter reader. Nested blocks and sequences
 * (e.g. `allowed-tools:`) are skipped — the import path only consumes scalars.
 */
function parseFlatFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    if (/^\s/.test(line) || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (key.length === 0 || raw.length === 0) continue;
    out[key] = unquoteScalar(raw);
  }
  return out;
}

function unquoteScalar(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through to the literal slice below
    }
    return raw.slice(1, -1);
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  return raw;
}
