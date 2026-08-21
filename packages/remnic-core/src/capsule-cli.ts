/**
 * Pure-function helpers for the `remnic capsule` CLI surface (issue #676 PR 6/6).
 *
 * All functions here are free of orchestrator / filesystem side-effects so
 * they can be unit-tested without booting the gateway (CLAUDE.md rules 14, 51).
 *
 * Responsibilities:
 *  - Input validation + option parsing for every capsule sub-command flag.
 *  - Rendering of `capsule list` and `capsule inspect` output in text /
 *    markdown / json forms.
 *
 * The actual I/O (export, import, merge, directory listing, manifest read) is
 * wired in `cli.ts` because those operations need the orchestrator's config.
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type CapsuleOutputFormat = "text" | "markdown" | "json";

/**
 * Metadata entry returned by `capsule list` for a single archive file found
 * in the capsule store directory.
 */
export interface CapsuleListEntry {
  /** Capsule id extracted from the filename (slug before `.capsule.json.gz`). */
  id: string;
  /** Absolute path to the `.capsule.json.gz` archive. */
  archivePath: string;
  /** Absolute path to the sidecar `.manifest.json`, or null if missing. */
  manifestPath: string | null;
  /** `createdAt` ISO string from the sidecar manifest, or null if unreadable. */
  createdAt: string | null;
  /** `pluginVersion` from the sidecar manifest, or null. */
  pluginVersion: string | null;
  /** `files` array length from the sidecar manifest, or null. */
  fileCount: number | null;
  /** `capsule.description` from the sidecar manifest, or null. */
  description: string | null;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate and coerce the `--format` flag value.
 *
 * Rule 51: invalid values must throw with a listed-options error, not silently
 * fall back to a default.
 */
export function parseCapsuleOutputFormat(
  raw: unknown,
): CapsuleOutputFormat {
  if (raw === undefined || raw === null) return "text";
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      `--format expects one of text, markdown, json; got ${JSON.stringify(raw)}`,
    );
  }
  const v = raw.trim() as CapsuleOutputFormat;
  if (v !== "text" && v !== "markdown" && v !== "json") {
    throw new Error(
      `--format expects one of text, markdown, json; got ${JSON.stringify(raw)}`,
    );
  }
  return v;
}

/**
 * Validate and coerce the `--mode` flag for `capsule import`.
 */
export function parseCapsuleImportMode(
  raw: unknown,
): "skip" | "overwrite" | "fork" {
  if (raw === undefined || raw === null) return "skip";
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      `--mode expects one of skip, overwrite, fork; got ${JSON.stringify(raw)}`,
    );
  }
  const v = raw.trim();
  if (v !== "skip" && v !== "overwrite" && v !== "fork") {
    throw new Error(
      `--mode expects one of skip, overwrite, fork; got ${JSON.stringify(raw)}`,
    );
  }
  return v as "skip" | "overwrite" | "fork";
}

/**
 * Validate and coerce the `--conflict-mode` flag for `capsule merge`.
 */
export function parseCapsuleConflictMode(
  raw: unknown,
): "skip-conflicts" | "prefer-source" | "prefer-local" {
  if (raw === undefined || raw === null) return "skip-conflicts";
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      `--conflict-mode expects one of skip-conflicts, prefer-source, prefer-local; got ${JSON.stringify(raw)}`,
    );
  }
  const v = raw.trim();
  if (v !== "skip-conflicts" && v !== "prefer-source" && v !== "prefer-local") {
    throw new Error(
      `--conflict-mode expects one of skip-conflicts, prefer-source, prefer-local; got ${JSON.stringify(raw)}`,
    );
  }
  return v as "skip-conflicts" | "prefer-source" | "prefer-local";
}

/**
 * Parse and validate the `--since` ISO-8601 string.
 *
 * Accepts date-only (`YYYY-MM-DD`) and date+time with explicit timezone
 * (`YYYY-MM-DDTHH:MM...Z` / `±HH:MM`). Rejects datetime without a timezone
 * designator (host-dependent interpretation, Rule 51).
 */
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2}))?$/;

export function parseCapsuleSince(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error(
      `--since expects an ISO 8601 timestamp; got ${JSON.stringify(raw)}`,
    );
  }
  if (raw.trim() === "") {
    throw new Error(`--since expects an ISO 8601 timestamp; received empty string`);
  }
  if (!ISO_8601_RE.test(raw)) {
    throw new Error(
      `--since is not a valid ISO 8601 timestamp: ${raw}. ` +
        `Accepted forms: YYYY-MM-DD, YYYY-MM-DDTHH:MM:SSZ, YYYY-MM-DDTHH:MM:SS±HH:MM`,
    );
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`--since is not a valid ISO 8601 timestamp: ${raw}`);
  }
  // Calendar overflow detection (same logic as capsule-export.ts parseSince).
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) {
    const offsetMatch = /([+-])(\d{2}):?(\d{2})$/.exec(raw);
    let displayMs = ms;
    if (offsetMatch) {
      const sign = offsetMatch[1] === "-" ? -1 : 1;
      const offsetMin = sign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]));
      displayMs = ms + offsetMin * 60_000;
    }
    const dd = new Date(displayMs);
    if (
      dd.getUTCFullYear() !== Number(m[1]) ||
      dd.getUTCMonth() + 1 !== Number(m[2]) ||
      dd.getUTCDate() !== Number(m[3])
    ) {
      throw new Error(
        `--since: calendar overflow — ${raw} normalises to a different calendar date`,
      );
    }
  }
  return raw;
}

/**
 * Parse a comma-separated `--include-kinds` value into an array of non-empty
 * top-level directory names. Rejects values containing path separators.
 */
export function parseCapsuleIncludeKinds(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error(
      `--include-kinds expects a comma-separated list of directory names; got ${JSON.stringify(raw)}`,
    );
  }
  if (raw.trim() === "") {
    throw new Error(
      `--include-kinds expects at least one non-empty kind name`,
    );
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error(`--include-kinds expects at least one non-empty kind name`);
  }
  for (const p of parts) {
    if (p.includes("/") || p.includes("\\")) {
      throw new Error(
        `--include-kinds entries must be top-level directory names (no path separators): ${p}`,
      );
    }
  }
  // Deduplicate while preserving order.
  return [...new Set(parts)];
}

/**
 * Parse a comma-separated peer id value into an array of peer ids.
 */
export function parseCapsulePeers(
  raw: unknown,
  optionName = "--peers",
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error(
      `${optionName} expects a comma-separated list of peer ids; got ${JSON.stringify(raw)}`,
    );
  }
  if (raw.trim() === "") {
    throw new Error(`${optionName} expects at least one non-empty peer id`);
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error(`${optionName} expects at least one non-empty peer id`);
  }
  for (const p of parts) {
    if (p.includes("/") || p.includes("\\") || p === "." || p === "..") {
      throw new Error(
        `${optionName} entries must be plain id tokens (no path separators): ${p}`,
      );
    }
  }
  return [...new Set(parts)];
}

// ---------------------------------------------------------------------------
// Parsed option bags (returned by the parse helpers below and consumed by
// cli.ts action handlers).
// ---------------------------------------------------------------------------

export interface CapsuleExportOptions {
  name: string;
  outDir: string | undefined;
  since: string | undefined;
  includeKinds: string[] | undefined;
  peerIds: string[] | undefined;
}

export interface CapsuleImportOptions {
  archive: string;
  mode: "skip" | "overwrite" | "fork";
}

export interface CapsuleMergeOptions {
  archive: string;
  conflictMode: "skip-conflicts" | "prefer-source" | "prefer-local";
}

export interface CapsuleListOptions {
  format: CapsuleOutputFormat;
  capsulesDir: string;
}

export interface CapsuleInspectOptions {
  archive: string;
  format: CapsuleOutputFormat;
}

// ---------------------------------------------------------------------------
// Option bag parsers (Rule 51: validate + throw on bad input, never silently
// default to a value that hides user misconfiguration).
// ---------------------------------------------------------------------------

export function parseCapsuleExportOptions(
  nameArg: unknown,
  opts: Record<string, unknown>,
): CapsuleExportOptions {
  if (typeof nameArg !== "string" || nameArg.trim() === "") {
    throw new Error(
      `capsule export: --name is required (e.g. "remnic capsule export --name my-capsule")`,
    );
  }
  const name = nameArg.trim();

  const outDir =
    typeof opts.outDir === "string" && opts.outDir.trim() !== ""
      ? opts.outDir.trim()
      : undefined;

  const since = parseCapsuleSince(opts.since);
  const includeKinds = parseCapsuleIncludeKinds(opts.includeKinds);
  const peerIds = parseCapsulePeers(opts.peerIds, "--peer-ids");

  return { name, outDir, since, includeKinds, peerIds };
}

export function parseCapsuleImportOptions(
  archiveArg: unknown,
  opts: Record<string, unknown>,
): CapsuleImportOptions {
  if (typeof archiveArg !== "string" || archiveArg.trim() === "") {
    throw new Error(
      `capsule import: <archive> path is required (e.g. "remnic capsule import /path/to/my-capsule.capsule.json.gz")`,
    );
  }
  const archive = archiveArg.trim();
  const mode = parseCapsuleImportMode(opts.mode);
  return { archive, mode };
}

export function parseCapsuleMergeOptions(
  archiveArg: unknown,
  opts: Record<string, unknown>,
): CapsuleMergeOptions {
  if (typeof archiveArg !== "string" || archiveArg.trim() === "") {
    throw new Error(
      `capsule merge: <archive> path is required (e.g. "remnic capsule merge /path/to/my-capsule.capsule.json.gz")`,
    );
  }
  const archive = archiveArg.trim();
  const conflictMode = parseCapsuleConflictMode(opts.conflictMode);
  return { archive, conflictMode };
}

export function parseCapsuleListOptions(
  opts: Record<string, unknown>,
  defaultCapsulesDir: string,
): CapsuleListOptions {
  const format = parseCapsuleOutputFormat(opts.format);
  const rawDir =
    typeof opts.dir === "string" && opts.dir.trim() !== ""
      ? opts.dir.trim()
      : undefined;
  const capsulesDir = rawDir ?? defaultCapsulesDir;
  return { format, capsulesDir };
}

export function parseCapsuleInspectOptions(
  archiveArg: unknown,
  opts: Record<string, unknown>,
): CapsuleInspectOptions {
  if (typeof archiveArg !== "string" || archiveArg.trim() === "") {
    throw new Error(
      `capsule inspect: <archive> path is required (e.g. "remnic capsule inspect my-capsule.capsule.json.gz")`,
    );
  }
  const archive = archiveArg.trim();
  const format = parseCapsuleOutputFormat(opts.format);
  return { archive, format };
}

// ---------------------------------------------------------------------------
// Default capsules directory
// ---------------------------------------------------------------------------

/**
 * Return the default capsule store directory for a given memory root.
 * This mirrors the `outDir` default in `exportCapsule` (`<root>/.capsules`)
 * so that `capsule list` discovers archives written by `capsule export`
 * without extra configuration.
 *
 * For `capsule list`, the POSIX conventional path is:
 *   `<memoryDir>/.capsules`
 *
 * Operators can override it with `--dir <path>` at runtime.
 */
export function defaultCapsulesDir(memoryDir: string): string {
  return path.join(memoryDir, ".capsules");
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function escapeMarkdownCell(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * Render the `capsule list` output.
 */
export function renderCapsuleList(
  entries: CapsuleListEntry[],
  format: CapsuleOutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify({ capsules: entries }, null, 2);
  }

  if (entries.length === 0) {
    if (format === "markdown") return "_No capsule archives found._\n";
    return "No capsule archives found.\n";
  }

  if (format === "markdown") {
    const rows = entries.map((e) => {
      const id = escapeMarkdownCell(e.id);
      const date = escapeMarkdownCell(e.createdAt?.slice(0, 10) ?? "—");
      const ver = escapeMarkdownCell(e.pluginVersion ?? "—");
      const files = e.fileCount !== null ? String(e.fileCount) : "—";
      const desc = escapeMarkdownCell(
        e.description != null && e.description.trim() !== ""
          ? e.description.trim()
          : "—",
      );
      return `| \`${id}\` | ${date} | ${ver} | ${files} | ${desc} |`;
    });
    return [
      "# Capsule archives",
      "",
      "| ID | Created | Version | Files | Description |",
      "| -- | ------- | ------- | ----- | ----------- |",
      ...rows,
      "",
    ].join("\n");
  }

  // text
  const lines = entries.map((e) => {
    const date = e.createdAt?.slice(0, 10) ?? "—";
    const files =
      e.fileCount !== null ? `${e.fileCount} file${e.fileCount !== 1 ? "s" : ""}` : "? files";
    const desc =
      e.description != null && e.description.trim() !== ""
        ? `  ${e.description.trim()}`
        : "";
    return `${e.id}  [${date}] [${files}]${desc}`;
  });
  return lines.join("\n") + "\n";
}

/**
 * Render the `capsule inspect` output from a manifest object.
 */
export function renderCapsuleInspect(
  manifest: CapsuleInspectData,
  format: CapsuleOutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(manifest, null, 2);
  }

  const {
    capsuleId,
    version,
    schemaVersion,
    createdAt,
    pluginVersion,
    fileCount,
    includesTranscripts,
    description,
    parentCapsule,
    retrievalPolicy,
    includes,
    topFiles,
  } = manifest;

  if (format === "markdown") {
    const policyLines = Object.entries(retrievalPolicy.tierWeights ?? {}).map(
      ([k, v]) => `  - ${k}: ${v}`,
    );
    const policyBlock =
      policyLines.length > 0
        ? policyLines.join("\n")
        : "  _(no tier weight overrides)_";

    return [
      `# Capsule: \`${capsuleId}\``,
      "",
      `**Version:** ${version}  `,
      `**Schema version:** ${schemaVersion}  `,
      `**Created:** ${createdAt ?? "—"}  `,
      `**Plugin version:** ${pluginVersion ?? "—"}  `,
      `**Files:** ${fileCount}  `,
      `**Includes transcripts:** ${includesTranscripts ? "yes" : "no"}  `,
      `**Parent capsule:** ${parentCapsule ?? "_none_"}  `,
      `**Description:** ${description && description.trim() !== "" ? description.trim() : "_none_"}  `,
      "",
      "## Includes",
      `- taxonomy: ${includes.taxonomy ? "yes" : "no"}`,
      `- identityAnchors: ${includes.identityAnchors ? "yes" : "no"}`,
      `- peerProfiles: ${includes.peerProfiles ? "yes" : "no"}`,
      `- procedural: ${includes.procedural ? "yes" : "no"}`,
      "",
      "## Retrieval policy",
      `- directAnswerEnabled: ${retrievalPolicy.directAnswerEnabled ? "yes" : "no"}`,
      `- tierWeights:`,
      policyBlock,
      "",
      ...(topFiles.length > 0
        ? [
            `## Files (${fileCount} total, showing first ${topFiles.length})`,
            ...topFiles.map((f) => `- \`${f}\``),
            "",
          ]
        : [`## Files (${fileCount} total)`, "_Empty capsule._", ""]),
    ].join("\n");
  }

  // text
  const lines: string[] = [
    `Capsule: ${capsuleId}`,
    `  version:          ${version}`,
    `  schema:           ${schemaVersion}`,
    `  created:          ${createdAt ?? "—"}`,
    `  plugin:           ${pluginVersion ?? "—"}`,
    `  files:            ${fileCount}`,
    `  transcripts:      ${includesTranscripts ? "yes" : "no"}`,
    `  parent:           ${parentCapsule ?? "(none)"}`,
    `  description:      ${description && description.trim() !== "" ? description.trim() : "(none)"}`,
    "",
    `  includes.taxonomy:        ${includes.taxonomy ? "yes" : "no"}`,
    `  includes.identityAnchors: ${includes.identityAnchors ? "yes" : "no"}`,
    `  includes.peerProfiles:    ${includes.peerProfiles ? "yes" : "no"}`,
    `  includes.procedural:      ${includes.procedural ? "yes" : "no"}`,
    "",
    `  policy.directAnswer:   ${retrievalPolicy.directAnswerEnabled ? "yes" : "no"}`,
  ];

  const weights = Object.entries(retrievalPolicy.tierWeights ?? {});
  if (weights.length > 0) {
    for (const [k, v] of weights) {
      lines.push(`  policy.tierWeight[${k}]: ${v}`);
    }
  } else {
    lines.push(`  policy.tierWeights:    (none)`);
  }

  if (topFiles.length > 0) {
    lines.push("", `  files (first ${topFiles.length} of ${fileCount}):`);
    for (const f of topFiles) {
      lines.push(`    ${f}`);
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Data shape consumed by {@link renderCapsuleInspect}.
 * Populated by the cli.ts action handler from the parsed manifest.
 */
export interface CapsuleInspectData {
  capsuleId: string;
  version: string;
  schemaVersion: string;
  createdAt: string | null;
  pluginVersion: string | null;
  fileCount: number;
  includesTranscripts: boolean;
  description: string;
  parentCapsule: string | null;
  retrievalPolicy: {
    tierWeights: Record<string, number>;
    directAnswerEnabled: boolean;
  };
  includes: {
    taxonomy: boolean;
    identityAnchors: boolean;
    peerProfiles: boolean;
    procedural: boolean;
  };
  /** First N file paths from manifest.files (for preview). */
  topFiles: string[];
}
