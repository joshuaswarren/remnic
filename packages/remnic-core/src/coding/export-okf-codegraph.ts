/**
 * Codegraph OKF projection (issue #1950).
 *
 * Read-only projection of one project's code-graph SQLite store into an
 * OKF v0.1 knowledge bundle: the stored architecture card, decision
 * records, and one `Code Module` concept per indexed source file with its
 * symbols and outgoing edges. The store is NEVER opened for write — the
 * SQLite file is opened `readonly`, so an export cannot mutate indexing
 * state and the file's bytes are stable across runs.
 *
 * Rendering discipline mirrors architecture-card.ts (rule 38): byte-stable
 * output for an unchanged graph; every list is sorted with a total order.
 * Shared bundle mechanics come from ../okf/render.ts (one source of truth
 * with the memory exporter, issue #1948).
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lintOkfDir } from "../okf/lint.js";
import {
  OKF_ARCHITECTURE_CARD_TYPE,
  OKF_CODE_MODULE_TYPE,
  OKF_DECISION_RECORD_TYPE,
} from "../okf/type-mapping.js";
import {
  OKF_EXPORT_VERSION,
  publishBundle,
  renderFrontmatter,
  rejectSymlinkPath,
  writeBundleFile,
} from "../okf/render.js";
import { openBetterSqlite3 } from "../runtime/better-sqlite.js";
import { StorageManager, stripAttributesSuffix } from "../storage.js";
import type { PluginConfig } from "../types.js";
import { findArchitectureCardMemory, type ArchitectureSurfaceStorage } from "./architecture-surfaces.js";
import {
  CodegraphRuntimeError,
  codegraphSurfaceVisible,
  listCodegraphProjects,
  resolveCodegraphDbPath,
} from "./codegraph-runtime.js";
import { defaultGitInvoker, normalizeOriginUrl } from "./git-context.js";
import { projectNamespaceName } from "./coding-namespace.js";
import {
  ACTIVE_DECISION_STATUSES,
  DECISION_STATUSES,
  parseDecisionRecord,
  type DecisionRecord,
} from "./decision-records.js";
import { buildCodingGraphInstallHint, isCodingGraphInstalled } from "./optional-coding-graph.js";

/** Default cap on rendered module concepts (`--max-module-concepts`). */
export const DEFAULT_OKF_CODEGRAPH_MAX_MODULE_CONCEPTS = 500;

/**
 * Visible marker written into the root index when module concepts were
 * truncated (mirrors `ARCHITECTURE_CARD_TRUNCATION_MARKER` — never
 * silently incomplete).
 */
export const OKF_CODEGRAPH_TRUNCATION_MARKER = "<!-- okf-codegraph-truncated -->";

export type OkfCodegraphSymbolFilter = "none" | "exported" | "all";

const SYMBOL_FILTERS: readonly OkfCodegraphSymbolFilter[] = ["none", "exported", "all"];

export function parseOkfCodegraphSymbolFilter(raw: unknown): OkfCodegraphSymbolFilter {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value.length === 0) return "exported";
  if ((SYMBOL_FILTERS as readonly string[]).includes(value)) return value as OkfCodegraphSymbolFilter;
  throw new Error(`invalid --symbols ${String(raw)}; allowed: ${SYMBOL_FILTERS.join(", ")}`);
}

export interface ExportOkfCodegraphOptions {
  readonly config: PluginConfig;
  readonly memoryDir: string;
  /** Store owner; defaults to `"default"` like the access-service principal key. */
  readonly principal?: string;
  readonly projectId: string;
  readonly outDir: string;
  /**
   * Working directory used to resolve git context (repo root, origin URL).
   * Defaults to `process.cwd()`.
   */
  readonly cwd?: string;
  readonly maxModuleConcepts?: number;
  readonly symbols?: OkfCodegraphSymbolFilter;
  /** Default ON; pass `false` for `--no-include-adrs`. */
  readonly includeAdrs?: boolean;
  readonly force?: boolean;
  /**
   * Namespace holding the project's decision records + architecture card.
   * Defaults to the project-scope coding namespace for the project id.
   */
  readonly namespace?: string;
}

export interface ExportOkfCodegraphResult {
  readonly projectId: string;
  readonly moduleConcepts: number;
  readonly moduleFilesInGraph: number;
  readonly truncated: boolean;
  readonly decisions: number;
  readonly architectureCard: boolean;
}

interface GraphFileRow {
  readonly id: number;
  readonly path: string;
  readonly lang: string;
}

interface GraphNodeRow {
  readonly name: string;
  readonly label: string;
  readonly file_id: number;
  readonly span_start: number;
  readonly span_end: number;
  readonly is_exported: number;
}

interface GraphEdgeRow {
  readonly type: string;
  readonly confidence: number;
  readonly src_file_id: number;
  readonly dst_file_id: number;
  readonly dst_name: string;
  readonly dst_path: string;
}

export async function exportCodegraphOkfBundle(
  opts: ExportOkfCodegraphOptions,
): Promise<ExportOkfCodegraphResult> {
  if (!codegraphSurfaceVisible(opts.config)) {
    throw new CodegraphRuntimeError(
      "disabled",
      "codegraph tools are disabled (codingKnowledge.enabled or codingKnowledge.codegraphTools is false)",
    );
  }
  if (!(await isCodingGraphInstalled())) {
    throw new CodegraphRuntimeError("package_missing", buildCodingGraphInstallHint());
  }
  const principal = opts.principal?.trim() || "default";
  const projectId = opts.projectId.trim();
  if (projectId.length === 0) {
    throw new CodegraphRuntimeError(
      "project_required",
      "codegraph export-okf requires --project (or a cwd inside the project's git repo)",
    );
  }
  rejectSymlinkPath(path.resolve(opts.outDir));
  // Explicit option validation (config-coercion footgun): honor the given
  // value or fail loudly — never silently default a bad input. `0` is a
  // legitimate "no module concepts" cap and is honored.
  const maxModules = opts.maxModuleConcepts ?? DEFAULT_OKF_CODEGRAPH_MAX_MODULE_CONCEPTS;
  if (!Number.isInteger(maxModules) || maxModules < 0) {
    throw new Error(
      `invalid --max-module-concepts ${String(opts.maxModuleConcepts)}; must be a non-negative integer`,
    );
  }
  const dbPath = resolveCodegraphDbPath({ config: opts.config, memoryDir: opts.memoryDir, principal, projectId });
  if (!existsSync(dbPath)) {
    const known = listCodegraphProjects({
      config: opts.config,
      memoryDir: opts.memoryDir,
      principal,
      listDir: (dir) => {
        try {
          return readdirSync(dir);
        } catch {
          return [];
        }
      },
    });
    throw new CodegraphRuntimeError(
      "project_not_found",
      `no codegraph store for project '${projectId}' (principal '${principal}'); known projects: ${
        known.length > 0 ? known.join(", ") : "(none)"
      }`,
    );
  }

  // Read the graph through a readonly handle — bytes on disk are never
  // touched, and the store cache (write-mode handles) is bypassed entirely.
  const graphIndexedAt = statSync(dbPath).mtime.toISOString();
  const db = openBetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  let files: GraphFileRow[];
  let nodes: GraphNodeRow[];
  let edges: GraphEdgeRow[];
  try {
    files = db.prepare("SELECT id, path, lang FROM files ORDER BY path ASC").all() as GraphFileRow[];
    nodes = db
      .prepare(
        `SELECT n.name, n.label, n.file_id, n.span_start, n.span_end,
                COALESCE(na.is_exported, 0) AS is_exported
           FROM nodes n LEFT JOIN node_attributes na ON na.node_id = n.id`,
      )
      .all() as GraphNodeRow[];
    edges = db
      .prepare(
        `SELECT e.type, e.confidence, s.file_id AS src_file_id, d.file_id AS dst_file_id,
                d.name AS dst_name, df.path AS dst_path
           FROM edges e
           JOIN nodes s ON s.id = e.src
           JOIN nodes d ON d.id = e.dst
           JOIN files df ON d.file_id = df.id`,
      )
      .all() as GraphEdgeRow[];
  } finally {
    db.close();
  }

  // Trust boundary: file paths come from the indexed graph. Reject anything
  // that is not a strict repo-relative POSIX path so a hostile row cannot
  // escape the staging directory via writeBundleFile's path.join.
  const safeFiles = files.filter(
    (f) => f.path.length > 0 && !f.path.startsWith("/") && !f.path.split("/").includes(".."),
  );
  const fileIdToPath = new Map<number, string>(safeFiles.map((f) => [f.id, f.path]));
  const nodesByFile = new Map<number, GraphNodeRow[]>();
  for (const node of nodes) {
    if (!fileIdToPath.has(node.file_id)) continue;
    const list = nodesByFile.get(node.file_id) ?? [];
    list.push(node);
    nodesByFile.set(node.file_id, list);
  }

  // Deterministic truncation: most symbols first, path ascending as the
  // tie-break (issue acceptance: cap of 1 keeps the highest-symbol file).
  const ranked = [...safeFiles].sort((a, b) => {
    const aCount = (nodesByFile.get(a.id) ?? []).length;
    const bCount = (nodesByFile.get(b.id) ?? []).length;
    if (aCount !== bCount) return bCount - aCount;
    return a.path.localeCompare(b.path);
  });
  const keptFiles = ranked.slice(0, maxModules);
  const keptPaths = new Set<string>(keptFiles.map((f) => f.path));
  const truncated = safeFiles.length > keptFiles.length;

  const symbolFilter = parseOkfCodegraphSymbolFilter(opts.symbols);
  const git = await resolveGitHints(opts.cwd ?? process.cwd());
  const staging = await mkdtemp(path.join(os.tmpdir(), "remnic-okf-codegraph-"));
let decisions = 0;
let architectureCard = false;
try {
  const namespace = opts.namespace?.trim() || projectNamespaceName(projectId);
    const namespaceDir = path.join(opts.memoryDir, "namespaces", namespace);
    if (opts.includeAdrs !== false && existsSync(namespaceDir)) {
      const storage = new StorageManager(namespaceDir);
      const memories = await storage.readAllMemories();
      // Architecture card — reuse the surface's classification (rule 53).
      const card = await findArchitectureCardMemory(readOnlyCardStorage(storage, namespaceDir, namespace));
      if (card) {
        architectureCard = true;
        writeBundleFile(
          staging,
          "architecture.md",
          renderFrontmatter({
            type: OKF_ARCHITECTURE_CARD_TYPE,
            title: git.repoName,
            ...(git.originUrl ? { resource: git.originUrl } : git.repoRoot ? { resource: git.repoRoot } : {}),
            timestamp: card.frontmatter.updated ?? card.frontmatter.created,
          }) +
            stripAttributesSuffix(card.content.replace(/^\uFEFF/, "")).trimEnd() +
            "\n",
        );
      }
      const records: Array<{ record: DecisionRecord; timestamp: string }> = [];
      for (const memory of memories) {
        if (memory.frontmatter.category !== "decision") continue;
        try {
          const parsed = parseDecisionRecord(memory.content);
          records.push({
            // Production writes leave the ADR frontmatter id empty and use
            // the memory id as the canonical identifier (decisionRecord
            // surface path) — prefer the ADR id, fall back to the memory id.
            record: parsed.id ? parsed : { ...parsed, id: memory.frontmatter.id },
            timestamp: memory.frontmatter.updated ?? memory.frontmatter.created,
          });
        } catch {
          // Unparseable decision bodies are skipped, mirroring the surface's
          // safeParseDecisionRecord degradation.
        }
      }
      records.sort((a, b) => a.record.title.localeCompare(b.record.title));
      decisions = records.length;
      for (const { record, timestamp } of records) {
        writeBundleFile(staging, `decisions/${decisionFileStem(record)}.md`, renderDecision(record, timestamp));
      }
      if (records.length > 0 || architectureCard) {
        writeBundleFile(staging, "decisions/index.md", renderDecisionsIndex(records));
      }
    }

    for (const file of keptFiles) {
      writeBundleFile(
        staging,
        `modules/${file.path}.md`,
        renderModule(
          file,
          nodesByFile.get(file.id) ?? [],
          edges,
          fileIdToPath,
          keptPaths,
          symbolFilter,
          git,
          graphIndexedAt,
        ),
      );
    }
    if (keptFiles.length > 0) {
      writeBundleFile(staging, "modules/index.md", renderModulesIndex(keptFiles));
    }
    writeBundleFile(
      staging,
      "index.md",
      renderRootIndex(git.repoName, projectId, architectureCard, decisions, keptFiles, safeFiles, truncated),
    );

    // Self-validate with the #1946 conformance checker; non-conformant
    // output fails the command. Reserved basenames (the bundle's own
    // index.md files) are the documented exemption, as in the memory export.
    const lint = lintOkfDir(staging);
    const blocking = lint.findings.filter((f) => f.code !== "skipped_encrypted" && f.code !== "reserved_basename");
    if (blocking.length > 0) {
      throw new Error(`OKF codegraph export failed lint: ${blocking.map((f) => `${f.file}: ${f.message}`).join("; ")}`);
    }
    publishBundle(staging, path.resolve(opts.outDir), opts.force === true);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return {
    projectId,
    moduleConcepts: keptFiles.length,
    moduleFilesInGraph: safeFiles.length,
    truncated,
    decisions,
    architectureCard,
  };
}

/**
 * Read-only adapter over the namespace StorageManager for
 * {@link findArchitectureCardMemory} — write arms throw so a future edit
 * cannot silently turn the exporter into a mutating surface.
 */
function readOnlyCardStorage(
  storage: StorageManager,
  dir: string,
  namespace: string,
): ArchitectureSurfaceStorage {
  return {
    dir,
    namespace,
    readAllMemories: () => storage.readAllMemories(),
    updateMemory: () => {
      throw new Error("codegraph export-okf is read-only");
    },
    writeSealedMemory: () => {
      throw new Error("codegraph export-okf is read-only");
    },
  };
}

interface GitHints {
  readonly repoRoot: string | null;
  readonly repoName: string;
  readonly originUrl: string | null;
}

async function resolveGitHints(cwd: string): Promise<GitHints> {
  try {
    const invoker = defaultGitInvoker();
    const topLevel = await invoker(cwd, ["rev-parse", "--show-toplevel"]);
    if (topLevel.exitCode !== 0) {
      return { repoRoot: null, repoName: "codegraph", originUrl: null };
    }
    const repoRoot = topLevel.stdout.trim();
    const origin = await invoker(repoRoot, ["remote", "get-url", "origin"]);
    const originUrl = origin.exitCode === 0 ? normalizeOriginUrl(origin.stdout) : null;
    return {
      repoRoot: repoRoot || null,
      repoName: (repoRoot && path.basename(repoRoot)) || "codegraph",
      originUrl: originUrl && originUrl.length > 0 ? originUrl : null,
    };
  } catch {
    return { repoRoot: null, repoName: "codegraph", originUrl: null };
  }
}

function moduleResource(git: GitHints, filePath: string): string {
  if (git.originUrl) return `${git.originUrl}/${filePath}`;
  if (git.repoRoot) return path.join(git.repoRoot, filePath);
  return filePath;
}

function confidenceTier(confidence: number): string {
  if (confidence >= 0.9) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

function decisionFileStem(record: Pick<DecisionRecord, "id">): string {
  const safe = record.id.replace(/[^A-Za-z0-9._-]+/g, "_");
  return safe.length > 0 ? safe : "decision";
}

function renderModule(
  file: GraphFileRow,
  fileNodes: readonly GraphNodeRow[],
  edges: readonly GraphEdgeRow[],
  fileIdToPath: ReadonlyMap<number, string>,
  keptPaths: ReadonlySet<string>,
  symbolFilter: OkfCodegraphSymbolFilter,
  git: GitHints,
  graphIndexedAt: string,
): string {
  const visible =
    symbolFilter === "all"
      ? [...fileNodes]
      : symbolFilter === "exported"
        ? fileNodes.filter((n) => n.is_exported === 1)
        : [];
  visible.sort((a, b) => (a.name !== b.name ? a.name.localeCompare(b.name) : a.span_start - b.span_start));
  const outEdges = edges
    .filter((e) => e.src_file_id === file.id && fileIdToPath.get(e.src_file_id) === file.path)
    .map((e) => ({
      type: e.type,
      verb: e.type.toLowerCase(),
      dstPath: e.dst_path,
      dstName: e.dst_name,
      tier: confidenceTier(e.confidence),
    }))
    .sort((a, b) =>
      a.type !== b.type
        ? a.type.localeCompare(b.type)
        : a.dstPath !== b.dstPath
          ? a.dstPath.localeCompare(b.dstPath)
          : a.dstName.localeCompare(b.dstName),
    );
  const fields: Record<string, unknown> = {
    type: OKF_CODE_MODULE_TYPE,
    title: file.path,
    description: `${fileNodes.length} symbols, ${file.lang}`,
    resource: moduleResource(git, file.path),
    tags: [file.lang],
    timestamp: graphIndexedAt,
  };
  let body = "";
  if (symbolFilter !== "none") {
    const rows = visible.map((n) => `| ${n.name} | ${n.label} | ${n.span_start}-${n.span_end} |`).join("\n");
    body += `# Symbols\n\n| Name | Kind | Span (bytes) |\n|---|---|---|\n${rows}\n\n`;
  }
  if (outEdges.length > 0) {
    const lines = outEdges.map((e) => {
      // Broken links (target truncated out of the bundle) are legal per OKF
      // §5.3 — the link records the relationship regardless of target presence.
      const href = `/modules/${e.dstPath}.md`;
      const label = e.verb === "calls" ? `${e.dstName}() in ${e.dstPath}` : e.dstPath;
      const broken = keptPaths.has(e.dstPath) ? "" : " (link target not exported)";
      return `- ${e.verb}: [${label}](${href}) (confidence: ${e.tier})${broken}`;
    });
    body += `# Dependencies\n\n${lines.join("\n")}\n\n`;
  }
  return renderFrontmatter(fields) + body.trimEnd() + "\n";
}

function renderModulesIndex(files: readonly GraphFileRow[]): string {
  const groups = new Map<string, GraphFileRow[]>();
  for (const file of files) {
    const key = file.path.includes("/") ? (file.path.split("/")[0] ?? "") : "(root)";
    const list = groups.get(key) ?? [];
    list.push(file);
    groups.set(key, list);
  }
  const sections = [...groups.keys()].sort().map((key) => {
    const lines = (groups.get(key) ?? [])
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => `* [${f.path}](/modules/${f.path}.md)`);
    return `## ${key}\n\n${lines.join("\n")}`;
  });
  return `---\nokf_version: "${OKF_EXPORT_VERSION}"\n---\n\n# Code Modules\n\n${sections.join("\n\n")}\n`;
}

function renderDecisionsIndex(records: ReadonlyArray<{ record: DecisionRecord }>): string {
  // ACTIVE set first — the single classification source (rule 53), never a
  // re-derived list.
  const orderedStatuses = [
    ...DECISION_STATUSES.filter((s) => ACTIVE_DECISION_STATUSES.has(s)),
    ...DECISION_STATUSES.filter((s) => !ACTIVE_DECISION_STATUSES.has(s)),
  ];
  const byStatus = new Map<string, { record: DecisionRecord }[]>();
  for (const entry of records) {
    const list = byStatus.get(entry.record.status) ?? [];
    list.push(entry);
    byStatus.set(entry.record.status, list);
  }
  const sections: string[] = [];
  for (const status of orderedStatuses) {
    const list = byStatus.get(status);
    if (!list || list.length === 0) continue;
    const lines = list
      .map((e) => e.record)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((r) => `* [${r.title}](/decisions/${decisionFileStem(r)}.md)`);
    sections.push(`## ${status[0]!.toUpperCase()}${status.slice(1)}\n\n${lines.join("\n")}`);
  }
  return `---\nokf_version: "${OKF_EXPORT_VERSION}"\n---\n\n# Decision Records\n\n${sections.join("\n\n")}\n`;
}

function renderDecision(record: DecisionRecord, timestamp: string): string {
  const fields: Record<string, unknown> = {
    id: record.id,
    title: record.title,
    status: record.status,
    context: record.context,
    decision: record.decision,
    ...(record.consequences !== undefined ? { consequences: record.consequences } : {}),
    entityRefs: record.entityRefs,
    ...(record.supersedes !== undefined ? { supersedes: record.supersedes } : {}),
    type: OKF_DECISION_RECORD_TYPE,
    timestamp,
  };
  const lines: string[] = [];
  if (record.context) lines.push(record.context, "");
  lines.push("# Decision", "");
  if (record.decision) lines.push(record.decision, "");
  if (record.consequences && record.consequences.length > 0) {
    lines.push("# Consequences", "", record.consequences, "");
  }
  if (record.supersedes !== undefined) {
    lines.push(`- supersedes: [${record.supersedes}](/decisions/${decisionFileStem({ id: record.supersedes })}.md)`, "");
  }
  return renderFrontmatter(fields) + lines.join("\n").trimEnd() + "\n";
}

function renderRootIndex(
  repoName: string,
  projectId: string,
  architectureCard: boolean,
  decisions: number,
  keptFiles: readonly GraphFileRow[],
  totalFiles: readonly GraphFileRow[],
  truncated: boolean,
): string {
  const lines: string[] = [
    `# ${repoName} Code Graph`,
    "",
    `- project: ${projectId}`,
    architectureCard ? "- [Architecture card](/architecture.md)" : "- architecture card: none stored",
    `- decision records: ${decisions}`,
    `- code modules: ${keptFiles.length} of ${totalFiles.length} indexed files`,
    "",
  ];
  if (truncated) {
    lines.push(
      OKF_CODEGRAPH_TRUNCATION_MARKER,
      `Truncated to the ${keptFiles.length} files with the most symbols of ${totalFiles.length} in the graph; raise --max-module-concepts to widen.`,
      "",
    );
  }
  return `---\nokf_version: "${OKF_EXPORT_VERSION}"\n---\n\n${lines.join("\n")}\n`;
}
