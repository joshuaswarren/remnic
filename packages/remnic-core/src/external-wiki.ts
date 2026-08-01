import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ExternalWikiRoot } from "./external-wiki-config.js";

const DEFAULT_MAX_INDEX_BYTES = 1_048_576;
const DEFAULT_MAX_PAGE_BYTES = 1_048_576;
const DEFAULT_MAX_CATALOG_ENTRIES = 10_000;
const DEFAULT_MAX_DIRECTORY_DEPTH = 32;
const MAX_READ_BYTES = 16_777_216;
const MAX_CATALOG_ENTRIES = 100_000;
const MAX_DIRECTORY_DEPTH = 128;
const MIN_VISITED_ENTRIES = 100;
const MAX_VISITED_ENTRIES = 1_000_000;

export type { ExternalWikiRoot } from "./external-wiki-config.js";

export interface ExternalWikiLayout {
  rootDir: string;
  pagesDir: string;
  indexFile: string;
  indexPresent: boolean;
  rawDir?: string;
  outputsDir?: string;
}

export interface ExternalWikiCatalogEntry {
  title: string;
  path: string;
  indexBlurb?: string;
  indexLine?: number;
}

export interface ExternalWikiCatalog {
  wikiId: string;
  indexPresent: boolean;
  entries: ExternalWikiCatalogEntry[];
}

export interface ExternalWikiCatalogLimits {
  maxIndexBytes?: number;
  maxEntries?: number;
  maxDepth?: number;
}

export interface ExternalWikiPage {
  wikiId: string;
  path: string;
  title: string;
  content: string;
  bytes: number;
}

function assertPositiveInteger(value: number, keyName: string, maximum?: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${keyName} must be a positive integer`);
  }
  if (maximum !== undefined && value > maximum) {
    throw new Error(`${keyName} must be at most ${maximum}`);
  }
}

function isInside(baseDir: string, candidate: string): boolean {
  const relative = path.relative(baseDir, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveInside(baseDir: string, relativePath: string, keyName: string): string {
  const resolved = path.resolve(baseDir, relativePath);
  if (!isInside(baseDir, resolved) || resolved === baseDir) {
    throw new Error(`${keyName} must stay within ${baseDir}`);
  }
  return resolved;
}

async function requireDirectory(candidate: string, rootDir: string, description: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${description} does not exist: ${candidate}`);
    }
    throw error;
  }
  if (!isInside(rootDir, canonical)) throw new Error(`${description} escapes rootDir`);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`${description} is not a directory`);
  return canonical;
}

async function optionalDirectory(rootDir: string, name: "raw" | "outputs"): Promise<string | undefined> {
  const candidate = path.join(rootDir, name);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!isInside(rootDir, canonical)) throw new Error(`${name} directory escapes rootDir`);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`${name} path is not a directory`);
  return canonical;
}

async function optionalIndexFile(candidate: string, rootDir: string): Promise<string | undefined> {
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!isInside(rootDir, canonical)) throw new Error("catalog index escapes rootDir");
  if (!(await stat(canonical)).isFile()) throw new Error("catalog index is not a file");
  return canonical;
}

export async function validateExternalWikiLayout(config: ExternalWikiRoot): Promise<ExternalWikiLayout> {
  let rootDir: string;
  try {
    rootDir = await realpath(config.rootDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`external wiki root does not exist: ${config.rootDir}`);
    }
    throw error;
  }
  if (!(await stat(rootDir)).isDirectory()) throw new Error("external wiki root is not a directory");

  const pagesDir = await requireDirectory(
    resolveInside(rootDir, config.pagesDir, "pages directory"),
    rootDir,
    "pages directory"
  );
  const configuredIndexFile = resolveInside(rootDir, config.indexFile, "catalog index");
  const canonicalIndexFile = await optionalIndexFile(configuredIndexFile, rootDir);
  const [rawDir, outputsDir] = await Promise.all([
    optionalDirectory(rootDir, "raw"),
    optionalDirectory(rootDir, "outputs"),
  ]);

  return {
    rootDir,
    pagesDir,
    indexFile: canonicalIndexFile ?? configuredIndexFile,
    indexPresent: canonicalIndexFile !== undefined,
    ...(rawDir === undefined ? {} : { rawDir }),
    ...(outputsDir === undefined ? {} : { outputsDir }),
  };
}

type CatalogPathBase = "index" | "pages";

function normalizeCatalogPath(target: string, config: ExternalWikiRoot, base: CatalogPathBase): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.trim());
  } catch {
    return null;
  }
  const withoutFragment = decoded.split(/[?#]/, 1)[0] ?? "";
  if (
    withoutFragment.length === 0 ||
    withoutFragment.startsWith("/") ||
    withoutFragment.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(withoutFragment)
  ) {
    return null;
  }

  const pagesDir = path.posix.normalize(config.pagesDir);
  let relative: string;
  if (base === "index") {
    const baseDir = path.posix.dirname(config.indexFile);
    const rootRelativeTarget = path.posix.normalize(path.posix.join(baseDir, withoutFragment));
    relative = path.posix.relative(pagesDir, rootRelativeTarget);
  } else {
    const pagesPrefix = pagesDir === "." ? "" : `${pagesDir}/`;
    const stripped = pagesPrefix.length > 0 && withoutFragment.startsWith(pagesPrefix)
      ? withoutFragment.slice(pagesPrefix.length)
      : withoutFragment;
    relative = path.posix.normalize(stripped);
  }
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative) ||
    relative === "." ||
    !relative.toLowerCase().endsWith(".md")
  ) {
    return null;
  }
  return relative;
}

function catalogBlurb(line: string, matchEnd: number): string | undefined {
  const blurb = line
    .slice(matchEnd)
    .trim()
    .replace(/^[-:|]\s*/, "")
    .trim();
  return blurb.length === 0 ? undefined : blurb;
}

export function parseExternalWikiCatalog(
  content: string,
  config: ExternalWikiRoot,
  limits: Pick<ExternalWikiCatalogLimits, "maxEntries"> = {}
): ExternalWikiCatalogEntry[] {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_CATALOG_ENTRIES;
  assertPositiveInteger(maxEntries, "maxEntries", MAX_CATALOG_ENTRIES);
  const entries: ExternalWikiCatalogEntry[] = [];
  const seenPaths = new Set<string>();

  for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
    const markdownMatch = /\[([^\]]+)]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(line);
    const wikiMatch = /\[\[([^\]|]+)(?:\|([^\]]+))?]]/.exec(line);
    let target: string;
    let title: string;
    let matchEnd: number;
    let pathBase: CatalogPathBase;
    if (markdownMatch) {
      title = markdownMatch[1]?.trim() ?? "";
      target = markdownMatch[2]?.trim() ?? "";
      matchEnd = (markdownMatch.index ?? 0) + markdownMatch[0].length;
      pathBase = "index";
    } else if (wikiMatch) {
      const wikiTarget = wikiMatch[1]?.trim() ?? "";
      title = wikiMatch[2]?.trim() || humanizePagePath(wikiTarget);
      target = wikiTarget.toLowerCase().endsWith(".md") ? wikiTarget : `${wikiTarget}.md`;
      matchEnd = (wikiMatch.index ?? 0) + wikiMatch[0].length;
      pathBase = "pages";
    } else {
      continue;
    }

    const pagePath = normalizeCatalogPath(target, config, pathBase);
    if (!pagePath || title.length === 0 || seenPaths.has(pagePath)) continue;
    if (entries.length >= maxEntries) {
      throw new Error(`catalog contains more than ${maxEntries} entries`);
    }
    seenPaths.add(pagePath);
    const indexBlurb = catalogBlurb(line, matchEnd);
    entries.push({
      title,
      path: pagePath,
      ...(indexBlurb === undefined ? {} : { indexBlurb }),
      indexLine: lineIndex + 1,
    });
  }
  return entries;
}

interface BoundedUtf8Read {
  content: string;
  bytes: number;
}

async function canonicalOpenedFile(handle: FileHandle, filePath: string, displayPath: string): Promise<string> {
  if (process.platform === "linux") {
    const descriptorPath = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
    if (descriptorPath !== undefined) return descriptorPath;
  }

  let canonical: string;
  try {
    canonical = await realpath(filePath);
  } catch {
    throw new Error(`${displayPath} changed while being opened`);
  }
  const [openedStat, pathStat] = await Promise.all([handle.stat(), stat(canonical)]);
  if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
    throw new Error(`${displayPath} changed while being opened`);
  }
  return canonical;
}

async function readBoundedUtf8(
  filePath: string,
  allowedRoot: string,
  maxBytes: number,
  displayPath: string
): Promise<BoundedUtf8Read> {
  assertPositiveInteger(maxBytes, "maxBytes", MAX_READ_BYTES);
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error(`${displayPath} is not a file`);
    const canonical = await canonicalOpenedFile(handle, filePath, displayPath);
    if (!isInside(allowedRoot, canonical)) {
      throw new Error(`${displayPath} escapes configured root`);
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error(`${displayPath} exceeds ${maxBytes} bytes`);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new Error(`${displayPath} is not valid UTF-8`);
    }
    return { content, bytes: bytesRead };
  } finally {
    await handle.close();
  }
}

function humanizePagePath(pagePath: string): string {
  const stem = path.posix.basename(pagePath, path.posix.extname(pagePath));
  const words = stem.replace(/[-_]+/g, " ").trim();
  return words.length === 0 ? stem : `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

async function listMarkdownPages(
  pagesDir: string,
  maxEntries: number,
  maxDepth: number
): Promise<ExternalWikiCatalogEntry[]> {
  assertPositiveInteger(maxEntries, "maxEntries", MAX_CATALOG_ENTRIES);
  assertPositiveInteger(maxDepth, "maxDepth", MAX_DIRECTORY_DEPTH);
  const paths: string[] = [];
  const maxVisitedEntries = Math.min(MAX_VISITED_ENTRIES, Math.max(MIN_VISITED_ENTRIES, maxEntries * 100));
  let visitedEntries = 0;
  const walk = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > maxDepth) throw new Error(`pages directory exceeds maxDepth ${maxDepth}`);
    const dir = await opendir(directory);
    for await (const entry of dir) {
      visitedEntries += 1;
      if (visitedEntries > maxVisitedEntries) {
        throw new Error(`pages directory contains more than ${maxVisitedEntries} filesystem entries`);
      }
      const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relativePath, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        if (paths.length >= maxEntries) {
          throw new Error(`pages directory contains more than ${maxEntries} markdown files`);
        }
        paths.push(relativePath);
      }
    }
  };
  await walk(pagesDir, "", 1);
  return paths
    .sort((left, right) => left.localeCompare(right))
    .map((pagePath) => ({
      title: humanizePagePath(pagePath),
      path: pagePath,
    }));
}

function assertWikiEnabled(config: ExternalWikiRoot): void {
  if (!config.enabled) throw new Error(`external wiki "${config.id}" is disabled`);
}

export async function loadExternalWikiCatalog(
  config: ExternalWikiRoot,
  limits: ExternalWikiCatalogLimits = {}
): Promise<ExternalWikiCatalog> {
  assertWikiEnabled(config);
  const maxIndexBytes = limits.maxIndexBytes ?? DEFAULT_MAX_INDEX_BYTES;
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_CATALOG_ENTRIES;
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DIRECTORY_DEPTH;
  assertPositiveInteger(maxEntries, "maxEntries", MAX_CATALOG_ENTRIES);
  assertPositiveInteger(maxDepth, "maxDepth", MAX_DIRECTORY_DEPTH);
  const layout = await validateExternalWikiLayout(config);
  const entries = layout.indexPresent
    ? parseExternalWikiCatalog(
        (await readBoundedUtf8(layout.indexFile, layout.rootDir, maxIndexBytes, config.indexFile)).content,
        config,
        { maxEntries }
      )
    : await listMarkdownPages(layout.pagesDir, maxEntries, maxDepth);
  return { wikiId: config.id, indexPresent: layout.indexPresent, entries };
}

function normalizePagePath(relativePath: string): string {
  if (relativePath.includes("\\")) {
    throw new Error("page path must use POSIX separators");
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error("page path must stay within the pages directory");
  }
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error("page path must end in .md");
  }
  return normalized;
}

function pageTitle(content: string, pagePath: string): string {
  const heading = /^#\s+(.+?)\s*$/m.exec(content)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : humanizePagePath(pagePath);
}

export async function readExternalWikiPage(
  config: ExternalWikiRoot,
  relativePath: string,
  maxBytes = DEFAULT_MAX_PAGE_BYTES
): Promise<ExternalWikiPage> {
  assertWikiEnabled(config);
  const pagePath = normalizePagePath(relativePath);
  const layout = await validateExternalWikiLayout(config);
  const candidate = resolveInside(layout.pagesDir, pagePath, "page path");
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`external wiki page does not exist: ${pagePath}`);
    }
    throw error;
  }
  if (!isInside(layout.pagesDir, canonical)) {
    throw new Error("page path must stay within the pages directory");
  }
  if (!(await stat(canonical)).isFile()) throw new Error(`external wiki page is not a file: ${pagePath}`);
  const page = await readBoundedUtf8(canonical, layout.pagesDir, maxBytes, pagePath);
  return {
    wikiId: config.id,
    path: pagePath,
    title: pageTitle(page.content, pagePath),
    content: page.content,
    bytes: page.bytes,
  };
}
