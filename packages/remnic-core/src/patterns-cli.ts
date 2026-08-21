/**
 * `remnic patterns` CLI helpers (issue #687 PR 4/4).
 *
 * Pure functions that:
 *
 *   1. Validate `--limit`, `--category`, `--since`, `--format` for
 *      `remnic patterns list` and `--format` for
 *      `remnic patterns explain <id>` (CLAUDE.md rules 14 + 51 — flags
 *      throw listed-options errors instead of silently defaulting).
 *
 *   2. Filter the memory corpus to canonical memories produced by the
 *      pattern-reinforcement maintenance job from issue #687 PR 2/4
 *      (`reinforcement_count > 0`) and sort them by reinforcement
 *      count, with `last_reinforced_at` (then `id`) as stable
 *      tiebreakers (CLAUDE.md rule 19).
 *
 *   3. Reconstruct a single canonical's full picture: its
 *      `derived_from` provenance chain (PR 2/4 stamps these), the
 *      cluster members it absorbed (memories pointing at it via
 *      `supersededBy`), and the canonical body so operators can read
 *      it inline.
 *
 *   4. Render `text` (default) / `markdown` / `json` output for both
 *      commands.  The CLI handler in `cli.ts` stays thin and delegates
 *      formatting here so HTTP / MCP surfaces (if added later) can
 *      reuse the same renderers (CLAUDE.md rule 22 — never fork
 *      formatting).
 */

import type { MemoryCategory, MemoryFile } from "./types.js";
import { DERIVED_FROM_MEMORY_ID_RE } from "./consolidation-operator.js";
import { parseStrictCliDate } from "./training-export/date-parse.js";

export const PATTERNS_OUTPUT_FORMATS = ["text", "markdown", "json"] as const;
export type PatternsOutputFormat = (typeof PATTERNS_OUTPUT_FORMATS)[number];

// ───────────────────────────────────────────────────────────────────────────
// Flag validation
// ───────────────────────────────────────────────────────────────────────────

/**
 * Validate `--format <fmt>`.  Throws a listed-options error for any
 * value not in `PATTERNS_OUTPUT_FORMATS`.  Returns `"text"` when the
 * value is `undefined` (no flag supplied).
 */
export function parsePatternsFormat(value: unknown): PatternsOutputFormat {
  if (value === undefined || value === null) return "text";
  if (
    typeof value !== "string" ||
    !(PATTERNS_OUTPUT_FORMATS as readonly string[]).includes(value)
  ) {
    throw new Error(
      `--format expects one of ${PATTERNS_OUTPUT_FORMATS.join(", ")}; got ${JSON.stringify(value)}`,
    );
  }
  return value as PatternsOutputFormat;
}

/**
 * Validate `--limit <N>`.  Must be a positive integer.  Returns
 * `undefined` when the flag is absent (the caller falls back to a
 * default).
 */
export function parsePatternsLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `--limit expects a positive integer; got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

/**
 * Validate `--category <list>`.  Accepts a comma-separated list of
 * non-empty trimmed tokens.  Returns the deduplicated list, or
 * `undefined` when no flag was supplied.  CLAUDE.md rules 14 + 51:
 * `--category` with no value or with a value that resolves to zero
 * tokens is rejected.
 */
export function parsePatternsCategory(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(
      `--category expects a comma-separated list of category names; got ${JSON.stringify(value)}`,
    );
  }
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new Error(
      `--category expects at least one non-empty category name; got ${JSON.stringify(value)}`,
    );
  }
  // Deduplicate while preserving first-seen order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const part of parts) {
    if (!seen.has(part)) {
      seen.add(part);
      unique.push(part);
    }
  }
  return unique;
}

/**
 * Validate `--since <ISO>`.  Delegates to `parseStrictCliDate` which
 * enforces a strict ISO 8601 shape and rejects calendar overflows and
 * non-ISO formats (e.g. "12/25/2026", "Dec 25 2026") that bare
 * `Date.parse()` would silently accept.  Returns the canonical ISO
 * string (round-trip through `toISOString`) so downstream comparisons
 * use a consistent form.
 */
export function parsePatternsSince(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `--since expects an ISO 8601 timestamp (e.g. 2026-04-01T00:00:00Z); got ${JSON.stringify(value)}`,
    );
  }
  // parseStrictCliDate throws with a descriptive message on invalid input.
  return parseStrictCliDate(value.trim(), "--since").toISOString();
}

export interface ParsedPatternsListOptions {
  format: PatternsOutputFormat;
  limit?: number;
  categories?: string[];
  sinceIso?: string;
}

export interface ParsedPatternsExplainOptions {
  format: PatternsOutputFormat;
}

/**
 * Validate the full option bag for `remnic patterns list`.  Extracted
 * from the CLI handler so validation can be unit-tested without
 * booting an orchestrator (CLAUDE.md rules 14 + 51).
 */
export function parsePatternsListOptions(
  options: Record<string, unknown>,
): ParsedPatternsListOptions {
  const format = parsePatternsFormat(options.format);
  const limit = parsePatternsLimit(options.limit);
  const categories = parsePatternsCategory(options.category);
  const sinceIso = parsePatternsSince(options.since);
  return {
    format,
    ...(limit !== undefined ? { limit } : {}),
    ...(categories !== undefined ? { categories } : {}),
    ...(sinceIso !== undefined ? { sinceIso } : {}),
  };
}

/**
 * Validate `remnic patterns explain` options + positional id.  Throws
 * when `<memoryId>` is missing or empty.
 */
export function parsePatternsExplainOptions(
  rawId: unknown,
  options: Record<string, unknown>,
): { id: string } & ParsedPatternsExplainOptions {
  if (typeof rawId !== "string" || rawId.trim().length === 0) {
    throw new Error("patterns explain: <memoryId> is required and must be non-empty");
  }
  const format = parsePatternsFormat(options.format);
  return { id: rawId.trim(), format };
}

// ───────────────────────────────────────────────────────────────────────────
// Core list / explain behavior
// ───────────────────────────────────────────────────────────────────────────

export interface PatternListRow {
  id: string;
  category: MemoryCategory;
  reinforcementCount: number;
  lastReinforcedAt?: string;
  status: string;
  /** First non-empty content line, trimmed to ~120 chars for the table. */
  preview: string;
  /** Full path on disk (relative to memoryDir) for operators who want to inspect the file. */
  path: string;
}

const DEFAULT_LIST_LIMIT = 50;

/**
 * Filter, sort, and slice the memory corpus down to the rows the
 * `remnic patterns list` command should print.
 *
 * Rules (each one is exercised by `tests/cli/patterns.test.ts`):
 *
 *   - Memories without `reinforcement_count` (or with a count <= 0) are
 *     dropped — these are not pattern canonicals.
 *   - When `categories` is supplied, only memories whose
 *     `frontmatter.category` is in the list survive.
 *   - When `sinceIso` is supplied, only memories whose
 *     `last_reinforced_at` is `>= sinceIso` survive.  Memories without
 *     `last_reinforced_at` are dropped under `--since` (PR 2/4 always
 *     stamps the timestamp alongside the count, so a missing timestamp
 *     means a malformed file the operator should not see in this view).
 *   - Sort by `reinforcement_count DESC`, then `last_reinforced_at
 *     DESC`, then `id ASC` for a stable, deterministic order
 *     (CLAUDE.md rule 19).
 *   - Apply `limit` (default 50).
 */
export function collectPatternMemories(
  memories: readonly MemoryFile[],
  opts: ParsedPatternsListOptions,
): PatternListRow[] {
  const sinceMs =
    opts.sinceIso !== undefined ? Date.parse(opts.sinceIso) : undefined;
  const categorySet =
    opts.categories !== undefined ? new Set(opts.categories) : undefined;

  const rows: PatternListRow[] = [];
  for (const memory of memories) {
    const fm = memory.frontmatter;
    const count = fm.reinforcement_count;
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
      continue;
    }
    if (categorySet !== undefined && !categorySet.has(fm.category)) {
      continue;
    }
    if (sinceMs !== undefined) {
      if (typeof fm.last_reinforced_at !== "string") continue;
      const ts = Date.parse(fm.last_reinforced_at);
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
    }
    rows.push({
      id: fm.id,
      category: fm.category,
      reinforcementCount: count,
      ...(fm.last_reinforced_at !== undefined
        ? { lastReinforcedAt: fm.last_reinforced_at }
        : {}),
      status: fm.status ?? "active",
      preview: extractPreview(memory.content),
      path: memory.path,
    });
  }

  rows.sort((a, b) => {
    if (b.reinforcementCount !== a.reinforcementCount) {
      return b.reinforcementCount - a.reinforcementCount;
    }
    // Guard NaN: malformed date strings make Date.parse return NaN, which
    // breaks the sort contract (NaN comparator return == non-deterministic
    // ordering).  Treat invalid/missing timestamps as 0 (oldest possible).
    const aRaw = a.lastReinforcedAt ? Date.parse(a.lastReinforcedAt) : NaN;
    const bRaw = b.lastReinforcedAt ? Date.parse(b.lastReinforcedAt) : NaN;
    const aTs = Number.isFinite(aRaw) ? aRaw : 0;
    const bTs = Number.isFinite(bRaw) ? bRaw : 0;
    if (bTs !== aTs) return bTs - aTs;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  return rows.slice(0, limit);
}

export interface PatternDerivedFromEntry {
  /** Raw `"<path>:<version>"` reference exactly as stored in `derived_from`. */
  ref: string;
  /** Source memory id, or the path component for older `path:version` references. */
  path: string;
  /** Page-version number component for older `path:version` references. */
  version: number | null;
  /** True when an older path-version reference had an invalid version component. */
  malformed?: boolean;
}

export interface PatternClusterMember {
  id: string;
  status: string;
  supersededAt?: string;
  path: string;
  preview: string;
}

export interface PatternExplainDetail {
  id: string;
  category: MemoryCategory;
  reinforcementCount: number;
  lastReinforcedAt?: string;
  status: string;
  derivedVia?: string;
  /** Full canonical body (frontmatter stripped). */
  canonicalContent: string;
  canonicalPath: string;
  /** Parsed `derived_from` chain — empty when PR 2/4 did not stamp it. */
  derivedFrom: PatternDerivedFromEntry[];
  /** Memories whose `supersededBy === <id>`, sorted by `supersededAt DESC` then `id ASC`. */
  clusterMembers: PatternClusterMember[];
}

/**
 * Build the structured detail object for a single canonical.  Returns
 * `null` when the memory is not found or has never been touched by
 * pattern reinforcement (i.e., no `reinforcement_count`).  The CLI
 * handler then prints a clean "not a pattern" error rather than
 * leaking an empty document.
 */
export function explainPatternMemory(
  memories: readonly MemoryFile[],
  id: string,
): PatternExplainDetail | null {
  const canonical = memories.find((m) => m.frontmatter.id === id);
  if (!canonical) return null;
  const fm = canonical.frontmatter;
  const count = fm.reinforcement_count;
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
    return null;
  }

  const derivedFrom: PatternDerivedFromEntry[] = (fm.derived_from ?? []).map(
    (ref) => {
      const lastColon = ref.lastIndexOf(":");
      const pathLikeRef = looksLikeDerivedFromPath(ref);
      if (lastColon >= 0) {
        const path = ref.slice(0, lastColon);
        const versionStr = ref.slice(lastColon + 1);
        if (
          looksLikeDerivedFromPath(path) &&
          /^\d+$/.test(versionStr)
        ) {
          return { ref, path, version: Number(versionStr) };
        }
        if (!pathLikeRef && DERIVED_FROM_MEMORY_ID_RE.test(ref)) {
          return { ref, path: ref, version: null };
        }
        return { ref, path: ref, version: null, malformed: true };
      }
      if (DERIVED_FROM_MEMORY_ID_RE.test(ref)) {
        return {
          ref,
          path: ref,
          version: null,
        };
      }
      return { ref, path: ref, version: null, malformed: true };
    },
  );

  const members: PatternClusterMember[] = [];
  for (const m of memories) {
    if (m.frontmatter.supersededBy === id) {
      members.push({
        id: m.frontmatter.id,
        status: m.frontmatter.status ?? "active",
        ...(m.frontmatter.supersededAt !== undefined
          ? { supersededAt: m.frontmatter.supersededAt }
          : {}),
        path: m.path,
        preview: extractPreview(m.content),
      });
    }
  }
  members.sort((a, b) => {
    // Guard NaN: same rationale as collectPatternMemories sort — malformed
    // supersededAt strings must not produce a NaN return from the comparator.
    const aRaw = a.supersededAt ? Date.parse(a.supersededAt) : NaN;
    const bRaw = b.supersededAt ? Date.parse(b.supersededAt) : NaN;
    const aTs = Number.isFinite(aRaw) ? aRaw : 0;
    const bTs = Number.isFinite(bRaw) ? bRaw : 0;
    if (bTs !== aTs) return bTs - aTs;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return {
    id: fm.id,
    category: fm.category,
    reinforcementCount: count,
    ...(fm.last_reinforced_at !== undefined
      ? { lastReinforcedAt: fm.last_reinforced_at }
      : {}),
    status: fm.status ?? "active",
    ...(fm.derived_via !== undefined ? { derivedVia: fm.derived_via } : {}),
    canonicalContent: canonical.content.trim(),
    canonicalPath: canonical.path,
    derivedFrom,
    clusterMembers: members,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Renderers
// ───────────────────────────────────────────────────────────────────────────

export function renderPatternsList(
  rows: readonly PatternListRow[],
  format: PatternsOutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify({ rows }, null, 2);
  }
  if (rows.length === 0) {
    if (format === "markdown") {
      return "# Pattern memories\n\n_No reinforced patterns found._\n";
    }
    return "No reinforced patterns found.";
  }
  if (format === "markdown") {
    const lines: string[] = ["# Pattern memories", ""];
    lines.push("| Count | ID | Category | Last reinforced | Preview |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const row of rows) {
      const last = row.lastReinforcedAt ?? "—";
      const preview = escapePipes(row.preview);
      lines.push(
        `| ${row.reinforcementCount} | \`${row.id}\` | ${row.category} | ${last} | ${preview} |`,
      );
    }
    return lines.join("\n") + "\n";
  }
  // text
  const lines: string[] = [];
  lines.push(`Pattern memories (${rows.length}):`);
  lines.push("");
  for (const row of rows) {
    const last = row.lastReinforcedAt ?? "—";
    lines.push(
      `  [${row.reinforcementCount}x] ${row.id}  (${row.category}, last_reinforced=${last}, status=${row.status})`,
    );
    if (row.preview.length > 0) {
      lines.push(`        ${row.preview}`);
    }
    lines.push(`        path: ${row.path}`);
  }
  return lines.join("\n");
}

export function renderPatternExplain(
  detail: PatternExplainDetail,
  format: PatternsOutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(detail, null, 2);
  }
  const last = detail.lastReinforcedAt ?? "—";
  const derivedVia = detail.derivedVia ?? "—";
  if (format === "markdown") {
    const lines: string[] = [];
    lines.push(`# Pattern: \`${detail.id}\``);
    lines.push("");
    lines.push(`- **Reinforcement count:** ${detail.reinforcementCount}`);
    lines.push(`- **Last reinforced:** ${last}`);
    lines.push(`- **Category:** ${detail.category}`);
    lines.push(`- **Status:** ${detail.status}`);
    lines.push(`- **Derived via:** ${derivedVia}`);
    lines.push(`- **Path:** \`${detail.canonicalPath}\``);
    lines.push("");
    lines.push("## Canonical content");
    lines.push("");
    lines.push("```");
    lines.push(detail.canonicalContent);
    lines.push("```");
    lines.push("");
    lines.push(`## Derived from (${detail.derivedFrom.length})`);
    lines.push("");
    if (detail.derivedFrom.length === 0) {
      lines.push("_No derived_from entries recorded._");
    } else {
      for (const entry of detail.derivedFrom) {
        const versionStr =
          entry.version !== null
            ? ` v${entry.version}`
            : entry.malformed
              ? " (malformed)"
              : "";
        lines.push(`- \`${entry.path}\`${versionStr}`);
      }
    }
    lines.push("");
    lines.push(`## Cluster members (${detail.clusterMembers.length})`);
    lines.push("");
    if (detail.clusterMembers.length === 0) {
      lines.push("_No superseded members reference this canonical._");
    } else {
      for (const member of detail.clusterMembers) {
        const ts = member.supersededAt ?? "—";
        lines.push(`- \`${member.id}\` (status=${member.status}, supersededAt=${ts})`);
        if (member.preview.length > 0) {
          lines.push(`  - ${escapePipes(member.preview)}`);
        }
      }
    }
    return lines.join("\n") + "\n";
  }
  // text
  const lines: string[] = [];
  lines.push(`Pattern: ${detail.id}`);
  lines.push(`  reinforcement_count: ${detail.reinforcementCount}`);
  lines.push(`  last_reinforced_at: ${last}`);
  lines.push(`  category:           ${detail.category}`);
  lines.push(`  status:             ${detail.status}`);
  lines.push(`  derived_via:        ${derivedVia}`);
  lines.push(`  path:               ${detail.canonicalPath}`);
  lines.push("");
  lines.push("Canonical content:");
  for (const line of detail.canonicalContent.split("\n")) {
    lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push(`Derived from (${detail.derivedFrom.length}):`);
  if (detail.derivedFrom.length === 0) {
    lines.push("  (none)");
  } else {
    for (const entry of detail.derivedFrom) {
      const versionStr =
        entry.version !== null
          ? ` v${entry.version}`
          : entry.malformed
            ? " (malformed)"
            : "";
      lines.push(`  - ${entry.path}${versionStr}`);
    }
  }
  lines.push("");
  lines.push(`Cluster members (${detail.clusterMembers.length}):`);
  if (detail.clusterMembers.length === 0) {
    lines.push("  (none)");
  } else {
    for (const member of detail.clusterMembers) {
      const ts = member.supersededAt ?? "—";
      lines.push(`  - ${member.id} (status=${member.status}, supersededAt=${ts})`);
      if (member.preview.length > 0) {
        lines.push(`      ${member.preview}`);
      }
    }
  }
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────────

function extractPreview(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return "";
  const firstLine = trimmed.split("\n").find((line) => line.trim().length > 0) ?? "";
  const collapsed = firstLine.trim().replace(/\s+/g, " ");
  if (collapsed.length <= 120) return collapsed;
  return collapsed.slice(0, 117) + "...";
}

function looksLikeDerivedFromPath(value: string): boolean {
  return value.includes("/") || value.includes(".");
}

/**
 * Escape characters that would break a Markdown table cell:
 *   - backslashes first (so the `\|` escape below isn't double-escaped)
 *   - then pipe characters
 *
 * CodeQL "Incomplete string escaping or encoding": backslash must be
 * escaped before pipe so that a literal `\` in content isn't
 * misinterpreted as part of a `\|` escape sequence.
 */
function escapePipes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}
