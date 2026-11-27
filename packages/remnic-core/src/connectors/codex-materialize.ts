/**
 * codex-materialize.ts — Codex CLI native memory artifact materialization (#378)
 *
 * Periodically writes Remnic memories into the file layout that Codex CLI's
 * phase-2 consolidation reads directly under `<codex_home>/memories/`:
 *
 *   memory_summary.md                — always-loaded at session start (tight budget)
 *   MEMORY.md                        — searchable handbook (task-group schema)
 *   raw_memories.md                  — mechanical merge of raw memories, latest first
 *   rollout_summaries/<slug>.md      — per-session recaps
 *
 * Codex's own read path is agnostic to which producer wrote these files — it
 * tags reads by `memory_md` / `memory_summary` / `raw_memories` /
 * `rollout_summaries` / `skills`. By materializing Remnic content into this
 * exact layout we let Codex pick up Remnic memories without a single MCP call.
 *
 * Safety invariants
 * ─────────────────
 *  - **Atomic writes.** Every file is rendered under `.remnic-tmp/` and then
 *    `rename()`d into place so Codex never observes a half-written file.
 *  - **Sentinel-based opt-in.** If `<codex_home>/memories/.remnic-managed` is
 *    missing, we SKIP materialization entirely and log a warning. This honors
 *    user hand-edits to the directory — a user who manually curated their
 *    Codex memory layout will never have those edits overwritten.
 *  - **Schema validation.** `MEMORY.md` content is validated against the
 *    task-group schema before write. Invalid content throws and nothing is
 *    written.
 *  - **Idempotent no-ops.** A content hash is written into the sentinel. If
 *    the re-rendered hash matches the previous run, we skip writes entirely.
 *  - **Token budget.** `memory_summary.md` is truncated to fit under the
 *    configured script-aware token estimate, leaving headroom under Codex's
 *    5000-token summary cap.
 *
 * Privacy
 * ───────
 * This module does not persist any user content outside `<codex_home>/memories`
 * — it only mirrors the memories that Remnic already wrote. It does not log
 * memory content to stdout; it logs file names, counts, and hashes.
 */

import {
  createHash,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { log } from "../logger.js";
import { readEnvVar, resolveHomeDir } from "../runtime/env.js";
import type { MemoryFile } from "../types.js";
import { estimateTokenCount } from "../token-estimate.js";
import type { SkillBundle } from "../procedural/skill-projection.js";
import { expandTildePath } from "../utils/path.js";
import { ensureSafeManagedSubdir } from "./materialize-paths.js";
import {
  commitSkillFiles,
  planSkillFiles,
  retiredSkillsAlreadyRemoved,
  skillFilePath,
  skillFileRelPath,
  stageSkillFiles,
  type SkillFile,
} from "./materialize-skills.js";


export interface MaterializeOptions {
  memories: MemoryFile[];
  /** Override `<codex_home>`. Defaults to `$CODEX_HOME` or `~/.codex`. */
  codexHome?: string;
  /** Maximum estimated token size of memory_summary.md. Default 4500. */
  maxSummaryTokens?: number;
  /** Maximum age of rollout_summaries/*.md in days. Default 30. */
  rolloutRetentionDays?: number;
  rolloutSummaries?: RolloutSummaryInput[];
  /**
   * Projected procedural skill bundles (issue #2369). `undefined` leaves
   * `skills/` untouched; an array — even an empty one — is authoritative for
   * the slugs Remnic projected, so retired procedures get their folder
   * removed. Folders this materializer never projected are never touched.
   */
  skills?: SkillBundle[];
  /** Current time, injected for deterministic tests. */
  now?: Date;
  /** Optional logger override for tests. */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; debug?: (msg: string) => void };
}

export interface RolloutSummaryInput {
  slug: string;
  cwd?: string;
  rolloutPath?: string;
  updatedAt?: string;
  threadId?: string;
  body: string;
  keywords?: string[];
}

export interface MaterializeResult {
  namespace: string;
  memoriesDir: string;
  /** Was anything actually written (vs. skipped / idempotent no-op)? */
  wrote: boolean;
  /** True if the sentinel was missing and we skipped with a warning. */
  skippedNoSentinel: boolean;
  /** True if the hash matched the previous run and we short-circuited. */
  skippedIdempotent: boolean;
  /** Files that were written this run (relative to `memoriesDir`). */
  filesWritten: string[];
  contentHash: string;
}

/** On-disk shape of the `.remnic-managed` sentinel. */
interface SentinelFile {
  version: number;
  namespace: string;
  updated_at: string;
  content_hash: string;
  /**
   * Slugs under `skills/` that THIS materializer projected (issue #2369).
   * Absent on sentinels written before skill projection existed, which reads
   * as "we have projected nothing", so hand-created folders stay untouched.
   */
  projected_skills?: string[];
}


/** Bump when the on-disk layout or semantics change. */
export const MATERIALIZE_VERSION = 1;

export const SENTINEL_FILE = ".remnic-managed";

export const TMP_DIR = ".remnic-tmp";

/** File names we own. Anything else in the directory is considered user-managed. */
const OWNED_FILES = new Set<string>([
  "memory_summary.md",
  "MEMORY.md",
  "raw_memories.md",
]);

const ROLLOUT_SUBDIR = "rollout_summaries";


/**
 * Materialize a Remnic namespace into Codex's native memory layout.
 *
 * Returns a {@link MaterializeResult} describing what happened. Callers
 * should treat "skipped" as success — the sentinel / idempotent cases are
 * expected and intentional.
 *
 * @throws if `MEMORY.md` fails schema validation (we do not write garbage).
 */
export function materializeForNamespace(
  namespace: string,
  options: MaterializeOptions,
): MaterializeResult {
  const logger = options.logger ?? {
    info: (msg) => log.info(`[codex-materialize] ${msg}`),
    warn: (msg) => log.warn(`[codex-materialize] ${msg}`),
    debug: (msg) => log.debug(`[codex-materialize] ${msg}`),
  };
  const memoriesDir = resolveCodexMemoriesDir(options.codexHome);
  const now = options.now ?? new Date();
  const maxSummaryTokens =
    typeof options.maxSummaryTokens === "number" && options.maxSummaryTokens >= 0
      ? options.maxSummaryTokens
      : 4500;
  const rolloutRetentionDays =
    typeof options.rolloutRetentionDays === "number" && options.rolloutRetentionDays >= 0
      ? options.rolloutRetentionDays
      : 30;

  const sentinelPath = path.join(memoriesDir, SENTINEL_FILE);
  const existingSentinel = readSentinel(sentinelPath);
  if (!existingSentinel) {
    if (fs.existsSync(memoriesDir)) {
      logger.warn(
        `sentinel ${SENTINEL_FILE} missing in ${memoriesDir}; skipping materialization to preserve hand-edits`,
      );
    } else {
      logger.debug?.(
        `skipping materialization — ${memoriesDir} does not exist (user not opted in)`,
      );
    }
    return {
      namespace,
      memoriesDir,
      wrote: false,
      skippedNoSentinel: true,
      skippedIdempotent: false,
      filesWritten: [],
      contentHash: "",
    };
  }

  fs.mkdirSync(memoriesDir, { recursive: true });

  const memories = [...options.memories];
  const rolloutsSupplied = options.rolloutSummaries !== undefined;
  const rolloutSummaries = options.rolloutSummaries ?? [];

  const retainedRollouts = pruneRollouts(rolloutSummaries, rolloutRetentionDays, now);

  const dedupedRollouts: RolloutSummaryInput[] = [];
  const seenNames = new Map<string, number>();
  const parseTs = (value: string | undefined): number => {
    if (!value) return Number.NEGATIVE_INFINITY;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  for (const r of retainedRollouts) {
    const name = `${sanitizeSlug(r.slug)}.md`;
    const existingIdx = seenNames.get(name);
    if (existingIdx === undefined) {
      seenNames.set(name, dedupedRollouts.length);
      dedupedRollouts.push(r);
      continue;
    }
    const existing = dedupedRollouts[existingIdx];
    if (parseTs(r.updatedAt) > parseTs(existing.updatedAt)) {
      dedupedRollouts[existingIdx] = r;
    }
  }

  const memorySummary = renderMemorySummary({
    namespace,
    memories,
    rolloutSummaries: dedupedRollouts,
    maxTokens: maxSummaryTokens,
  });

  const memoryMd = renderMemoryMd({
    namespace,
    memories,
    rolloutSummaries: dedupedRollouts,
  });

  const validation = validateMemoryMd(memoryMd);
  if (!validation.valid) {
    const reason = validation.errors.join("; ");
    logger.warn(`MEMORY.md failed schema validation: ${reason}`);
    throw new Error(`codex-materialize: MEMORY.md schema validation failed: ${reason}`);
  }

  const rawMemories = renderRawMemories({ memories });

  const rolloutFiles = dedupedRollouts.map((r) => ({
    name: `${sanitizeSlug(r.slug)}.md`,
    body: renderRolloutSummary(r),
  }));
  const destRolloutsDir = path.join(memoriesDir, ROLLOUT_SUBDIR);
  const retainedRolloutNames = new Set(rolloutFiles.map((r) => r.name));

  const skillPlan = planSkillFiles(options.skills, existingSentinel.projected_skills ?? []);

  const hash = computeContentHash({
    namespace,
    memorySummary,
    memoryMd,
    rawMemories,
    rolloutFiles,
    skillFiles: skillPlan.files,
  });

  if (existingSentinel.content_hash === hash) {
    const requiredFiles = [
      path.join(memoriesDir, "memory_summary.md"),
      path.join(memoriesDir, "MEMORY.md"),
      path.join(memoriesDir, "raw_memories.md"),
      ...rolloutFiles.map((r) => path.join(memoriesDir, ROLLOUT_SUBDIR, r.name)),
      ...skillPlan.files.map((s) => skillFilePath(memoriesDir, s.slug)),
    ];
    const allPresent = requiredFiles.every((f) => fs.existsSync(f));
    const rolloutsClean =
      !rolloutsSupplied ||
      rolloutDirectoryMatchesRetainedSet(
        ensureSafeManagedSubdir(memoriesDir, destRolloutsDir, ROLLOUT_SUBDIR),
        retainedRolloutNames,
      );
    const skillsClean = retiredSkillsAlreadyRemoved(memoriesDir, skillPlan.retiredSlugs);
    if (allPresent && rolloutsClean && skillsClean) {
      logger.debug?.(`no-op materialization for namespace=${namespace} (hash unchanged)`);
      return {
        namespace,
        memoriesDir,
        wrote: false,
        skippedNoSentinel: false,
        skippedIdempotent: true,
        filesWritten: [],
        contentHash: hash,
      };
    }
    logger.debug?.(
      `hash unchanged for namespace=${namespace} but managed files need refresh — forcing rewrite`,
    );
  }

  // ── Atomic writes ──────────────────────────────────────────────────────
  const runTag = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const tmpDir = path.join(memoriesDir, `${TMP_DIR}-${runTag}`);
  const TMP_STALE_MS = 60 * 60 * 1000;
  const wallClockMs = Date.now();
  try {
    for (const entry of fs.readdirSync(memoriesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(TMP_DIR)) continue;
      const stalePath = path.join(memoriesDir, entry.name);
      try {
        const stat = fs.statSync(stalePath);
        if (wallClockMs - stat.mtimeMs < TMP_STALE_MS) continue;
        fs.rmSync(stalePath, { recursive: true, force: true });
      } catch {
        // ignore — another concurrent run may own it, or we lack perms
      }
    }
  } catch {
    // ignore — dir may not exist yet
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, ROLLOUT_SUBDIR), { recursive: true });

  const filesWritten: string[] = [];

  fs.writeFileSync(path.join(tmpDir, "memory_summary.md"), memorySummary);
  filesWritten.push("memory_summary.md");

  fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), memoryMd);
  filesWritten.push("MEMORY.md");

  fs.writeFileSync(path.join(tmpDir, "raw_memories.md"), rawMemories);
  filesWritten.push("raw_memories.md");

  for (const rollout of rolloutFiles) {
    fs.writeFileSync(path.join(tmpDir, ROLLOUT_SUBDIR, rollout.name), rollout.body);
    filesWritten.push(path.join(ROLLOUT_SUBDIR, rollout.name));
  }

  stageSkillFiles(tmpDir, skillPlan.files);
  for (const skill of skillPlan.files) {
    filesWritten.push(skillFileRelPath(skill.slug));
  }

  for (const rel of ["memory_summary.md", "MEMORY.md", "raw_memories.md"]) {
    const src = path.join(tmpDir, rel);
    const dest = path.join(memoriesDir, rel);
    fs.renameSync(src, dest);
  }

  const safeDestRolloutsDir = ensureSafeManagedSubdir(memoriesDir, destRolloutsDir, ROLLOUT_SUBDIR);
  if (rolloutsSupplied) {
    let existingRollouts: fs.Dirent[];
    try {
      existingRollouts = fs.readdirSync(safeDestRolloutsDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      existingRollouts = [];
    }
    for (const entry of existingRollouts) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      if (retainedRolloutNames.has(entry.name)) continue;
      try {
        fs.unlinkSync(path.join(safeDestRolloutsDir, entry.name));
      } catch (err) {
        throw new Error(
          `codex-materialize: failed to prune stale rollout summary ${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  for (const rollout of rolloutFiles) {
    const src = path.join(tmpDir, ROLLOUT_SUBDIR, rollout.name);
    const dest = path.join(safeDestRolloutsDir, rollout.name);
    fs.renameSync(src, dest);
  }

  commitSkillFiles(memoriesDir, tmpDir, skillPlan);

  const sentinel: SentinelFile = {
    version: MATERIALIZE_VERSION,
    namespace,
    updated_at: now.toISOString(),
    content_hash: hash,
    projected_skills: skillPlan.supplied
      ? skillPlan.files.map((s) => s.slug)
      : (existingSentinel.projected_skills ?? []),
  };
  writeSentinelAtomically(sentinelPath, sentinel);

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  logger.info(
    `materialized namespace=${namespace} files=${filesWritten.length} hash=${hash.slice(0, 12)}`,
  );

  return {
    namespace,
    memoriesDir,
    wrote: true,
    skippedNoSentinel: false,
    skippedIdempotent: false,
    filesWritten,
    contentHash: hash,
  };
}

/**
 * Create (or refresh) the `.remnic-managed` sentinel. Callers must do this
 * explicitly the first time they want Remnic to start managing a directory —
 * we never write it implicitly, because its presence is the user's opt-in.
 */
export function ensureSentinel(memoriesDir: string, namespace: string, now: Date = new Date()): void {
  fs.mkdirSync(memoriesDir, { recursive: true });
  const sentinelPath = path.join(memoriesDir, SENTINEL_FILE);
  if (fs.existsSync(sentinelPath)) {
    readSentinel(sentinelPath);
    return;
  }
  const sentinel: SentinelFile = {
    version: MATERIALIZE_VERSION,
    namespace,
    updated_at: now.toISOString(),
    content_hash: "",
  };
  writeSentinelAtomically(sentinelPath, sentinel);
}


interface RenderContext {
  namespace: string;
  memories: MemoryFile[];
  rolloutSummaries: RolloutSummaryInput[];
  // Historically this interface exposed a `now: Date` field, but neither
  // `renderMemoryMd` nor `renderMemorySummary` ever read it (rendered output
  // is purely a function of `namespace`, `memories`, and `rolloutSummaries`).
  // The field was flagged as dead weight in PR #392 review and removed.
  // If a future renderer needs a timestamp, re-add it here and update both
  // call sites and the schema test.
}

interface SummaryRenderContext extends RenderContext {
  maxTokens: number;
}

/**
 * Render `memory_summary.md` — the always-loaded file.
 * Budget-capped at `maxTokens` whitespace tokens.
 */
export function renderMemorySummary(ctx: SummaryRenderContext): string {
  const lines: string[] = [];
  lines.push("# Memory Summary");
  lines.push("");
  lines.push(`_namespace: ${ctx.namespace}_`);
  lines.push(`_source: remnic_`);
  lines.push("");

  const highValue = selectSummaryMemories(ctx.memories, 12);
  if (highValue.length > 0) {
    lines.push("## Top memories");
    lines.push("");
    for (const mem of highValue) {
      lines.push(`- ${oneLineSummary(mem)}`);
    }
    lines.push("");
  }

  if (ctx.rolloutSummaries.length > 0) {
    lines.push("## Recent rollouts");
    lines.push("");
    const sorted = [...ctx.rolloutSummaries]
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, 5);
    for (const r of sorted) {
      const when = r.updatedAt ? ` (${r.updatedAt})` : "";
      lines.push(`- ${r.slug}${when}`);
    }
    lines.push("");
  }

  // Collapse trailing newlines to one without the anchored /\n+$/ quantifier,
  // which backtracks polynomially (CodeQL js/polynomial-redos).
  const joined = lines.join("\n");
  let joinedEnd = joined.length;
  while (joinedEnd > 0 && joined[joinedEnd - 1] === "\n") joinedEnd--;
  const full = joinedEnd === joined.length ? joined : `${joined.slice(0, joinedEnd)}\n`;
  return truncateToTokenBudget(full, ctx.maxTokens);
}

/**
 * Render `MEMORY.md` — the searchable handbook in Codex's task-group schema.
 */
export function renderMemoryMd(ctx: RenderContext): string {
  const lines: string[] = [];
  lines.push(`# Task Group: ${ctx.namespace}`);
  lines.push(`scope: ${ctx.namespace}`);
  lines.push(`applies_to: cwd=*; reuse_rule=namespace-match`);
  lines.push("");

  // One task per namespace: there is no topic clustering yet, so a task per
  // memory category would emit identical rollout lists under every task and
  // claim per-task scoping that does not exist. The documented contract is a
  // single task carrying all rollouts until real clustering lands (#3614).
  const activeMemories = ctx.memories.filter(
    (m) => !m.frontmatter.status || m.frontmatter.status === "active",
  );
  lines.push(`## Task 1: ${ctx.namespace} memories, outcome=surface-to-codex`);
  lines.push("");
  lines.push("### rollout_summary_files");
  const rollouts = ctx.rolloutSummaries.slice(0, 5);
  if (rollouts.length === 0) {
    lines.push("- (none)");
  } else {
    for (const r of rollouts) {
      lines.push(
        `- rollout_summaries/${sanitizeSlug(r.slug)}.md (cwd=${r.cwd ?? "*"}, rollout_path=${r.rolloutPath ?? ""}, updated_at=${r.updatedAt ?? ""}, thread_id=${r.threadId ?? ""})`,
      );
    }
  }
  lines.push("");
  lines.push("### keywords");
  lines.push(`- ${collectKeywords(activeMemories, ctx.namespace).join(", ")}`);
  lines.push("");

  lines.push("## User preferences");
  const prefs = pickCategory(ctx.memories, ["preference"]);
  if (prefs.length === 0) {
    lines.push("- (none recorded)");
  } else {
    for (const pref of prefs.slice(0, 20)) {
      lines.push(`- ${oneLineSummary(pref)}`);
    }
  }
  lines.push("");

  lines.push("## Reusable knowledge");
  const knowledge = pickCategory(ctx.memories, ["fact", "decision", "principle", "rule", "skill"]);
  if (knowledge.length === 0) {
    lines.push("- (none recorded)");
  } else {
    for (const mem of knowledge.slice(0, 30)) {
      lines.push(`- ${oneLineSummary(mem)}`);
    }
  }
  lines.push("");

  lines.push("## Failures and how to do differently");
  const corrections = pickCategory(ctx.memories, ["correction"]);
  if (corrections.length === 0) {
    lines.push("- (none recorded)");
  } else {
    for (const mem of corrections.slice(0, 20)) {
      lines.push(`- ${oneLineSummary(mem)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/** Render `raw_memories.md` — mechanical dump, latest first. */
export function renderRawMemories(ctx: { memories: MemoryFile[] }): string {
  const sorted = [...ctx.memories].sort((a, b) => {
    const aUpdated = a.frontmatter.updated ?? a.frontmatter.created ?? "";
    const bUpdated = b.frontmatter.updated ?? b.frontmatter.created ?? "";
    return bUpdated.localeCompare(aUpdated);
  });

  const lines: string[] = ["# Raw Memories", "", "_source: remnic — latest first_", ""];
  for (const mem of sorted) {
    const fm = mem.frontmatter;
    const id = fm.id ?? "unknown";
    const category = fm.category ?? "unknown";
    const updated = fm.updated ?? fm.created ?? "";
    lines.push(`## ${id} (${category}, updated=${updated})`);
    lines.push("");
    lines.push(mem.content.trim());
    lines.push("");
  }
  return lines.join("\n");
}

/** Render a single rollout summary file. */
export function renderRolloutSummary(input: RolloutSummaryInput): string {
  const lines: string[] = [];
  lines.push(`# Rollout Summary: ${input.slug}`);
  lines.push("");
  const meta: string[] = [];
  if (input.cwd) meta.push(`cwd=${input.cwd}`);
  if (input.rolloutPath) meta.push(`rollout_path=${input.rolloutPath}`);
  if (input.updatedAt) meta.push(`updated_at=${input.updatedAt}`);
  if (input.threadId) meta.push(`thread_id=${input.threadId}`);
  if (meta.length > 0) {
    lines.push(`_${meta.join("; ")}_`);
    lines.push("");
  }
  if (input.keywords && input.keywords.length > 0) {
    lines.push(`**keywords:** ${input.keywords.join(", ")}`);
    lines.push("");
  }
  lines.push(input.body.trim());
  lines.push("");
  return lines.join("\n");
}


export interface MemoryMdValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate that a rendered `MEMORY.md` matches Codex's task-group schema.
 * We enforce the minimum set of structural requirements called out in #378:
 *
 *  - one `# Task Group:` header
 *  - `scope:` and `applies_to:` lines directly beneath it
 *  - at least one `## Task N:` section
 *  - each task section has `### rollout_summary_files` and `### keywords`
 *  - `## User preferences`, `## Reusable knowledge`,
 *    `## Failures and how to do differently` sections all present
 */
export function validateMemoryMd(content: string): MemoryMdValidation {
  const errors: string[] = [];
  const lines = content.split(/\r?\n/u);

  const taskGroupIndex = lines.findIndex((l) => /^#\s+Task Group:\s+\S+/u.test(l));
  if (taskGroupIndex === -1) {
    errors.push("missing `# Task Group:` header");
  } else {
    const tail = lines.slice(taskGroupIndex + 1, taskGroupIndex + 5);
    if (!tail.some((l) => /^scope:\s*\S+/u.test(l))) {
      errors.push("missing `scope:` line under Task Group header");
    }
    if (!tail.some((l) => /^applies_to:\s*\S+/u.test(l))) {
      errors.push("missing `applies_to:` line under Task Group header");
    }
  }

  const taskHeaders = lines.filter((l) => /^##\s+Task\s+\d+:/u.test(l));
  if (taskHeaders.length === 0) {
    errors.push("at least one `## Task N:` section is required");
  }

  const sectionRegex = /^##\s+/u;
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s+Task\s+\d+:/u.test(lines[i])) continue;
    let hasRollout = false;
    let hasKeywords = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (sectionRegex.test(lines[j])) break;
      if (/^###\s+rollout_summary_files\s*$/u.test(lines[j])) hasRollout = true;
      if (/^###\s+keywords\s*$/u.test(lines[j])) hasKeywords = true;
    }
    if (!hasRollout) errors.push(`task block at line ${i + 1} missing \`### rollout_summary_files\``);
    if (!hasKeywords) errors.push(`task block at line ${i + 1} missing \`### keywords\``);
  }

  const requiredSections = [
    /^##\s+User preferences\s*$/u,
    /^##\s+Reusable knowledge\s*$/u,
    /^##\s+Failures and how to do differently\s*$/u,
  ];
  for (const re of requiredSections) {
    if (!lines.some((l) => re.test(l))) {
      errors.push(`missing required section: ${re.source}`);
    }
  }

  return { valid: errors.length === 0, errors };
}


function resolveCodexHome(override?: string): string {
  if (override && override.trim().length > 0) {
    return path.resolve(expandTildePath(override.trim()));
  }
  const fromEnv = readEnvVar("CODEX_HOME");
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(expandTildePath(fromEnv.trim()));
  }
  return path.resolve(resolveHomeDir(), ".codex");
}

export function resolveCodexMemoriesDir(codexHome?: string): string {
  return path.join(resolveCodexHome(codexHome), "memories");
}

export function hasCodexMaterializeSentinel(codexHome?: string): boolean {
  return readSentinel(path.join(resolveCodexMemoriesDir(codexHome), SENTINEL_FILE)) !== null;
}

function rolloutDirectoryMatchesRetainedSet(
  rolloutsDir: string,
  retainedNames: Set<string>,
): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rolloutsDir, { withFileTypes: true });
  } catch {
    return retainedNames.size === 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (!retainedNames.has(entry.name)) return false;
  }
  return true;
}

function readSentinel(sentinelPath: string): SentinelFile | null {
  if (!fs.existsSync(sentinelPath)) return null;
  try {
    const raw = fs.readFileSync(sentinelPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SentinelFile>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.version !== "number" ||
      typeof parsed.namespace !== "string" ||
      typeof parsed.updated_at !== "string" ||
      typeof parsed.content_hash !== "string"
    ) {
      throw new Error("invalid sentinel schema");
    }
    const projected = Array.isArray(parsed.projected_skills)
      ? parsed.projected_skills.filter((slug): slug is string => typeof slug === "string")
      : [];
    return {
      version: parsed.version,
      namespace: parsed.namespace,
      updated_at: parsed.updated_at,
      content_hash: parsed.content_hash,
      projected_skills: projected,
    };
  } catch (err) {
    throw new Error(
      `codex-materialize: corrupt ${SENTINEL_FILE} sentinel at ${sentinelPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function writeSentinelAtomically(
  sentinelPath: string,
  sentinel: SentinelFile,
): void {
  const tmpPath = `${sentinelPath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(sentinel, null, 2)}\n`, {
      flag: "wx",
    });
    fs.renameSync(tmpPath, sentinelPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup failures; preserve the original write/rename error
    }
    throw err;
  }
}

function selectSummaryMemories(memories: MemoryFile[], limit: number): MemoryFile[] {
  const scored = memories
    .filter((m) => !m.frontmatter.status || m.frontmatter.status === "active")
    .map((m) => {
      const confidence = typeof m.frontmatter.confidence === "number" ? m.frontmatter.confidence : 0;
      const importance =
        typeof m.frontmatter.importance === "object" &&
        m.frontmatter.importance !== null &&
        typeof (m.frontmatter.importance as { score?: number }).score === "number"
          ? ((m.frontmatter.importance as { score: number }).score ?? 0)
          : 0;
      const updated = m.frontmatter.updated ?? m.frontmatter.created ?? "";
      return { memory: m, score: importance * 2 + confidence, updated };
    });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.updated.localeCompare(a.updated);
  });

  return scored.slice(0, limit).map((s) => s.memory);
}

function oneLineSummary(memory: MemoryFile): string {
  const raw = memory.content.replace(/\s+/gu, " ").trim();
  if (raw.length <= 160) return raw;
  return `${raw.slice(0, 157)}...`;
}

function pickCategory(memories: MemoryFile[], categories: string[]): MemoryFile[] {
  const allowed = new Set(categories);
  return memories.filter(
    (m) =>
      (!m.frontmatter.status || m.frontmatter.status === "active") &&
      allowed.has(m.frontmatter.category ?? ""),
  );
}

function collectKeywords(memories: MemoryFile[], namespace: string): string[] {
  const keywords = new Set<string>();
  keywords.add(namespace);
  // Two passes so the tag flood cannot crowd out a category: every active
  // memory's category is guaranteed a slot, then tags fill what remains.
  for (const mem of memories) {
    const category = (mem.frontmatter.category ?? "").trim();
    if (category.length > 0) keywords.add(category);
  }
  for (const mem of memories) {
    for (const tag of mem.frontmatter.tags ?? []) {
      const trimmed = tag.trim();
      if (trimmed.length > 0) keywords.add(trimmed);
    }
  }
  return [...keywords].slice(0, 16);
}

function pruneRollouts(
  rollouts: RolloutSummaryInput[],
  retentionDays: number,
  now: Date,
): RolloutSummaryInput[] {
  if (retentionDays < 0) return rollouts;
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return rollouts.filter((r) => {
    if (!r.updatedAt) return true;
    const t = Date.parse(r.updatedAt);
    if (!Number.isFinite(t)) return true;
    return t >= cutoffMs;
  });
}

function sanitizeSlug(slug: string): string {
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .slice(0, 96);
  const trimmed = trimHyphenEdges(sanitized);
  return trimmed || "rollout";
}

function trimHyphenEdges(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}
/** Shared script-aware approximation used by the budget check. */
export function approximateTokenCount(text: string): number {
  return estimateTokenCount(text);
}

/**
 * Truncate `text` so it fits under `maxTokens`. We drop trailing lines until
 * under budget, then append a marker so readers can see that truncation occurred.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (approximateTokenCount(text) <= maxTokens) return text;

  const lineMarker = "_[truncated for summary budget]_";
  const tailMarker = "[truncated]";
  if (approximateTokenCount(tailMarker) > maxTokens) return "";
  const lineMarkerTokens = approximateTokenCount(lineMarker);

  const lines = text.split(/\r?\n/u);
  const lineBudget = Math.max(0, maxTokens - lineMarkerTokens);
  while (lines.length > 0 && approximateTokenCount(lines.join("\n")) > lineBudget) {
    lines.pop();
  }
  lines.push(lineMarker);
  let result = lines.join("\n");

  if (approximateTokenCount(result) > maxTokens) {
    const codePoints = [...result];
    let low = 0;
    let high = codePoints.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const prefix = codePoints.slice(0, mid).join("");
      const candidate = prefix.length > 0 ? `${prefix} ${tailMarker}` : tailMarker;
      if (approximateTokenCount(candidate) <= maxTokens) low = mid;
      else high = mid - 1;
    }
    const prefix = codePoints.slice(0, low).join("");
    result = prefix.length > 0 ? `${prefix} ${tailMarker}` : tailMarker;
  }
  return result;
}

function computeContentHash(input: {
  namespace: string;
  memorySummary: string;
  memoryMd: string;
  rawMemories: string;
  rolloutFiles: Array<{ name: string; body: string }>;
  skillFiles: Array<{ slug: string; body: string }>;
}): string {
  const hash = createHash("sha256");
  hash.update(`v${MATERIALIZE_VERSION}\n`);
  hash.update(`namespace=${input.namespace}\n`);
  hash.update("---memory_summary---\n");
  hash.update(input.memorySummary);
  hash.update("\n---memory_md---\n");
  hash.update(input.memoryMd);
  hash.update("\n---raw_memories---\n");
  hash.update(input.rawMemories);
  const sortedRollouts = [...input.rolloutFiles].sort((a, b) => a.name.localeCompare(b.name));
  for (const r of sortedRollouts) {
    hash.update(`\n---rollout:${r.name}---\n`);
    hash.update(r.body);
  }
  const sortedSkills = [...input.skillFiles].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const s of sortedSkills) {
    hash.update(`\n---skill:${s.slug}---\n`);
    hash.update(s.body);
  }
  return hash.digest("hex");
}


/**
 * Return basic stats about a materialized memories dir. Useful for tests and
 * debug CLI output. Returns `null` if the dir does not exist.
 */
export function describeMemoriesDir(memoriesDir: string): {
  exists: boolean;
  hasSentinel: boolean;
  files: string[];
  sentinel: SentinelFile | null;
} | null {
  if (!fs.existsSync(memoriesDir)) return null;
  const sentinelPath = path.join(memoriesDir, SENTINEL_FILE);
  const sentinel = readSentinel(sentinelPath);
  const files: string[] = [];
  for (const entry of fs.readdirSync(memoriesDir, { withFileTypes: true })) {
    if (entry.isFile() && OWNED_FILES.has(entry.name)) files.push(entry.name);
  }
  const rolloutsDir = path.join(memoriesDir, ROLLOUT_SUBDIR);
  if (fs.existsSync(rolloutsDir)) {
    try {
      for (const entry of fs.readdirSync(rolloutsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(path.join(ROLLOUT_SUBDIR, entry.name));
        }
      }
    } catch {
      // ignore
    }
  }
  return {
    exists: true,
    hasSentinel: sentinel !== null,
    files: files.sort(),
    sentinel,
  };
}
