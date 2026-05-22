import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { log } from "./logger.js";
import type {
  NativeKnowledgeConfig,
  NativeKnowledgeObsidianVaultConfig,
} from "./types.js";

export type NativeKnowledgeChunk = {
  chunkId: string;
  sourcePath: string;
  title: string;
  sourceKind:
    | "identity"
    | "memory"
    | "workspace_doc"
    | "obsidian_note"
    | "bootstrap_doc"
    | "handoff"
    | "daily_summary"
    | "automation_note";
  startLine: number;
  endLine: number;
  content: string;
  vaultId?: string;
  notePath?: string;
  noteKey?: string;
  derivedDate?: string;
  tags?: string[];
  aliases?: string[];
  wikilinks?: string[];
  backlinks?: string[];
  namespace?: string;
  privacyClass?: string;
  sourceHash?: string;
  mtimeMs?: number;
  sessionKey?: string;
  workflowKey?: string;
  author?: string;
  agent?: string;
};

export type NativeKnowledgeSearchResult = NativeKnowledgeChunk & {
  score: number;
};

interface ParsedFrontmatter {
  body: string;
  bodyStartLine: number;
  data: Record<string, string | string[]>;
}

interface ObsidianNoteState {
  noteKey: string;
  notePath: string;
  title: string;
  derivedDate?: string;
  tags: string[];
  aliases: string[];
  wikilinks: string[];
  backlinks: string[];
  namespace?: string;
  privacyClass?: string;
  sourceHash: string;
  mtimeMs: number;
  deleted: boolean;
  deletedAt?: string;
  chunks: NativeKnowledgeChunk[];
}

interface ObsidianVaultState {
  vaultId: string;
  rootDir: string;
  syncedAt: string;
  notes: Record<string, ObsidianNoteState>;
}

interface ObsidianSyncState {
  version: 1;
  updatedAt: string;
  vaults: Record<string, ObsidianVaultState>;
}

interface OpenClawWorkspaceFileState {
  sourcePath: string;
  sourceKind: Exclude<NativeKnowledgeChunk["sourceKind"], "obsidian_note">;
  title: string;
  namespace?: string;
  privacyClass?: string;
  derivedDate?: string;
  sessionKey?: string;
  workflowKey?: string;
  author?: string;
  agent?: string;
  sourceHash: string;
  syncConfigHash: string;
  mtimeMs: number;
  deleted: boolean;
  deletedAt?: string;
  chunks: NativeKnowledgeChunk[];
}

interface OpenClawWorkspaceSyncState {
  version: 1;
  updatedAt: string;
  files: Record<string, OpenClawWorkspaceFileState>;
}

interface CuratedIncludeFileState {
  sourcePath: string;
  sourceKind: Extract<NativeKnowledgeChunk["sourceKind"], "identity" | "memory" | "workspace_doc">;
  title: string;
  namespace?: string;
  privacyClass?: string;
  derivedDate?: string;
  sourceHash: string;
  syncConfigHash: string;
  mtimeMs: number;
  deleted: boolean;
  deletedAt?: string;
  chunks: NativeKnowledgeChunk[];
}

interface CuratedIncludeFilesSyncState {
  version: 1;
  updatedAt: string;
  files: Record<string, CuratedIncludeFileState>;
}

export interface NativeKnowledgeSyncResult {
  statePath: string;
  vaultCount: number;
  touchedNotes: number;
  deletedNotes: number;
  chunkCount: number;
  activeChunks: NativeKnowledgeChunk[];
}

const PERSISTED_NATIVE_KNOWLEDGE_STATE_FILES = new Set([
  "obsidian-sync.json",
  "curated-include-sync.json",
  "openclaw-workspace-sync.json",
]);

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value).split(/\s+/).filter((token) => token.length >= 2);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0).map((value) => value.trim()))].sort();
}

function detectSourceKind(filePath: string): CuratedIncludeFileState["sourceKind"] {
  const base = path.basename(filePath).toLowerCase();
  if (base.startsWith("identity")) return "identity";
  if (base === "memory.md") return "memory";
  return "workspace_doc";
}

function parseInlineArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { body: normalized, bodyStartLine: 1, data: {} };
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing === -1) return { body: normalized, bodyStartLine: 1, data: {} };

  const data: Record<string, string | string[]> = {};
  const lines = normalized.slice(4, closing).split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      index += 1;
      continue;
    }
    const [, key, rawValue] = match;
    if (rawValue.trim().length > 0) {
      const inlineArray = parseInlineArray(rawValue);
      data[key] = inlineArray.length > 0 ? inlineArray : rawValue.trim().replace(/^['"]|['"]$/g, "");
      index += 1;
      continue;
    }

    const items: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const next = lines[cursor] ?? "";
      const itemMatch = /^\s*-\s*(.+)$/.exec(next);
      if (!itemMatch) break;
      items.push(itemMatch[1]!.trim().replace(/^['"]|['"]$/g, ""));
      cursor += 1;
    }
    data[key] = items;
    index = cursor;
  }

  return {
    body: normalized.slice(closing + 5),
    bodyStartLine: normalized.slice(0, closing + 5).split("\n").length,
    data,
  };
}

function firstStringValue(
  data: Record<string, string | string[]>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function normalizeIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const isoDateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (isoDateMatch) return isoDateMatch[1];
  const slashDateMatch = /^(\d{4})[\/_](\d{2})[\/_](\d{2})$/.exec(trimmed);
  if (slashDateMatch) return `${slashDateMatch[1]}-${slashDateMatch[2]}-${slashDateMatch[3]}`;
  return undefined;
}

function deriveDateFromPath(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, "/");
  const hyphenated = /(\d{4}-\d{2}-\d{2})/.exec(normalized);
  if (hyphenated) return hyphenated[1];
  const split = /(^|\/)(\d{4})\/(\d{2})\/(\d{2})(?=\/|[^/\n]*\.md$)/.exec(normalized);
  if (split) return `${split[2]}-${split[3]}-${split[4]}`;
  return undefined;
}

function deriveArtifactDate(filePath: string, parsed: ParsedFrontmatter): string | undefined {
  return (
    normalizeIsoDate(firstStringValue(parsed.data, ["date", "recordedAt", "generatedAt", "summaryDate", "day"]))
    ?? deriveDateFromPath(filePath)
  );
}

function deriveNamespaceFromIncludePath(sourcePath: string): string | undefined {
  const basename = path.basename(sourcePath);
  const match = /^identity\.([^.\/]+)\.md$/i.exec(basename);
  return match?.[1];
}

function compileDailyNotePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = escaped
    .replace(/YYYY/g, "(?<year>\\d{4})")
    .replace(/MM/g, "(?<month>\\d{2})")
    .replace(/DD/g, "(?<day>\\d{2})");
  return new RegExp(`^${regex}$`);
}

function deriveDailyNoteDate(notePath: string, patterns: string[]): string | undefined {
  const withoutExt = notePath.replace(/\.md$/i, "");
  for (const pattern of patterns) {
    const match = compileDailyNotePattern(pattern).exec(withoutExt);
    if (!match?.groups) continue;
    const { year, month, day } = match.groups;
    if (!year || !month || !day) continue;
    return `${year}-${month}-${day}`;
  }
  return undefined;
}

function extractInlineTags(content: string): string[] {
  const matches = [...content.matchAll(/(^|\s)#([a-z0-9/_-]+)/gi)];
  return uniqueSorted(matches.map((match) => match[2] ?? ""));
}

function extractWikilinks(content: string): { targets: string[]; aliases: string[] } {
  const targets: string[] = [];
  const aliases: string[] = [];
  const regex = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
  for (const match of content.matchAll(regex)) {
    const target = (match[1] ?? "").trim();
    const alias = (match[2] ?? "").trim();
    if (target) targets.push(target);
    if (alias) aliases.push(alias);
  }
  return {
    targets: uniqueSorted(targets),
    aliases: uniqueSorted(aliases),
  };
}

function normalizePathPrefix(prefix: string): string {
  const fwd = prefix.replace(/\\/g, "/");
  let start = 0;
  while (start < fwd.length && fwd[start] === "/") start++;
  let end = fwd.length;
  while (end > start && fwd[end - 1] === "/") end--;
  return fwd.substring(start, end);
}

function classifyObsidianNote(
  notePath: string,
  vault: NativeKnowledgeObsidianVaultConfig,
): { namespace?: string; privacyClass?: string } {
  let namespace = vault.namespace;
  let privacyClass = vault.privacyClass;
  const normalizedPath = notePath.replace(/\\/g, "/");
  const rules = [...vault.folderRules].sort(
    (a, b) => normalizePathPrefix(b.pathPrefix).length - normalizePathPrefix(a.pathPrefix).length,
  );

  for (const rule of rules) {
    const prefix = normalizePathPrefix(rule.pathPrefix);
    if (!prefix) continue;
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      namespace = rule.namespace ?? namespace;
      privacyClass = rule.privacyClass ?? privacyClass;
      break;
    }
  }

  return { namespace, privacyClass };
}

function chunkHeadingAware(options: {
  sourcePath: string;
  content: string;
  maxChunkChars: number;
  startLineOffset?: number;
  createChunk: (args: {
    title: string;
    startLine: number;
    endLine: number;
    content: string;
  }) => NativeKnowledgeChunk;
}): NativeKnowledgeChunk[] {
  const lines = options.content.replace(/\r\n/g, "\n").split("\n");
  const chunks: NativeKnowledgeChunk[] = [];
  let currentTitle = path.basename(options.sourcePath);
  let currentLines: string[] = [];
  let startLine = 1 + (options.startLineOffset ?? 0);

  const flush = () => {
    const paragraphs: Array<{
      content: string;
      startLine: number;
      endLine: number;
    }> = [];
    let paragraphLines: string[] = [];
    let paragraphStartOffset: number | null = null;

    const pushParagraph = (lineOffsetExclusive: number) => {
      if (paragraphLines.length === 0 || paragraphStartOffset === null) return;
      paragraphs.push({
        content: paragraphLines.join("\n").trim(),
        startLine: startLine + paragraphStartOffset,
        endLine: startLine + lineOffsetExclusive - 1,
      });
      paragraphLines = [];
      paragraphStartOffset = null;
    };

    for (let index = 0; index < currentLines.length; index += 1) {
      const line = currentLines[index] ?? "";
      const isListLine = /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
      const previousLine = index > 0 ? (currentLines[index - 1] ?? "") : "";
      const previousWasList = /^\s*(?:[-*+]|\d+\.)\s+/.test(previousLine);
      if (line.trim().length === 0) {
        pushParagraph(index);
        continue;
      }
      if (isListLine && paragraphLines.length > 0 && !previousWasList) {
        pushParagraph(index);
      }
      if (paragraphStartOffset === null) paragraphStartOffset = index;
      paragraphLines.push(line);
    }
    pushParagraph(currentLines.length);

    if (paragraphs.length === 0) return;

    const body = paragraphs.map((paragraph) => paragraph.content).join("\n\n");
    if (body.length <= options.maxChunkChars) {
      chunks.push(options.createChunk({
        title: currentTitle,
        startLine: paragraphs[0]!.startLine,
        endLine: paragraphs[paragraphs.length - 1]!.endLine,
        content: body,
      }));
      return;
    }

    let buffer = "";
    let bufferStartLine = paragraphs[0]!.startLine;
    let bufferEndLine = paragraphs[0]!.endLine;

    for (const paragraph of paragraphs) {
      const next = buffer.length > 0 ? `${buffer}\n\n${paragraph.content}` : paragraph.content;
      if (next.length > options.maxChunkChars && buffer.length > 0) {
        chunks.push(options.createChunk({
          title: currentTitle,
          startLine: bufferStartLine,
          endLine: bufferEndLine,
          content: buffer,
        }));
        buffer = paragraph.content;
        bufferStartLine = paragraph.startLine;
        bufferEndLine = paragraph.endLine;
      } else {
        buffer = next;
        bufferEndLine = paragraph.endLine;
      }
    }

    if (buffer.length > 0) {
      chunks.push(options.createChunk({
        title: currentTitle,
        startLine: bufferStartLine,
        endLine: bufferEndLine,
        content: buffer,
      }));
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,6}\s+/.test(line) && currentLines.length > 0) {
      flush();
      currentLines = [];
      currentTitle = line.replace(/^#{1,6}\s+/, "").trim() || currentTitle;
      startLine = index + 2 + (options.startLineOffset ?? 0);
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      currentTitle = line.replace(/^#{1,6}\s+/, "").trim() || currentTitle;
      startLine = index + 2 + (options.startLineOffset ?? 0);
      continue;
    }
    currentLines.push(line);
  }

  flush();
  return chunks;
}

async function readableFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function resolveCandidatePaths(options: {
  workspaceDir: string;
  includeFiles: string[];
  recallNamespaces?: string[];
  defaultNamespace: string;
  identityVariantMode: "recall" | "disk";
}): Promise<string[]> {
  const out = new Set<string>();
  const workspaceRoot = path.resolve(options.workspaceDir);
  const resolveWorkspaceFile = (relativePath: string): string | null => {
    if (path.isAbsolute(relativePath)) return null;
    const resolved = path.resolve(workspaceRoot, relativePath);
    const relative = path.relative(workspaceRoot, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return null;
    }
    return resolved;
  };
  const safeIdentityNamespace = (namespace: string): string | null => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(namespace)) return null;
    if (namespace.includes("..")) return null;
    return namespace;
  };
  for (const rel of options.includeFiles) {
    const trimmed = rel.trim();
    if (!trimmed) continue;
    const candidatePath = resolveWorkspaceFile(trimmed);
    if (candidatePath === null) continue;
    out.add(candidatePath);
    if (path.basename(trimmed).toLowerCase() !== "identity.md") continue;

    const relativeDir = path.dirname(trimmed);
    if (options.identityVariantMode === "recall") {
      if (!Array.isArray(options.recallNamespaces)) continue;
      for (const namespace of options.recallNamespaces) {
        if (!namespace || namespace === options.defaultNamespace) continue;
        const safeNamespace = safeIdentityNamespace(namespace);
        if (safeNamespace === null) continue;
        const variantPath = resolveWorkspaceFile(path.join(relativeDir, `IDENTITY.${safeNamespace}.md`));
        if (variantPath !== null) out.add(variantPath);
      }
      continue;
    }

    const absoluteDir = path.dirname(candidatePath);
    let entries: string[] = [];
    try {
      entries = await readdir(absoluteDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^identity\.[^.\/]+\.md$/i.test(entry)) continue;
      const variantPath = resolveWorkspaceFile(path.join(relativeDir, entry));
      if (variantPath !== null) out.add(variantPath);
    }
  }
  return Array.from(out);
}

function resolveNoteTitle(notePath: string, parsed: ParsedFrontmatter): string {
  const rawTitle = parsed.data.title;
  if (typeof rawTitle === "string" && rawTitle.trim().length > 0) return rawTitle.trim();
  const heading = parsed.body.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return path.basename(notePath, path.extname(notePath));
}

function parseFrontmatterList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return uniqueSorted(value);
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()];
  return [];
}

function toPosixRelative(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function globToRegExp(glob: string): RegExp {
  let regex = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    const next = glob[index + 1];
    if (char === "*") {
      if (next === "*") {
        if (glob[index + 2] === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      regex += ".";
      continue;
    }
    if (char === "/") {
      regex += "/";
      continue;
    }
    regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex);
}

function compileGlobs(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => globToRegExp(pattern));
}

function matchesCompiledGlobs(notePath: string, patterns: RegExp[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => pattern.test(notePath));
}

async function listMarkdownFiles(rootDir: string): Promise<string[] | null> {
  const results: string[] = [];
  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      results.push(toPosixRelative(rootDir, fullPath));
    }
  }
  const rootInfo = await stat(rootDir).catch(() => null);
  if (!rootInfo?.isDirectory()) return null;
  await walk(rootDir);
  return results.sort();
}

function resolveFileCandidates(options: {
  listedFiles: string[];
  bootstrapFiles: string[];
  handoffGlobs: string[];
  dailySummaryGlobs: string[];
  automationNoteGlobs: string[];
  workspaceDocGlobs: string[];
  excludeGlobs: string[];
}): Array<{
  sourcePath: string;
  sourceKind: "bootstrap_doc" | "handoff" | "daily_summary" | "automation_note" | "workspace_doc";
}> {
  const out = new Map<string, "bootstrap_doc" | "handoff" | "daily_summary" | "automation_note" | "workspace_doc">();
  const excludes = compileGlobs(options.excludeGlobs);
  const handoff = compileGlobs(options.handoffGlobs);
  const dailySummary = compileGlobs(options.dailySummaryGlobs);
  const automation = compileGlobs(options.automationNoteGlobs);
  const workspaceDocs = compileGlobs(options.workspaceDocGlobs);
  const listedFiles = new Set(options.listedFiles.map((value) => value.replace(/\\/g, "/")));

  for (const file of options.bootstrapFiles.map((value) => value.replace(/\\/g, "/"))) {
    if (listedFiles.has(file) && !matchesCompiledGlobs(file, excludes)) out.set(file, "bootstrap_doc");
  }

  for (const sourcePath of listedFiles) {
    if (matchesCompiledGlobs(sourcePath, excludes)) continue;
    if (out.has(sourcePath)) continue;
    if (matchesCompiledGlobs(sourcePath, handoff)) {
      out.set(sourcePath, "handoff");
      continue;
    }
    if (matchesCompiledGlobs(sourcePath, dailySummary)) {
      out.set(sourcePath, "daily_summary");
      continue;
    }
    if (matchesCompiledGlobs(sourcePath, automation)) {
      out.set(sourcePath, "automation_note");
      continue;
    }
    if (matchesCompiledGlobs(sourcePath, workspaceDocs)) {
      out.set(sourcePath, "workspace_doc");
    }
  }

  return [...out.entries()]
    .map(([sourcePath, sourceKind]) => ({ sourcePath, sourceKind }))
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

export function resolveNativeKnowledgeStatePath(memoryDir: string, config: NativeKnowledgeConfig): string {
  return path.join(memoryDir, config.stateDir, "obsidian-sync.json");
}

export function resolveCuratedIncludeFilesStatePath(memoryDir: string, config: NativeKnowledgeConfig): string {
  return path.join(memoryDir, config.stateDir, "curated-include-sync.json");
}

export function resolveOpenClawWorkspaceStatePath(memoryDir: string, config: NativeKnowledgeConfig): string {
  return path.join(memoryDir, config.stateDir, "openclaw-workspace-sync.json");
}

async function loadSyncState(memoryDir: string, config: NativeKnowledgeConfig): Promise<ObsidianSyncState> {
  const statePath = resolveNativeKnowledgeStatePath(memoryDir, config);
  try {
    const raw = JSON.parse(await readFile(statePath, "utf-8")) as Partial<ObsidianSyncState>;
    if (raw.version !== 1 || typeof raw.vaults !== "object" || !raw.vaults) {
      throw new Error("invalid obsidian native knowledge state");
    }
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
      vaults: raw.vaults as Record<string, ObsidianVaultState>,
    };
  } catch {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      vaults: {},
    };
  }
}

async function loadOpenClawWorkspaceState(
  memoryDir: string,
  config: NativeKnowledgeConfig,
): Promise<OpenClawWorkspaceSyncState> {
  const statePath = resolveOpenClawWorkspaceStatePath(memoryDir, config);
  try {
    const raw = JSON.parse(await readFile(statePath, "utf-8")) as Partial<OpenClawWorkspaceSyncState>;
    if (raw.version !== 1 || typeof raw.files !== "object" || !raw.files) {
      throw new Error("invalid openclaw workspace native knowledge state");
    }
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
      files: raw.files as Record<string, OpenClawWorkspaceFileState>,
    };
  } catch {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      files: {},
    };
  }
}

async function loadCuratedIncludeFilesState(
  memoryDir: string,
  config: NativeKnowledgeConfig,
): Promise<CuratedIncludeFilesSyncState> {
  const statePath = resolveCuratedIncludeFilesStatePath(memoryDir, config);
  try {
    const raw = JSON.parse(await readFile(statePath, "utf-8")) as Partial<CuratedIncludeFilesSyncState>;
    if (raw.version !== 1 || typeof raw.files !== "object" || !raw.files) {
      throw new Error("invalid curated include native knowledge state");
    }
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
      files: raw.files as Record<string, CuratedIncludeFileState>,
    };
  } catch {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      files: {},
    };
  }
}

function deriveOpenClawArtifactMetadata(options: {
  sourcePath: string;
  parsed: ParsedFrontmatter;
  sharedSafeGlobs: string[];
}): Pick<NativeKnowledgeChunk, "derivedDate" | "sessionKey" | "workflowKey" | "author" | "agent" | "namespace" | "privacyClass"> {
  const sharedSafe = compileGlobs(options.sharedSafeGlobs);
  return {
    derivedDate: deriveArtifactDate(options.sourcePath, options.parsed),
    sessionKey: firstStringValue(options.parsed.data, ["sessionKey", "session"]),
    workflowKey: firstStringValue(options.parsed.data, ["workflowKey", "workflow"]),
    author: firstStringValue(options.parsed.data, ["author"]),
    agent: firstStringValue(options.parsed.data, ["agent"]),
    namespace: firstStringValue(options.parsed.data, ["namespace"]),
    privacyClass:
      firstStringValue(options.parsed.data, ["privacyClass", "privacy"])
      ?? (matchesCompiledGlobs(options.sourcePath, sharedSafe) ? "shared_safe" : undefined),
  };
}

function buildOpenClawWorkspaceChunks(options: {
  sourcePath: string;
  sourceKind: "bootstrap_doc" | "handoff" | "daily_summary" | "automation_note" | "workspace_doc";
  body: string;
  bodyStartLine: number;
  maxChunkChars: number;
  sourceHash: string;
  mtimeMs: number;
  metadata: Pick<NativeKnowledgeChunk, "derivedDate" | "sessionKey" | "workflowKey" | "author" | "agent" | "namespace" | "privacyClass">;
}): NativeKnowledgeChunk[] {
  return chunkHeadingAware({
    sourcePath: options.sourcePath,
    content: options.body,
    maxChunkChars: options.maxChunkChars,
    startLineOffset: options.bodyStartLine - 1,
    createChunk: ({ title, startLine, endLine, content }) => ({
      chunkId: `${options.sourceKind}:${options.sourcePath}:${startLine}-${endLine}`,
      sourcePath: options.sourcePath,
      title,
      sourceKind: options.sourceKind,
      startLine,
      endLine,
      content,
      derivedDate: options.metadata.derivedDate,
      sessionKey: options.metadata.sessionKey,
      workflowKey: options.metadata.workflowKey,
      author: options.metadata.author,
      agent: options.metadata.agent,
      namespace: options.metadata.namespace,
      privacyClass: options.metadata.privacyClass,
      sourceHash: options.sourceHash,
      mtimeMs: options.mtimeMs,
    }),
  });
}

function buildObsidianChunks(options: {
  vault: NativeKnowledgeObsidianVaultConfig;
  notePath: string;
  title: string;
  content: string;
  startLineOffset: number;
  derivedDate?: string;
  tags: string[];
  aliases: string[];
  wikilinks: string[];
  backlinks?: string[];
  namespace?: string;
  privacyClass?: string;
  sourceHash: string;
  mtimeMs: number;
  maxChunkChars: number;
}): NativeKnowledgeChunk[] {
  const noteKey = `${options.vault.id}:${options.notePath}`;
  return chunkHeadingAware({
    sourcePath: options.notePath,
    content: options.content,
    maxChunkChars: options.maxChunkChars,
    startLineOffset: options.startLineOffset,
    createChunk: ({ title, startLine, endLine, content }) => ({
      chunkId: `${noteKey}:${startLine}-${endLine}`,
      sourcePath: `${options.vault.id}/${options.notePath}`,
      title,
      sourceKind: "obsidian_note",
      startLine,
      endLine,
      content,
      vaultId: options.vault.id,
      notePath: options.notePath,
      noteKey,
      derivedDate: options.derivedDate,
      tags: options.tags,
      aliases: options.aliases,
      wikilinks: options.wikilinks,
      backlinks: options.backlinks ?? [],
      namespace: options.namespace,
      privacyClass: options.privacyClass,
      sourceHash: options.sourceHash,
      mtimeMs: options.mtimeMs,
    }),
  });
}

function buildAliasIndex(notes: Record<string, ObsidianNoteState>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const note of Object.values(notes)) {
    if (note.deleted) continue;
    const candidates = [
      note.title,
      path.basename(note.notePath, path.extname(note.notePath)),
      note.notePath.replace(/\.md$/i, ""),
      ...note.aliases,
    ];
    for (const candidate of candidates) {
      const key = normalizeText(candidate);
      if (!key) continue;
      const existing = index.get(key) ?? [];
      existing.push(note.noteKey);
      index.set(key, uniqueSorted(existing));
    }
  }
  return index;
}

function materializeBacklinks(notes: Record<string, ObsidianNoteState>): Record<string, string[]> {
  const backlinks = new Map<string, Set<string>>();
  const aliasIndex = buildAliasIndex(notes);
  for (const note of Object.values(notes)) {
    if (note.deleted) continue;
    for (const target of note.wikilinks) {
      const matches = aliasIndex.get(normalizeText(target)) ?? [];
      for (const match of matches) {
        if (match === note.noteKey) continue;
        const bucket = backlinks.get(match) ?? new Set<string>();
        bucket.add(note.notePath);
        backlinks.set(match, bucket);
      }
    }
  }
  return Object.fromEntries(
    [...backlinks.entries()].map(([noteKey, refs]) => [noteKey, [...refs].sort()]),
  );
}

export async function syncObsidianVaults(options: {
  memoryDir: string;
  config: NativeKnowledgeConfig;
}): Promise<NativeKnowledgeSyncResult> {
  if (options.config.obsidianVaults.length === 0) {
    return {
      statePath: resolveNativeKnowledgeStatePath(options.memoryDir, options.config),
      vaultCount: 0,
      touchedNotes: 0,
      deletedNotes: 0,
      chunkCount: 0,
      activeChunks: [],
    };
  }

  const state = await loadSyncState(options.memoryDir, options.config);
  const nextVaults: Record<string, ObsidianVaultState> = {};
  let touchedNotes = 0;
  let deletedNotes = 0;
  let chunkCount = 0;

  for (const vault of options.config.obsidianVaults) {
    const previousVault = state.vaults[vault.id];
    const previousNotes = previousVault?.notes ?? {};
    const notePaths = await listMarkdownFiles(vault.rootDir);
    if (notePaths === null) {
      nextVaults[vault.id] = previousVault ?? {
        vaultId: vault.id,
        rootDir: vault.rootDir,
        syncedAt: new Date().toISOString(),
        notes: previousNotes,
      };
      chunkCount += Object.values(previousNotes)
        .filter((note) => !note.deleted)
        .reduce((total, note) => total + note.chunks.length, 0);
      continue;
    }

    const includePatterns = compileGlobs(vault.includeGlobs);
    const excludePatterns = compileGlobs(vault.excludeGlobs);
    const includedNotePaths = notePaths.filter((notePath) => {
      if (!matchesCompiledGlobs(notePath, includePatterns)) return false;
      if (matchesCompiledGlobs(notePath, excludePatterns)) return false;
      return true;
    });

    const nextNotes: Record<string, ObsidianNoteState> = {};
    const seenNoteKeys = new Set<string>();

    for (const notePath of includedNotePaths) {
      const absPath = path.join(vault.rootDir, notePath);
      const content = await readFile(absPath, "utf-8").catch(() => null);
      if (content === null) continue;
      const info = await stat(absPath).catch(() => null);
      if (!info?.isFile()) continue;

      const sourceHash = createHash("sha256").update(content).digest("hex");
      const noteKey = `${vault.id}:${notePath}`;
      seenNoteKeys.add(noteKey);
      const previous = previousNotes[noteKey];
      if (previous && previous.deleted !== true && previous.sourceHash === sourceHash && previous.mtimeMs === info.mtimeMs) {
        nextNotes[noteKey] = {
          ...previous,
          deleted: false,
          deletedAt: undefined,
        };
        chunkCount += previous.chunks.length;
        continue;
      }

      const parsed = parseFrontmatter(content);
      const { targets } = extractWikilinks(parsed.body);
      const tags = uniqueSorted([
        ...parseFrontmatterList(parsed.data.tags),
        ...extractInlineTags(parsed.body),
      ]);
      const aliases = parseFrontmatterList(parsed.data.aliases);
      const { namespace, privacyClass } = classifyObsidianNote(notePath, vault);
      const title = resolveNoteTitle(notePath, parsed);
      const derivedDate = deriveDailyNoteDate(notePath, vault.dailyNotePatterns);
      const chunks = buildObsidianChunks({
        vault,
        notePath,
        title,
        content: parsed.body,
        startLineOffset: parsed.bodyStartLine - 1,
        derivedDate,
        tags,
        aliases,
        wikilinks: targets,
        namespace,
        privacyClass,
        sourceHash,
        mtimeMs: info.mtimeMs,
        maxChunkChars: options.config.maxChunkChars,
      });

      nextNotes[noteKey] = {
        noteKey,
        notePath,
        title,
        derivedDate,
        tags,
        aliases,
        wikilinks: targets,
        backlinks: [],
        namespace,
        privacyClass,
        sourceHash,
        mtimeMs: info.mtimeMs,
        deleted: false,
        chunks,
      };
      touchedNotes += 1;
      chunkCount += chunks.length;
    }

    for (const [noteKey, previous] of Object.entries(previousNotes)) {
      if (seenNoteKeys.has(noteKey)) continue;
      nextNotes[noteKey] = {
        ...previous,
        deleted: true,
        deletedAt: new Date().toISOString(),
        chunks: [],
      };
      deletedNotes += 1;
    }

    if (vault.materializeBacklinks) {
      const backlinks = materializeBacklinks(nextNotes);
      for (const note of Object.values(nextNotes)) {
        if (note.deleted) continue;
        note.backlinks = backlinks[note.noteKey] ?? [];
        note.chunks = note.chunks.map((chunk) => ({
          ...chunk,
          backlinks: note.backlinks,
        }));
      }
    }

    nextVaults[vault.id] = {
      vaultId: vault.id,
      rootDir: vault.rootDir,
      syncedAt: new Date().toISOString(),
      notes: nextNotes,
    };
  }

  const nextState: ObsidianSyncState = {
    version: 1,
    updatedAt: new Date().toISOString(),
    vaults: nextVaults,
  };
  const activeChunks = loadActiveObsidianChunks({
    state: nextState,
    defaultNamespace: "default",
  });
  const statePath = resolveNativeKnowledgeStatePath(options.memoryDir, options.config);
  try {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf-8");
  } catch (error) {
    log.warn(`native knowledge: failed to persist obsidian sync state (fail-open): ${String(error)}`);
  }

  return {
    statePath,
    vaultCount: options.config.obsidianVaults.length,
    touchedNotes,
    deletedNotes,
    chunkCount,
    activeChunks,
  };
}

function loadActiveObsidianChunks(options: {
  state: ObsidianSyncState;
  recallNamespaces?: string[];
  defaultNamespace: string;
}): NativeKnowledgeChunk[] {
  const out: NativeKnowledgeChunk[] = [];
  for (const vault of Object.values(options.state.vaults)) {
    for (const note of Object.values(vault.notes)) {
      if (note.deleted) continue;
      if (!isChunkAllowedForRecall(note, options.recallNamespaces, options.defaultNamespace)) continue;
      out.push(...note.chunks);
    }
  }
  return out;
}

function isChunkAllowedForRecall(
  chunk: Pick<NativeKnowledgeChunk, "namespace" | "privacyClass">,
  recallNamespaces: string[] | undefined,
  defaultNamespace: string,
): boolean {
  const namespace = chunk.namespace?.trim() || defaultNamespace;
  if (
    Array.isArray(recallNamespaces) &&
    namespace !== defaultNamespace &&
    !recallNamespaces.includes(namespace)
  ) {
    return false;
  }
  const privacyClass = chunk.privacyClass?.trim().toLowerCase();
  if (
    privacyClass === "private" &&
    Array.isArray(recallNamespaces) &&
    (namespace !== defaultNamespace || !recallNamespaces.includes(defaultNamespace))
  ) {
    return false;
  }
  return true;
}

function loadActiveOpenClawWorkspaceChunks(options: {
  state: OpenClawWorkspaceSyncState;
  recallNamespaces?: string[];
  defaultNamespace: string;
}): NativeKnowledgeChunk[] {
  const out: NativeKnowledgeChunk[] = [];
  for (const file of Object.values(options.state.files)) {
    if (file.deleted) continue;
    if (!isChunkAllowedForRecall(file, options.recallNamespaces, options.defaultNamespace)) continue;
    out.push(...file.chunks);
  }
  return out;
}

function deriveCuratedFileMetadata(options: {
  sourcePath: string;
  parsed: ParsedFrontmatter;
}): Pick<NativeKnowledgeChunk, "derivedDate" | "namespace" | "privacyClass"> {
  return {
    derivedDate: deriveArtifactDate(options.sourcePath, options.parsed),
    namespace: firstStringValue(options.parsed.data, ["namespace"]) ?? deriveNamespaceFromIncludePath(options.sourcePath),
    privacyClass: firstStringValue(options.parsed.data, ["privacyClass", "privacy"]),
  };
}

function buildCuratedIncludeChunks(options: {
  sourcePath: string;
  body: string;
  bodyStartLine: number;
  maxChunkChars: number;
  sourceHash: string;
  mtimeMs: number;
  metadata: Pick<NativeKnowledgeChunk, "derivedDate" | "namespace" | "privacyClass">;
}): NativeKnowledgeChunk[] {
  return chunkHeadingAware({
    sourcePath: options.sourcePath,
    content: options.body,
    maxChunkChars: options.maxChunkChars,
    startLineOffset: options.bodyStartLine - 1,
    createChunk: ({ title, startLine, endLine, content }) => ({
      chunkId: `${options.sourcePath}:${startLine}-${endLine}`,
      sourcePath: options.sourcePath,
      title,
      sourceKind: detectSourceKind(options.sourcePath),
      startLine,
      endLine,
      content,
      derivedDate: options.metadata.derivedDate,
      namespace: options.metadata.namespace,
      privacyClass: options.metadata.privacyClass,
      sourceHash: options.sourceHash,
      mtimeMs: options.mtimeMs,
    }),
  });
}

function loadActiveCuratedIncludeChunks(options: {
  state: CuratedIncludeFilesSyncState;
  recallNamespaces?: string[];
  defaultNamespace: string;
}): NativeKnowledgeChunk[] {
  const out: NativeKnowledgeChunk[] = [];
  for (const file of Object.values(options.state.files)) {
    if (file.deleted) continue;
    if (!isChunkAllowedForRecall(file, options.recallNamespaces, options.defaultNamespace)) continue;
    out.push(...file.chunks);
  }
  return out;
}

function dedupeNativeKnowledgeChunks(chunks: NativeKnowledgeChunk[]): NativeKnowledgeChunk[] {
  const seen = new Set<string>();
  const priority = new Map<NativeKnowledgeChunk["sourceKind"], number>([
    ["handoff", 1],
    ["daily_summary", 2],
    ["bootstrap_doc", 3],
    ["automation_note", 4],
    ["workspace_doc", 5],
    ["identity", 6],
    ["memory", 7],
    ["obsidian_note", 8],
  ]);
  return [...chunks]
    .sort((left, right) => {
      const leftPriority = priority.get(left.sourceKind) ?? 99;
      const rightPriority = priority.get(right.sourceKind) ?? 99;
      return (
        leftPriority - rightPriority
        || left.sourcePath.localeCompare(right.sourcePath)
        || left.startLine - right.startLine
      );
    })
    .filter((chunk) => {
      const key = [
        chunk.sourcePath,
        chunk.startLine,
        chunk.endLine,
        chunk.content,
      ].join("::");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function findPersistedNativeKnowledgeStateFiles(
  rootDir: string,
  maxDepth: number,
  currentDepth: number = 0,
): Promise<string[]> {
  if (currentDepth > maxDepth) return [];
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isFile() && PERSISTED_NATIVE_KNOWLEDGE_STATE_FILES.has(entry.name)) {
      out.push(fullPath);
      continue;
    }
    if (!entry.isDirectory()) continue;
    out.push(...await findPersistedNativeKnowledgeStateFiles(fullPath, maxDepth, currentDepth + 1));
  }
  return out;
}

export async function loadPersistedNativeKnowledgeChunks(options: {
  memoryDir: string;
  recallNamespaces?: string[];
  defaultNamespace: string;
}): Promise<NativeKnowledgeChunk[]> {
  const stateFiles = await findPersistedNativeKnowledgeStateFiles(options.memoryDir, 4);
  if (stateFiles.length === 0) return [];

  const chunks: NativeKnowledgeChunk[] = [];
  for (const statePath of stateFiles.sort()) {
    const raw = await readFile(statePath, "utf-8").catch(() => "");
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { vaults?: unknown; files?: unknown };
      if (typeof parsed.vaults === "object" && parsed.vaults) {
        const state: ObsidianSyncState = {
          version: 1,
          updatedAt: new Date(0).toISOString(),
          vaults: parsed.vaults as Record<string, ObsidianVaultState>,
        };
        chunks.push(...loadActiveObsidianChunks({
          state,
          recallNamespaces: options.recallNamespaces,
          defaultNamespace: options.defaultNamespace,
        }).map((chunk) => {
          const note = Object.values(state.vaults)
            .flatMap((vault) => Object.values(vault.notes))
            .find((entry) => entry.chunks.some((candidate) => candidate.chunkId === chunk.chunkId));
          if (!note) return chunk;
          return {
            ...chunk,
            derivedDate: chunk.derivedDate ?? note.derivedDate,
            namespace: chunk.namespace ?? note.namespace,
            privacyClass: chunk.privacyClass ?? note.privacyClass,
            aliases: chunk.aliases ?? note.aliases,
            tags: chunk.tags ?? note.tags,
            wikilinks: chunk.wikilinks ?? note.wikilinks,
            backlinks: chunk.backlinks ?? note.backlinks,
          };
        }));
        continue;
      }
      if (typeof parsed.files === "object" && parsed.files) {
        if (path.basename(statePath) === "openclaw-workspace-sync.json") {
          const state: OpenClawWorkspaceSyncState = {
            version: 1,
            updatedAt: new Date(0).toISOString(),
            files: parsed.files as Record<string, OpenClawWorkspaceFileState>,
          };
          chunks.push(...loadActiveOpenClawWorkspaceChunks({
            state,
            recallNamespaces: options.recallNamespaces,
            defaultNamespace: options.defaultNamespace,
          }).map((chunk) => {
            const file = state.files[chunk.sourcePath];
            if (!file) return chunk;
            return {
              ...chunk,
              derivedDate: chunk.derivedDate ?? file.derivedDate,
              namespace: chunk.namespace ?? file.namespace,
              privacyClass: chunk.privacyClass ?? file.privacyClass,
              sessionKey: chunk.sessionKey ?? file.sessionKey,
              workflowKey: chunk.workflowKey ?? file.workflowKey,
              author: chunk.author ?? file.author,
              agent: chunk.agent ?? file.agent,
            };
          }));
          continue;
        }
        const state: CuratedIncludeFilesSyncState = {
          version: 1,
          updatedAt: new Date(0).toISOString(),
          files: parsed.files as Record<string, CuratedIncludeFileState>,
        };
        chunks.push(...loadActiveCuratedIncludeChunks({
          state,
          recallNamespaces: options.recallNamespaces,
          defaultNamespace: options.defaultNamespace,
        }).map((chunk) => {
          const file = state.files[chunk.sourcePath];
          if (!file) return chunk;
          return {
            ...chunk,
            derivedDate: chunk.derivedDate ?? file.derivedDate,
            namespace: chunk.namespace ?? file.namespace,
            privacyClass: chunk.privacyClass ?? file.privacyClass,
          };
        }));
      }
    } catch {
      continue;
    }
  }

  return dedupeNativeKnowledgeChunks(chunks);
}

export async function syncOpenClawWorkspaceArtifacts(options: {
  workspaceDir: string;
  memoryDir: string;
  config: NativeKnowledgeConfig;
}): Promise<{
  statePath: string;
  touchedFiles: number;
  deletedFiles: number;
  chunkCount: number;
  activeChunks: NativeKnowledgeChunk[];
}> {
  const adapter = options.config.openclawWorkspace;
  const statePath = resolveOpenClawWorkspaceStatePath(options.memoryDir, options.config);
  if (!adapter?.enabled) {
    return { statePath, touchedFiles: 0, deletedFiles: 0, chunkCount: 0, activeChunks: [] };
  }

  const previousState = await loadOpenClawWorkspaceState(options.memoryDir, options.config);
  const listedFiles = await listMarkdownFiles(options.workspaceDir);
  if (listedFiles === null) {
    return {
      statePath,
      touchedFiles: 0,
      deletedFiles: 0,
      chunkCount: Object.values(previousState.files)
        .filter((file) => !file.deleted)
        .reduce((total, file) => total + file.chunks.length, 0),
      activeChunks: loadActiveOpenClawWorkspaceChunks({
        state: previousState,
        defaultNamespace: "default",
      }),
    };
  }

  const candidates = resolveFileCandidates({
    listedFiles,
    bootstrapFiles: adapter.bootstrapFiles,
    handoffGlobs: adapter.handoffGlobs,
    dailySummaryGlobs: adapter.dailySummaryGlobs,
    automationNoteGlobs: adapter.automationNoteGlobs,
    workspaceDocGlobs: adapter.workspaceDocGlobs,
    excludeGlobs: adapter.excludeGlobs,
  });
  const nextFiles: Record<string, OpenClawWorkspaceFileState> = {};
  const seen = new Set<string>();
  let touchedFiles = 0;
  let deletedFiles = 0;

  for (const candidate of candidates) {
    const absPath = path.join(options.workspaceDir, candidate.sourcePath);
    const content = await readFile(absPath, "utf-8").catch(() => null);
    if (content === null) continue;
    const info = await stat(absPath).catch(() => null);
    if (!info?.isFile()) continue;

    const sourceHash = createHash("sha256").update(content).digest("hex");
    const parsed = parseFrontmatter(content);
    const metadata = deriveOpenClawArtifactMetadata({
      sourcePath: candidate.sourcePath,
      parsed,
      sharedSafeGlobs: adapter.sharedSafeGlobs,
    });
    const title = resolveNoteTitle(candidate.sourcePath, parsed);
    const syncConfigHash = createHash("sha256")
      .update(JSON.stringify({
        sourceKind: candidate.sourceKind,
        maxChunkChars: options.config.maxChunkChars,
        metadata,
      }))
      .digest("hex");
    const previous = previousState.files[candidate.sourcePath];
    if (
      previous &&
      previous.deleted !== true &&
      previous.sourceHash === sourceHash &&
      previous.mtimeMs === info.mtimeMs &&
      previous.syncConfigHash === syncConfigHash
    ) {
      nextFiles[candidate.sourcePath] = {
        ...previous,
        deleted: false,
        deletedAt: undefined,
      };
      seen.add(candidate.sourcePath);
      continue;
    }

    const chunks = buildOpenClawWorkspaceChunks({
      sourcePath: candidate.sourcePath,
      sourceKind: candidate.sourceKind,
      body: parsed.body,
      bodyStartLine: parsed.bodyStartLine,
      maxChunkChars: options.config.maxChunkChars,
      sourceHash,
      mtimeMs: info.mtimeMs,
      metadata,
    });

    nextFiles[candidate.sourcePath] = {
      sourcePath: candidate.sourcePath,
      sourceKind: candidate.sourceKind,
      title,
      namespace: metadata.namespace,
      privacyClass: metadata.privacyClass,
      derivedDate: metadata.derivedDate,
      sessionKey: metadata.sessionKey,
      workflowKey: metadata.workflowKey,
      author: metadata.author,
      agent: metadata.agent,
      sourceHash,
      syncConfigHash,
      mtimeMs: info.mtimeMs,
      deleted: false,
      chunks,
    };
    touchedFiles += 1;
    seen.add(candidate.sourcePath);
  }

  for (const [sourcePath, previous] of Object.entries(previousState.files)) {
    if (seen.has(sourcePath)) continue;
    nextFiles[sourcePath] = {
      ...previous,
      deleted: true,
      deletedAt: new Date().toISOString(),
      chunks: [],
    };
    deletedFiles += 1;
  }

  const nextState: OpenClawWorkspaceSyncState = {
    version: 1,
    updatedAt: new Date().toISOString(),
    files: nextFiles,
  };
  const activeChunks = loadActiveOpenClawWorkspaceChunks({
    state: nextState,
    defaultNamespace: "default",
  });
  const chunkCount = activeChunks.length;
  try {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf-8");
  } catch (error) {
    log.warn(`native knowledge: failed to persist openclaw workspace sync state (fail-open): ${String(error)}`);
  }

  return {
    statePath,
    touchedFiles,
    deletedFiles,
    chunkCount,
    activeChunks,
  };
}

export async function syncCuratedIncludeFiles(options: {
  workspaceDir: string;
  memoryDir: string;
  config: NativeKnowledgeConfig;
  recallNamespaces?: string[];
  defaultNamespace: string;
  skipSourcePaths?: string[];
}): Promise<{
  statePath: string;
  touchedFiles: number;
  deletedFiles: number;
  chunkCount: number;
  activeChunks: NativeKnowledgeChunk[];
}> {
  const statePath = resolveCuratedIncludeFilesStatePath(options.memoryDir, options.config);
  const previousState = await loadCuratedIncludeFilesState(options.memoryDir, options.config);
  const workspaceInfo = await stat(options.workspaceDir).catch(() => null);
  if (!workspaceInfo?.isDirectory()) {
    return {
      statePath,
      touchedFiles: 0,
      deletedFiles: 0,
      chunkCount: Object.values(previousState.files)
        .filter((file) => !file.deleted)
        .reduce((total, file) => total + file.chunks.length, 0),
      activeChunks: loadActiveCuratedIncludeChunks({
        state: previousState,
        recallNamespaces: options.recallNamespaces,
        defaultNamespace: options.defaultNamespace,
      }),
    };
  }

  const skipped = new Set((options.skipSourcePaths ?? []).map((value) => value.replace(/\\/g, "/")));
  const candidatePaths = await resolveCandidatePaths({
    workspaceDir: options.workspaceDir,
    includeFiles: options.config.includeFiles,
    defaultNamespace: options.defaultNamespace,
    identityVariantMode: "disk",
  });
  const nextFiles: Record<string, CuratedIncludeFileState> = {};
  const seen = new Set<string>();
  let touchedFiles = 0;
  let deletedFiles = 0;

  for (const filePath of candidatePaths) {
    if (!(await readableFile(filePath))) continue;
    const content = await readFile(filePath, "utf-8").catch(() => null);
    if (content === null) continue;
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) continue;

    const sourcePath = path.relative(options.workspaceDir, filePath).replace(/\\/g, "/");
    if (skipped.has(sourcePath)) continue;

    const parsed = parseFrontmatter(content);
    const metadata = deriveCuratedFileMetadata({
      sourcePath,
      parsed,
    });
    const sourceKind = detectSourceKind(sourcePath);
    const sourceHash = createHash("sha256").update(content).digest("hex");
    const title = resolveNoteTitle(sourcePath, parsed);
    const syncConfigHash = createHash("sha256")
      .update(JSON.stringify({
        sourceKind,
        maxChunkChars: options.config.maxChunkChars,
        metadata,
      }))
      .digest("hex");
    const previous = previousState.files[sourcePath];
    if (
      previous &&
      previous.deleted !== true &&
      previous.sourceHash === sourceHash &&
      previous.mtimeMs === info.mtimeMs &&
      previous.syncConfigHash === syncConfigHash
    ) {
      nextFiles[sourcePath] = {
        ...previous,
        deleted: false,
        deletedAt: undefined,
      };
      seen.add(sourcePath);
      continue;
    }

    const chunks = buildCuratedIncludeChunks({
      sourcePath,
      body: parsed.body,
      bodyStartLine: parsed.bodyStartLine,
      maxChunkChars: options.config.maxChunkChars,
      sourceHash,
      mtimeMs: info.mtimeMs,
      metadata,
    });
    nextFiles[sourcePath] = {
      sourcePath,
      sourceKind,
      title,
      namespace: metadata.namespace,
      privacyClass: metadata.privacyClass,
      derivedDate: metadata.derivedDate,
      sourceHash,
      syncConfigHash,
      mtimeMs: info.mtimeMs,
      deleted: false,
      chunks,
    };
    touchedFiles += 1;
    seen.add(sourcePath);
  }

  for (const [sourcePath, previous] of Object.entries(previousState.files)) {
    if (seen.has(sourcePath) || skipped.has(sourcePath)) continue;
    if (previous.deleted) {
      nextFiles[sourcePath] = previous;
      continue;
    }
    nextFiles[sourcePath] = {
      ...previous,
      deleted: true,
      deletedAt: new Date().toISOString(),
      chunks: [],
    };
    deletedFiles += 1;
  }

  const nextState: CuratedIncludeFilesSyncState = {
    version: 1,
    updatedAt: new Date().toISOString(),
    files: nextFiles,
  };
  const activeChunks = loadActiveCuratedIncludeChunks({
    state: nextState,
    recallNamespaces: options.recallNamespaces,
    defaultNamespace: options.defaultNamespace,
  });
  const chunkCount = Object.values(nextFiles)
    .filter((file) => !file.deleted)
    .reduce((total, file) => total + file.chunks.length, 0);
  try {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf-8");
  } catch (error) {
    log.warn(`native knowledge: failed to persist curated include sync state (fail-open): ${String(error)}`);
  }

  return {
    statePath,
    touchedFiles,
    deletedFiles,
    chunkCount,
    activeChunks,
  };
}

export async function collectNativeKnowledgeChunks(options: {
  workspaceDir: string;
  memoryDir?: string;
  config: NativeKnowledgeConfig;
  recallNamespaces?: string[];
  defaultNamespace: string;
  abortSignal?: AbortSignal;
}): Promise<NativeKnowledgeChunk[]> {
  throwIfNativeKnowledgeAborted(options.abortSignal);
  if (!options.config.enabled) return [];

  const chunks: NativeKnowledgeChunk[] = [];
  const openclawBootstrapFiles = new Set(
    (options.memoryDir && options.config.openclawWorkspace?.enabled
      ? options.config.openclawWorkspace.bootstrapFiles
      : []
    )
      .map((value) => value.replace(/\\/g, "/")),
  );
  if (options.memoryDir) {
    throwIfNativeKnowledgeAborted(options.abortSignal);
    const syncResult = await syncCuratedIncludeFiles({
      workspaceDir: options.workspaceDir,
      memoryDir: options.memoryDir,
      config: options.config,
      recallNamespaces: options.recallNamespaces,
      defaultNamespace: options.defaultNamespace,
      skipSourcePaths: [...openclawBootstrapFiles],
    });
    chunks.push(...syncResult.activeChunks);
  } else {
    throwIfNativeKnowledgeAborted(options.abortSignal);
    const candidatePaths = await resolveCandidatePaths({
      workspaceDir: options.workspaceDir,
      includeFiles: options.config.includeFiles,
      recallNamespaces: options.recallNamespaces,
      defaultNamespace: options.defaultNamespace,
      identityVariantMode: "recall",
    });
    for (const filePath of candidatePaths) {
      throwIfNativeKnowledgeAborted(options.abortSignal);
      if (!(await readableFile(filePath))) continue;
      const content = await readFile(filePath, "utf-8").catch(() => null);
      if (!content) continue;
      const sourcePath = path.relative(options.workspaceDir, filePath).replace(/\\/g, "/");
      if (openclawBootstrapFiles.has(sourcePath)) continue;
      const parsed = parseFrontmatter(content);
      const metadata = deriveCuratedFileMetadata({
        sourcePath,
        parsed,
      });
      const directChunks = buildCuratedIncludeChunks({
        sourcePath,
        body: parsed.body,
        bodyStartLine: parsed.bodyStartLine,
        maxChunkChars: options.config.maxChunkChars,
        sourceHash: createHash("sha256").update(content).digest("hex"),
        mtimeMs: 0,
        metadata,
      }).filter((chunk) => isChunkAllowedForRecall(chunk, options.recallNamespaces, options.defaultNamespace));
      chunks.push(...directChunks);
    }
  }

  if (options.memoryDir && options.config.openclawWorkspace?.enabled) {
    throwIfNativeKnowledgeAborted(options.abortSignal);
    const syncResult = await syncOpenClawWorkspaceArtifacts({
      workspaceDir: options.workspaceDir,
      memoryDir: options.memoryDir,
      config: options.config,
    });
    chunks.push(
      ...syncResult.activeChunks.filter((chunk) =>
        isChunkAllowedForRecall(chunk, options.recallNamespaces, options.defaultNamespace),
      ),
    );
  }

  if (options.memoryDir && options.config.obsidianVaults.length > 0) {
    throwIfNativeKnowledgeAborted(options.abortSignal);
    const syncResult = await syncObsidianVaults({
      memoryDir: options.memoryDir,
      config: options.config,
    });
    chunks.push(
      ...syncResult.activeChunks.filter((chunk) =>
        isChunkAllowedForRecall(chunk, options.recallNamespaces, options.defaultNamespace),
      ),
    );
  }

  return dedupeNativeKnowledgeChunks(chunks);
}

function throwIfNativeKnowledgeAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const err = new Error("native knowledge collection aborted");
  Object.defineProperty(err, "name", { value: "AbortError" });
  throw err;
}

export function searchNativeKnowledge(options: {
  query: string;
  chunks: NativeKnowledgeChunk[];
  maxResults: number;
}): NativeKnowledgeSearchResult[] {
  const normalizedQuery = normalizeText(options.query);
  const queryTokens = new Set(tokenize(options.query));
  if (!normalizedQuery || queryTokens.size === 0 || options.maxResults <= 0) return [];
  const temporalQuery = /\b(today|yesterday|recent|latest|current|next|handoff|summary)\b/i.test(options.query);
  const now = Date.now();

  return options.chunks
    .map((chunk) => {
      const metadataText = [
        chunk.title,
        chunk.content,
        chunk.sourcePath,
        chunk.notePath,
        chunk.derivedDate,
        chunk.sessionKey,
        chunk.workflowKey,
        chunk.author,
        chunk.agent,
        ...(chunk.tags ?? []),
        ...(chunk.aliases ?? []),
        ...(chunk.wikilinks ?? []),
        ...(chunk.backlinks ?? []),
      ]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join("\n");
      const normalizedContent = normalizeText(metadataText);
      const contentTokens = new Set(tokenize(normalizedContent));
      let overlap = 0;
      for (const token of queryTokens) {
        if (contentTokens.has(token)) overlap += 1;
      }
      if (overlap === 0 && !normalizedContent.includes(normalizedQuery)) return null;
      const kindBoost =
        chunk.sourceKind === "handoff"
          ? 0.2
          : chunk.sourceKind === "daily_summary"
            ? 0.16
            : chunk.sourceKind === "bootstrap_doc" || chunk.sourceKind === "identity"
              ? 0.15
              : chunk.sourceKind === "memory"
                ? 0.1
                : chunk.sourceKind === "obsidian_note"
                  ? 0.08
                  : chunk.sourceKind === "automation_note"
                    ? 0.06
                    : 0.05;
      const phraseBoost = normalizedContent.includes(normalizedQuery) ? 0.35 : 0;
      const metadataBoost =
        (chunk.aliases?.some((alias) => normalizeText(alias).includes(normalizedQuery)) ? 0.12 : 0) +
        (chunk.tags?.some((tag) => normalizeText(tag).includes(normalizedQuery)) ? 0.08 : 0) +
        (chunk.derivedDate && normalizeText(chunk.derivedDate).includes(normalizedQuery) ? 0.08 : 0) +
        (chunk.sessionKey && normalizeText(chunk.sessionKey).includes(normalizedQuery) ? 0.1 : 0) +
        (chunk.workflowKey && normalizeText(chunk.workflowKey).includes(normalizedQuery) ? 0.08 : 0) +
        (chunk.agent && normalizeText(chunk.agent).includes(normalizedQuery) ? 0.06 : 0) +
        (chunk.author && normalizeText(chunk.author).includes(normalizedQuery) ? 0.05 : 0);
      let temporalBoost = 0;
      if (chunk.derivedDate) {
        const parsed = Date.parse(`${chunk.derivedDate}T00:00:00Z`);
        if (Number.isFinite(parsed)) {
          const ageDays = Math.max(0, Math.floor((now - parsed) / (24 * 60 * 60 * 1000)));
          if (ageDays <= 1) temporalBoost += temporalQuery ? 0.12 : 0.04;
          else if (ageDays <= 7) temporalBoost += temporalQuery ? 0.08 : 0.02;
          else if (temporalQuery && ageDays >= 90) temporalBoost -= 0.08;
        }
      }
      return {
        ...chunk,
        score: overlap / Math.max(queryTokens.size, 1) + kindBoost + phraseBoost + metadataBoost + temporalBoost,
      };
    })
    .filter((chunk): chunk is NativeKnowledgeSearchResult => chunk !== null)
    .sort((a, b) => b.score - a.score || a.sourcePath.localeCompare(b.sourcePath) || a.startLine - b.startLine)
    .slice(0, options.maxResults);
}

export function formatNativeKnowledgeSection(options: {
  results: NativeKnowledgeSearchResult[];
  maxChars: number;
}): string | null {
  if (options.results.length === 0 || options.maxChars <= 0) return null;
  const lines = ["## Curated Workspace Knowledge", ""];
  let used = lines.join("\n").length;

  for (const result of options.results) {
    const snippet = result.content.length > 500 ? `${result.content.slice(0, 497)}...` : result.content;
    const meta = [
      `kind=${result.sourceKind}`,
      result.derivedDate ? `date=${result.derivedDate}` : null,
      result.sessionKey ? `session=${result.sessionKey}` : null,
      result.workflowKey ? `workflow=${result.workflowKey}` : null,
      result.agent ? `agent=${result.agent}` : null,
      result.author ? `author=${result.author}` : null,
      result.tags && result.tags.length > 0 ? `tags=${result.tags.join(",")}` : null,
      result.vaultId ? `vault=${result.vaultId}` : null,
    ]
      .filter((value): value is string => value !== null)
      .join(" ");
    const block =
      `- ${result.sourcePath}:${result.startLine}-${result.endLine} [${result.title}] ` +
      `(score: ${result.score.toFixed(3)}${meta ? `; ${meta}` : ""})\n  ${snippet.replace(/\n/g, "\n  ")}`;
    if (used + block.length > options.maxChars && lines.length > 2) break;
    if (used + block.length > options.maxChars) return null;
    lines.push(block);
    used += block.length + 1;
  }

  return lines.length > 2 ? lines.join("\n") : null;
}
