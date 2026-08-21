/**
 * Architecture card — pure deterministic builder (issue #1548 Track A PR 3).
 *
 * Produces a compact, sorted, byte-stable markdown card describing a
 * repository: manifests, top-level directories, language histogram by
 * extension, and entry points derived from manifests. The deterministic
 * card is useful on its own; an optional LLM summary pass (gated behind
 * `architectureCardLlmSummary`) can later prepend a human-readable
 * overview using the existing extraction engine.
 *
 * Design rules honoured:
 *  - rule 38: every multi-value field is sorted before serialising so
 *    two runs over the same fixture produce byte-identical output.
 *  - rule 24/51: `repoRoot` must be an absolute, existing directory;
 *    invalid input is rejected with a descriptive error.
 *  - rule 34: scan failures produce a tagged outcome, never a crash.
 *  - rule 48: the LLM pass is opt-in (default off).
 *  - rule 13: on LLM failure the deterministic card ships unchanged.
 *  - Privacy + speed: file *contents* are never read except for manifest
 *    files (package.json, Cargo.toml, go.mod, pyproject.toml, pom.xml).
 *
 * This module is deliberately pure: no orchestrator references, no
 * config side-effects, no namespace wiring. Callers inject the repo
 * root and receive a string.
 */
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { expandTildePath } from "../utils/path.js";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

/**
 * Maximum byte size of the serialised card. When the deterministic card
 * exceeds this, it is truncated with a visible marker so consumers know
 * information was elided (rule 34 — never silently incomplete).
 */
export const ARCHITECTURE_CARD_MAX_BYTES = 4096;

/**
 * Visible marker appended when the card is truncated. Exported so callers
 * that read stored card content can detect truncation from the content
 * itself, without depending on a frontmatter tag that may go stale on
 * content-only updates (cursor review: "stale truncated tag on update").
 */
export const ARCHITECTURE_CARD_TRUNCATION_MARKER = "… card truncated to fit size cap …";

/**
 * Maximum byte size of the LLM summary prefix. The summary is additive —
 * the deterministic card (manifests, languages, entry points) must ALWAYS
 * survive truncation. Clamping the summary before prepending prevents a
 * misbehaving or prompt-injected summariser from crowding out the
 * deterministic sections (codex review).
 */
export const ARCHITECTURE_CARD_MAX_SUMMARY_BYTES = 1024;

/**
 * Manifest files the scanner knows how to parse for project metadata
 * (name, entry points). Single source of truth (rule 53 analog).
 */
export const KNOWN_MANIFEST_FILES = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "mix.exs",
  "deno.json",
] as const;

/**
 * Directories the scanner skips (would distort the histogram or are
 * universally non-source). Kept conservative — operators with unusual
 * layouts still get useful output.
 */
export const SCAN_IGNORE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  "dist",
  "build",
  "target",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  ".turbo",
  ".idea",
  ".vscode",
]);

/**
 * Result of a deterministic architecture-card build.
 */
export interface ArchitectureCard {
  /** The markdown card body (may be truncated to fit the byte cap). */
  readonly content: string;
  /** ISO timestamp of the build. */
  readonly generatedAt: string;
  /** Byte length of `content`. */
  readonly byteSize: number;
  /** Whether the card was truncated to fit `maxBytes`. */
  readonly truncated: boolean;
}

/**
 * Injectable LLM summariser. Receives the deterministic card and the
 * repo root; returns a summary string, or `null` to keep the
 * deterministic card unchanged. Implementations MUST NOT throw —
 * failures should return `null` (rule 13).
 */
export type ArchitectureCardSummariser = (
  deterministicCard: string,
  repoRoot: string,
) => Promise<string | null>;

/**
 * Minimal chat-completion surface for the architecture-card summariser.
 * Structural — satisfied by both `FallbackLlmClient` (gateway model
 * chain) and `LocalLlmClient` (Ollama / OpenAI-compatible local
 * endpoints) without this pure module importing either (rule 48 — the
 * builder stays free of orchestrator/client references). The shape
 * mirrors `Orchestrator.fastLlmForRerank` so callers resolve the client
 * gateway-first, matching LCM routing precedence.
 */
export interface ArchitectureCardLlmClient {
  chatCompletion(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options?: {
      temperature?: number;
      maxTokens?: number;
      timeoutMs?: number;
      operation?: string;
      priority?: "background" | "recall-critical";
    },
  ): Promise<{ content: string } | null>;
}

const ARCHITECTURE_CARD_SUMMARY_SYSTEM_PROMPT = `You write a concise overview for a repository architecture card.
Given the deterministic card (languages, manifests, entry points), produce a 3-5 sentence plain-text overview naming the dominant language, the primary entry point, and the project's shape.
Rules:
- Never invent facts absent from the input.
- No headings, no markdown — just sentences.
- Keep it under 600 characters.`;

/**
 * Build an {@link ArchitectureCardSummariser} backed by an LLM client.
 * The client is a structural type so this module does NOT import
 * `LocalLlmClient` / `FallbackLlmClient` (rule 48 — pure builder). The
 * caller resolves which client to use (gateway-first, matching LCM) and
 * may pass `null` when none is configured — then the summariser is
 * `undefined` so the builder's LLM branch stays inert (no silent no-op).
 *
 * Failures return `null` (rule 13) so the deterministic card ships
 * unchanged; `buildArchitectureCard` additionally defends against
 * implementations that throw.
 */
export function createArchitectureCardSummariser(
  client: ArchitectureCardLlmClient | null,
): ArchitectureCardSummariser | undefined {
  if (!client) return undefined;
  return async (deterministicCard, repoRoot) => {
    const response = await client.chatCompletion(
      [
        { role: "system", content: ARCHITECTURE_CARD_SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: `Repository: ${path.basename(repoRoot) || repoRoot}\n\n${deterministicCard}` },
      ],
      {
        temperature: 0.2,
        maxTokens: 512,
        operation: "architecture-card-summary",
        priority: "background",
      },
    );
    return response?.content ?? null;
  };
}

/**
 * Optional dependencies for `buildArchitectureCard`.
 */
export interface BuildArchitectureCardOptions {
  /** Injected clock — makes tests deterministic. */
  now?: Date;
  /** Override the byte cap (defaults to {@link ARCHITECTURE_CARD_MAX_BYTES}). */
  maxBytes?: number;
  /**
   * When `true`, invoke `summariser` to prepend an LLM overview.
   * Callers gate this on `codingKnowledge.architectureCardLlmSummary`
   * (rule 48 — opt-in).
   */
  llmSummary?: boolean;
  /** The summariser implementation (required when `llmSummary` is true). */
  summariser?: ArchitectureCardSummariser;
}

/**
 * Tagged failure from the build (rule 34).
 */
export type ArchitectureCardBuildFailure =
  | { ok: false; code: "invalid_root" | "scan_failed"; detail: string };

/**
 * Tagged result: success carries the card; failure carries a code.
 */
export type ArchitectureCardBuildResult =
  | { ok: true; card: ArchitectureCard }
  | ArchitectureCardBuildFailure;

// ──────────────────────────────────────────────────────────────────────────
// Public entry — buildArchitectureCard
// ──────────────────────────────────────────────────────────────────────────

/**
 * Deterministically build an architecture card for a repository.
 *
 * The scan:
 *  1. Reads top-level directory entries (sorted, rule 38).
 *  2. Parses any present manifest files for project name + entry points.
 *  3. Walks up to two levels deep to compute a language histogram by
 *     extension (capped to keep the scan fast on large repos).
 *  4. Renders a compact markdown card, sorted throughout.
 *
 * File *contents* are never read except for manifest files. The walker
 * only reads directory entries and file extensions (privacy + speed).
 */
export async function buildArchitectureCard(
  repoRoot: string,
  options: BuildArchitectureCardOptions = {},
): Promise<ArchitectureCardBuildResult> {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    return { ok: false, code: "invalid_root", detail: "repoRoot must be a non-empty string" };
  }
  // Expand `~` per rule 17 — codingContext.rootPath often carries a tilde
  // that Node's path.resolve does NOT expand (cursor review: tilde not expanded).
  const absoluteRoot = path.resolve(expandTildePath(repoRoot));
  try {
    // Use lstat, not stat, so symlinked manifests/dirs are NOT followed
    // (codex review: symlinks could read outside the repo root).
    const rootStat = await lstat(absoluteRoot);
    if (!rootStat.isDirectory()) {
      return { ok: false, code: "invalid_root", detail: `not a directory: ${absoluteRoot}` };
    }
  } catch (err) {
    return {
      ok: false,
      code: "invalid_root",
      detail: `repoRoot not accessible: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Probe root readability BEFORE scanning. An unreadable root (EACCES,
  // transient I/O) must surface as scan_failed, not a silent empty card —
  // otherwise refresh could overwrite a valid card with a sparse scan (codex
  // review). lstat can succeed while readdir is denied.
  try {
    await readdir(absoluteRoot);
  } catch (err) {
    return {
      ok: false,
      code: "scan_failed",
      detail: `repoRoot not readable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    const scan = await scanRepository(absoluteRoot);
    const deterministic = renderCard(scan, options.now ?? new Date());
    const maxBytes = options.maxBytes ?? ARCHITECTURE_CARD_MAX_BYTES;

    let content = deterministic;
    if (options.llmSummary === true && options.summariser) {
      try {
        const summary = await options.summariser(deterministic, absoluteRoot);
        if (typeof summary === "string" && summary.trim().length > 0) {
          // Reserve the deterministic card's budget FIRST — it must ALWAYS
          // survive (rule 34 + codex/kilo review). The final `capToBytes`
          // truncates from the END, so the summary is prepended only into the
          // space left after the deterministic card + separator, additionally
          // clamped to the summary cap. A summary can never crowd out or
          // truncate the deterministic sections when the card fits the cap.
          const separator = "\n\n---\n\n";
          const detBytes = Buffer.byteLength(deterministic, "utf-8");
          const sepBytes = Buffer.byteLength(separator, "utf-8");
          const summaryBudget = Math.min(
            ARCHITECTURE_CARD_MAX_SUMMARY_BYTES,
            maxBytes - detBytes - sepBytes,
          );
          if (summaryBudget > 0) {
            const clampedSummary = clampSummaryToBytes(summary.trim(), summaryBudget);
            if (clampedSummary.length > 0) {
              content = `${clampedSummary}${separator}${deterministic}`;
            }
          }
          // else: the deterministic card already fills the cap — ship it
          // alone rather than prepend a summary that would truncate it.
        }
      } catch (err) {
        // rule 13: LLM failure → deterministic card ships unchanged.
        // Intentionally swallowed — the summariser contract says "don't
        // throw", but we defend against implementations that do.
        void err;
      }
    }

    const { text: truncatedContent, truncated } = capToBytes(content, maxBytes);
    return {
      ok: true,
      card: {
        content: truncatedContent,
        generatedAt: (options.now ?? new Date()).toISOString(),
        byteSize: Buffer.byteLength(truncatedContent, "utf-8"),
        truncated,
      },
    };
  } catch (err) {
    return {
      ok: false,
      code: "scan_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Scan — directory walk + manifest parse (deterministic)
// ──────────────────────────────────────────────────────────────────────────

interface RepoScan {
  root: string;
  topDirs: string[];
  manifests: ParsedManifest[];
  languageHistogram: LanguageEntry[];
}

interface LanguageEntry {
  ext: string;
  count: number;
}

interface ParsedManifest {
  filename: string;
  name: string | null;
  entryPoints: string[];
}

async function scanRepository(root: string): Promise<RepoScan> {
  const topEntries = await readSortedDirEntries(root);
  const topDirs = topEntries.filter((e) => e.isDirectory && !SCAN_IGNORE_DIRS.has(e.name)).map((e) => e.name);
  const manifestFiles = topEntries
    .filter((e) => e.isFile && KNOWN_MANIFEST_FILES.includes(e.name as (typeof KNOWN_MANIFEST_FILES)[number]))
    .map((e) => e.name);

  const manifests: ParsedManifest[] = [];
  for (const mf of sortStrings(manifestFiles)) {
    const parsed = await parseManifest(path.join(root, mf));
    manifests.push({ filename: mf, name: parsed.name, entryPoints: sortStrings(parsed.entryPoints) });
  }

  const languageHistogram = await computeLanguageHistogram(root, topEntries);

  return {
    root: path.basename(root) || root,
    topDirs: sortStrings(topDirs),
    manifests,
    languageHistogram: sortLanguageHistogram(languageHistogram),
  };
}

interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

async function readSortedDirEntries(dir: string): Promise<DirEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const entries: DirEntry[] = [];
  for (const name of sortStrings(names)) {
    try {
      const s = await lstat(path.join(dir, name));
      // Skip symlinks — they could point outside the repo root (codex review).
      if (s.isSymbolicLink()) continue;
      entries.push({ name, isDirectory: s.isDirectory(), isFile: s.isFile() });
    } catch {
      // vanished between readdir+stat — skip.
    }
  }
  return entries;
}

async function computeLanguageHistogram(
  root: string,
  topEntries: DirEntry[],
): Promise<LanguageEntry[]> {
  const counts = new Map<string, number>();
  const dirsToScan = topEntries
    .filter((e) => e.isDirectory && !SCAN_IGNORE_DIRS.has(e.name))
    .map((e) => path.join(root, e.name));
  // Also count files in the root itself.
  const rootFiles = topEntries.filter((e) => e.isFile);

  const visitDir = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2) return; // cap walk depth for speed
    let entries: DirEntry[];
    try {
      entries = await readSortedDirEntries(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (!SCAN_IGNORE_DIRS.has(entry.name)) {
          await visitDir(path.join(dir, entry.name), depth + 1);
        }
      } else if (entry.isFile) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext.length > 0) {
          counts.set(ext, (counts.get(ext) ?? 0) + 1);
        }
      }
    }
  };

  // Count root-level files first.
  for (const f of rootFiles) {
    const ext = path.extname(f.name).toLowerCase();
    if (ext.length > 0) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  // Walk subdirectories (breadth-first-ish via sequential await).
  for (const dir of dirsToScan) {
    await visitDir(dir, 0);
  }

  return Array.from(counts.entries()).map(([ext, count]) => ({ ext, count }));
}

// ──────────────────────────────────────────────────────────────────────────
// Manifest parse — narrow, known formats only
// ──────────────────────────────────────────────────────────────────────────

async function parseManifest(filePath: string): Promise<{ name: string | null; entryPoints: string[] }> {
  const filename = path.basename(filePath);
  try {
    const raw = await readFile(filePath, "utf-8");
    switch (filename) {
      case "package.json":
        return parsePackageJson(raw);
      case "pyproject.toml":
      case "setup.py":
        return parsePythonProject(raw, filename);
      case "go.mod":
        return parseGoMod(raw);
      case "Cargo.toml":
        return parseCargoToml(raw);
      default:
        // Other manifests: extract nothing; presence alone is useful.
        return { name: null, entryPoints: [] };
    }
  } catch {
    return { name: null, entryPoints: [] };
  }
}

function parsePackageJson(raw: string): { name: string | null; entryPoints: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { name: null, entryPoints: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { name: null, entryPoints: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const name = typeof obj["name"] === "string" ? obj["name"] : null;
  const entryPoints: string[] = [];
  const bin = obj["bin"];
  if (typeof bin === "string") {
    entryPoints.push(bin);
  } else if (typeof bin === "object" && bin !== null && !Array.isArray(bin)) {
    for (const [key, value] of Object.entries(bin)) {
      // Record the target path when it is a string (e.g. {remnic:'dist/cli.js'}
      // → 'dist/cli.js'); fall back to the bin-key form for non-string
      // values. `bin` is already narrowed to a record by the typeof/!null/
      // !isArray guard above, so no cast is needed (codex review P2).
      entryPoints.push(typeof value === "string" ? value : `bin/${key}`);
    }
  }
  const main = typeof obj["main"] === "string" ? obj["main"] : null;
  if (main) entryPoints.push(main);
  const module = typeof obj["module"] === "string" ? obj["module"] : null;
  if (module) entryPoints.push(module);
  const scripts = obj["scripts"];
  if (typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)) {
    const scriptKeys = Object.keys(scripts as Record<string, unknown>);
    // Only surface the most useful entry-point scripts.
    for (const key of ["start", "dev", "serve"]) {
      if (scriptKeys.includes(key)) entryPoints.push(`scripts.${key}`);
    }
  }
  return { name, entryPoints };
}

function parsePythonProject(raw: string, _filename: string): { name: string | null; entryPoints: string[] } {
  // pyproject.toml: extract [project] name; setup.py: extract name=.
  const entryPoints: string[] = [];
  let name: string | null = null;
  const nameMatch = raw.match(/^name\s*=\s*["']([^"']+)["']/m);
  if (nameMatch) name = nameMatch[1] ?? null;
  // Anchor on the next `[section]` header OR end-of-string (`$`). Do NOT use
  // `\Z` — JavaScript regex treats it as a literal `Z`, so a `[project.scripts]`
  // table at EOF (the common layout) never matched and every console-script
  // entry point was dropped from the card (codex P2 review).
  const scriptsMatch = raw.match(/\[project\.scripts\]([\s\S]*?)(?:\n\[|$)/);
  if (scriptsMatch && scriptsMatch[1]) {
    for (const line of scriptsMatch[1].split("\n")) {
      const m = line.match(/^([a-zA-Z0-9_-]+)\s*=/);
      if (m && m[1]) entryPoints.push(`scripts.${m[1]}`);
    }
  }
  return { name, entryPoints };
}

function parseGoMod(raw: string): { name: string | null; entryPoints: string[] } {
  const moduleMatch = raw.match(/^module\s+(\S+)/m);
  const name = moduleMatch && moduleMatch[1] ? moduleMatch[1] : null;
  return { name, entryPoints: name ? ["main.go"] : [] };
}

function parseCargoToml(raw: string): { name: string | null; entryPoints: string[] } {
  const nameMatch = raw.match(/^name\s*=\s*"([^"]+)"/m);
  const name = nameMatch && nameMatch[1] ? nameMatch[1] : null;
  const entryPoints: string[] = [];
  if (/\[\[bin\]\]/.test(raw)) entryPoints.push("src/bin/");
  if (name) entryPoints.push("src/main.rs");
  return { name, entryPoints };
}

// ──────────────────────────────────────────────────────────────────────────
// Render — deterministic markdown
// ──────────────────────────────────────────────────────────────────────────

function renderCard(scan: RepoScan, now: Date): string {
  const lines: string[] = [];
  lines.push(`# Architecture Card — ${scan.root}`);
  lines.push("");
  lines.push(`_Generated ${now.toISOString()}_`);
  lines.push("");

  // Project name from the first manifest that provides one.
  const namedManifest = scan.manifests.find((m) => m.name !== null);
  if (namedManifest && namedManifest.name) {
    lines.push(`**Project:** ${namedManifest.name}`);
    lines.push("");
  }

  // Manifests
  if (scan.manifests.length > 0) {
    lines.push("## Manifests");
    for (const m of scan.manifests) {
      const label = m.name ? `${m.filename} (${m.name})` : m.filename;
      lines.push(`- ${label}`);
    }
    lines.push("");
  }

  // Top-level directories
  if (scan.topDirs.length > 0) {
    lines.push("## Top-level directories");
    // Wrap into columns of 4 for compactness.
    const cols = 4;
    for (let i = 0; i < scan.topDirs.length; i += cols) {
      const row = scan.topDirs.slice(i, i + cols).join(" · ");
      lines.push(`- ${row}`);
    }
    lines.push("");
  }

  // Language histogram (top 10 by count, ties broken alphabetically)
  if (scan.languageHistogram.length > 0) {
    lines.push("## Languages (by file count)");
    const top = scan.languageHistogram.slice(0, 10);
    for (const entry of top) {
      lines.push(`- ${entry.ext}: ${entry.count}`);
    }
    lines.push("");
  }

  // Entry points
  const allEntryPoints = sortStrings(scan.manifests.flatMap((m) => m.entryPoints));
  if (allEntryPoints.length > 0) {
    lines.push("## Entry points");
    for (const ep of allEntryPoints) {
      lines.push(`- ${ep}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers — sort + cap
// ──────────────────────────────────────────────────────────────────────────

function sortStrings(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function sortLanguageHistogram(entries: LanguageEntry[]): LanguageEntry[] {
  return [...entries].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.ext.localeCompare(b.ext);
  });
}

/**
 * Cap a string to `maxBytes` of UTF-8. If truncation occurs, append a
 * visible marker on its own line (rule 34 — never silently incomplete).
 */
function capToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const byteLen = Buffer.byteLength(text, "utf-8");
  if (byteLen <= maxBytes) {
    return { text, truncated: false };
  }
  const marker = `\n\n_${ARCHITECTURE_CARD_TRUNCATION_MARKER}_`;
  const markerBytes = Buffer.byteLength(marker, "utf-8");
  const budget = maxBytes - markerBytes;
  if (budget <= 0) {
    // Extremely tight cap — return just the marker.
    return { text: marker.trimStart(), truncated: true };
  }
  // Walk the string to find a UTF-8-safe cut point.
  let cut = 0;
  let running = 0;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const charBytes = Buffer.byteLength(chars[i], "utf-8");
    if (running + charBytes > budget) break;
    running += charBytes;
    cut = i + 1;
  }
  return { text: chars.slice(0, cut).join("") + marker, truncated: true };
}

/**
 * Clamp an LLM SUMMARY to `maxBytes` of UTF-8. Unlike {@link capToBytes}, this
 * uses a neutral trailing ellipsis (never the card-truncation marker) and keeps
 * the result — ellipsis included — within `maxBytes`. A clamped summary must
 * never imply the deterministic CARD was truncated, nor spill past its reserved
 * budget into the deterministic sections (cursor/codex review).
 */
function clampSummaryToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  const ellipsis = " …";
  const budget = maxBytes - Buffer.byteLength(ellipsis, "utf-8");
  if (budget <= 0) return "";
  let cut = 0;
  let running = 0;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const charBytes = Buffer.byteLength(chars[i], "utf-8");
    if (running + charBytes > budget) break;
    running += charBytes;
    cut = i + 1;
  }
  return chars.slice(0, cut).join("") + ellipsis;
}
