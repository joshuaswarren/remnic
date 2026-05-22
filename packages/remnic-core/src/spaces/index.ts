/**
 * @remnic/core — Spaces + Collaboration
 *
 * First-class memory spaces (personal, project, team) with merge/conflict
 * flows, promotion workflow, and audit trail.
 *
 * Each space is an isolated memory directory. Spaces can share memories
 * through push/pull and promotion workflows.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readEnvVar, resolveHomeDir } from "../runtime/env.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type SpaceKind = "personal" | "project" | "team";

export interface Space {
  /** Unique space ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Space type */
  kind: SpaceKind;
  /** Description */
  description?: string;
  /** Memory directory path (absolute) */
  memoryDir: string;
  /** Created at */
  createdAt: string;
  /** Updated at */
  updatedAt: string;
  /** Owner */
  owner?: string;
  /** Members (for team spaces) */
  members?: string[];
  /** Parent space (for promotion) */
  parentSpaceId?: string;
}

export interface SpaceManifest {
  /** Current active space ID */
  activeSpaceId: string;
  /** All spaces */
  spaces: Space[];
  /** Manifest version */
  version: number;
  /** Last updated */
  updatedAt?: string;
}

export interface SpaceSwitchResult {
  previousSpaceId: string;
  currentSpaceId: string;
  message: string;
}

export interface SpacePushResult {
  sourceSpaceId: string;
  targetSpaceId: string;
  memoriesPushed: number;
  conflicts: ConflictEntry[];
  durationMs: number;
}

export interface SpacePullResult {
  sourceSpaceId: string;
  targetSpaceId: string;
  memoriesPulled: number;
  conflicts: ConflictEntry[];
  durationMs: number;
}

export interface SpaceShareResult {
  spaceId: string;
  sharedWith: string[];
  message: string;
}

export interface SpacePromoteResult {
  sourceSpaceId: string;
  targetSpaceId: string;
  memoriesPromoted: number;
  conflicts: ConflictEntry[];
  durationMs: number;
}

export interface ConflictEntry {
  /** Memory ID */
  memoryId: string;
  /** Source file path */
  sourcePath: string;
  /** Target file path */
  targetPath: string;
  /** Conflict type */
  conflictType: "content_mismatch" | "metadata_mismatch" | "both";
  /** Source content hash */
  sourceHash: string;
  /** Target content hash */
  targetHash: string;
}

export interface MergeResult {
  merged: number;
  conflicts: ConflictEntry[];
  skipped: number;
  durationMs: number;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  sourceSpaceId: string;
  targetSpaceId?: string;
  actor?: string;
  details: string;
  memoryIds?: string[];
}

// ── Manifest management ─────────────────────────────────────────────────────

const MANIFEST_VERSION = 1;

function normalizeSpaceMemoryDir(memoryDir: string): string {
  return path.resolve(memoryDir);
}

export function getSpacesDir(baseDir?: string): string {
  const homeDir = baseDir ?? resolveHomeDir();
  return path.join(homeDir, ".config", "engram", "spaces");
}

export function getManifestPath(baseDir?: string): string {
  return path.join(getSpacesDir(baseDir), "manifest.json");
}

export function loadManifest(baseDir?: string, memoryDirOverride?: string): SpaceManifest {
  const manifestPath = getManifestPath(baseDir);

  if (!fs.existsSync(manifestPath)) {
    // Bootstrap with a personal space
    const personalSpace = createPersonalSpace(baseDir, memoryDirOverride);
    const manifest: SpaceManifest = {
      activeSpaceId: personalSpace.id,
      spaces: [personalSpace],
      version: MANIFEST_VERSION,
    };
    saveManifest(manifest, baseDir);
    return manifest;
  }

  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return raw as SpaceManifest;
}

export function saveManifest(manifest: SpaceManifest, baseDir?: string): void {
  const manifestPath = getManifestPath(baseDir);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

function createPersonalSpace(baseDir?: string, memoryDirOverride?: string): Space {
  const homeDir = baseDir ?? resolveHomeDir();
  // Priority: override > REMNIC_MEMORY_DIR > ENGRAM_MEMORY_DIR > existing standalone dir > existing OpenClaw dir > new standalone dir
  const standalonePath = path.join(homeDir, ".engram", "memory");
  const openclawPath = path.join(homeDir, ".openclaw", "workspace", "memory", "local");
  const memoryDir = memoryDirOverride
    ?? readEnvVar("REMNIC_MEMORY_DIR")
    ?? readEnvVar("ENGRAM_MEMORY_DIR")
    ?? (fs.existsSync(standalonePath) ? standalonePath
      : fs.existsSync(openclawPath) ? openclawPath
      : standalonePath);
  const normalizedMemoryDir = normalizeSpaceMemoryDir(memoryDir);
  const now = new Date().toISOString();

  return {
    id: "personal",
    name: "Personal",
    kind: "personal",
    description: "Default personal memory space",
    memoryDir: normalizedMemoryDir,
    createdAt: now,
    updatedAt: now,
    owner: readEnvVar("USER"),
  };
}

// ── Space CRUD ──────────────────────────────────────────────────────────────

export function listSpaces(baseDir?: string): Space[] {
  const manifest = loadManifest(baseDir);
  return manifest.spaces;
}

export function getActiveSpace(baseDir?: string): Space {
  const manifest = loadManifest(baseDir);
  const space = manifest.spaces.find((s) => s.id === manifest.activeSpaceId);
  if (!space) throw new Error(`Active space ${manifest.activeSpaceId} not found`);
  return space;
}

export function createSpace(options: {
  name: string;
  kind: SpaceKind;
  description?: string;
  memoryDir?: string;
  parentSpaceId?: string;
  baseDir?: string;
}): Space {
  const manifest = loadManifest(options.baseDir);
  const id = options.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");

  if (manifest.spaces.some((s) => s.id === id)) {
    throw new Error(`Space "${id}" already exists`);
  }

  // Validate parent space exists
  if (options.parentSpaceId && !manifest.spaces.some((s) => s.id === options.parentSpaceId)) {
    throw new Error(`Parent space "${options.parentSpaceId}" not found`);
  }

  const now = new Date().toISOString();
  const memoryDir = normalizeSpaceMemoryDir(
    options.memoryDir ?? path.join(
      getSpacesDir(options.baseDir),
      id,
      "memory",
    ),
  );

  const space: Space = {
    id,
    name: options.name,
    kind: options.kind,
    description: options.description,
    memoryDir,
    createdAt: now,
    updatedAt: now,
    owner: readEnvVar("USER"),
    parentSpaceId: options.parentSpaceId,
  };

  // Ensure memory directory exists
  fs.mkdirSync(memoryDir, { recursive: true });

  manifest.spaces.push(space);
  manifest.updatedAt = now;
  saveManifest(manifest, options.baseDir);

  // Audit
  appendAudit({
    action: "space.create",
    sourceSpaceId: id,
    details: `Created ${options.kind} space "${options.name}"`,
  }, options.baseDir);

  return space;
}

export function deleteSpace(spaceId: string, baseDir?: string): void {
  const manifest = loadManifest(baseDir);

  if (spaceId === "personal") {
    throw new Error("Cannot delete the personal space");
  }

  const idx = manifest.spaces.findIndex((s) => s.id === spaceId);
  if (idx === -1) throw new Error(`Space "${spaceId}" not found`);

  // If deleting active space, switch to personal
  if (manifest.activeSpaceId === spaceId) {
    manifest.activeSpaceId = "personal";
  }

  // Clear parentSpaceId references from children
  for (const space of manifest.spaces) {
    if (space.parentSpaceId === spaceId) {
      space.parentSpaceId = undefined;
    }
  }

  manifest.spaces.splice(idx, 1);
  saveManifest(manifest, baseDir);

  appendAudit({
    action: "space.delete",
    sourceSpaceId: spaceId,
    details: `Deleted space "${spaceId}"`,
  }, baseDir);
}

// ── Switch ───────────────────────────────────────────────────────────────────

export function switchSpace(spaceId: string, baseDir?: string): SpaceSwitchResult {
  const manifest = loadManifest(baseDir);
  const space = manifest.spaces.find((s) => s.id === spaceId);

  if (!space) throw new Error(`Space "${spaceId}" not found`);

  const previousId = manifest.activeSpaceId;
  manifest.activeSpaceId = spaceId;
  saveManifest(manifest, baseDir);

  appendAudit({
    action: "space.switch",
    sourceSpaceId: previousId,
    targetSpaceId: spaceId,
    details: `Switched from "${previousId}" to "${spaceId}"`,
  }, baseDir);

  return {
    previousSpaceId: previousId,
    currentSpaceId: spaceId,
    message: `Switched to "${space.name}"`,
  };
}

// ── Push / Pull ─────────────────────────────────────────────────────────────

export function pushToSpace(
  sourceSpaceId: string,
  targetSpaceId: string,
  options?: { memoryIds?: string[]; force?: boolean; baseDir?: string },
): SpacePushResult {
  const startTime = Date.now();
  const manifest = loadManifest(options?.baseDir);

  const source = manifest.spaces.find((s) => s.id === sourceSpaceId);
  const target = manifest.spaces.find((s) => s.id === targetSpaceId);

  if (!source) throw new Error(`Source space "${sourceSpaceId}" not found`);
  if (!target) throw new Error(`Target space "${targetSpaceId}" not found`);

  const result = copyMemories(source.memoryDir, target.memoryDir, {
    filterIds: options?.memoryIds,
    force: options?.force,
  });

  appendAudit({
    action: "space.push",
    sourceSpaceId,
    targetSpaceId,
    details: `Pushed ${result.merged} memories, ${result.conflicts.length} conflicts`,
  }, options?.baseDir);

  return {
    sourceSpaceId,
    targetSpaceId,
    memoriesPushed: result.merged,
    conflicts: result.conflicts,
    durationMs: Date.now() - startTime,
  };
}

export function pullFromSpace(
  sourceSpaceId: string,
  targetSpaceId: string,
  options?: { memoryIds?: string[]; force?: boolean; baseDir?: string },
): SpacePullResult {
  const startTime = Date.now();
  const manifest = loadManifest(options?.baseDir);

  const source = manifest.spaces.find((s) => s.id === sourceSpaceId);
  const target = manifest.spaces.find((s) => s.id === targetSpaceId);

  if (!source) throw new Error(`Source space "${sourceSpaceId}" not found`);
  if (!target) throw new Error(`Target space "${targetSpaceId}" not found`);

  const result = copyMemories(source.memoryDir, target.memoryDir, {
    filterIds: options?.memoryIds,
    force: options?.force,
  });

  appendAudit({
    action: "space.pull",
    sourceSpaceId,
    targetSpaceId,
    details: `Pulled ${result.merged} memories, ${result.conflicts.length} conflicts`,
  }, options?.baseDir);

  return {
    sourceSpaceId,
    targetSpaceId,
    memoriesPulled: result.merged,
    conflicts: result.conflicts,
    durationMs: Date.now() - startTime,
  };
}

// ── Share ────────────────────────────────────────────────────────────────────

export function shareSpace(
  spaceId: string,
  members: string[],
  baseDir?: string,
): SpaceShareResult {
  const manifest = loadManifest(baseDir);
  const space = manifest.spaces.find((s) => s.id === spaceId);

  if (!space) throw new Error(`Space "${spaceId}" not found`);
  if (space.kind === "personal") throw new Error("Cannot share personal space");

  space.members = [...new Set([...(space.members ?? []), ...members])];
  space.updatedAt = new Date().toISOString();
  saveManifest(manifest, baseDir);

  appendAudit({
    action: "space.share",
    sourceSpaceId: spaceId,
    details: `Shared with: ${members.join(", ")}`,
  }, baseDir);

  return {
    spaceId,
    sharedWith: members,
    message: `Shared "${space.name}" with ${members.length} member(s)`,
  };
}

// ── Promote ──────────────────────────────────────────────────────────────────

export function promoteSpace(
  sourceSpaceId: string,
  targetSpaceId: string,
  options?: { memoryIds?: string[]; force?: boolean; forceOverwrite?: boolean; baseDir?: string },
): SpacePromoteResult {
  const startTime = Date.now();
  const manifest = loadManifest(options?.baseDir);

  const source = manifest.spaces.find((s) => s.id === sourceSpaceId);
  const target = manifest.spaces.find((s) => s.id === targetSpaceId);

  if (!source) throw new Error(`Source space "${sourceSpaceId}" not found`);
  if (!target) throw new Error(`Target space "${targetSpaceId}" not found`);

  // Promotion requires parent-child relationship or explicit force
  if (source.parentSpaceId !== targetSpaceId && target.parentSpaceId !== sourceSpaceId) {
    if (!options?.force) {
      throw new Error("Spaces must have a parent-child relationship for promotion. Use --force to override.");
    }
  }

  const result = copyMemories(source.memoryDir, target.memoryDir, {
    filterIds: options?.memoryIds,
    force: options?.forceOverwrite !== undefined ? options.forceOverwrite : (options?.force ?? false),
  });

  appendAudit({
    action: "space.promote",
    sourceSpaceId,
    targetSpaceId,
    details: `Promoted ${result.merged} memories from "${source.name}" to "${target.name}"`,
  }, options?.baseDir);

  return {
    sourceSpaceId,
    targetSpaceId,
    memoriesPromoted: result.merged,
    conflicts: result.conflicts,
    durationMs: Date.now() - startTime,
  };
}

// ── Merge ────────────────────────────────────────────────────────────────────

export function mergeSpaces(
  sourceSpaceId: string,
  targetSpaceId: string,
  options?: { force?: boolean; baseDir?: string },
): MergeResult {
  const startTime = Date.now();
  const manifest = loadManifest(options?.baseDir);

  const source = manifest.spaces.find((s) => s.id === sourceSpaceId);
  const target = manifest.spaces.find((s) => s.id === targetSpaceId);

  if (!source) throw new Error(`Source space "${sourceSpaceId}" not found`);
  if (!target) throw new Error(`Target space "${targetSpaceId}" not found`);

  const result = copyMemories(source.memoryDir, target.memoryDir, {
    force: options?.force,
  });

  appendAudit({
    action: "space.merge",
    sourceSpaceId,
    targetSpaceId,
    details: `Merged: ${result.merged} merged, ${result.conflicts.length} conflicts, ${result.skipped} skipped`,
  }, options?.baseDir);

  return {
    ...result,
    durationMs: Date.now() - startTime,
  };
}

// ── Audit trail ─────────────────────────────────────────────────────────────

export function getAuditLog(baseDir?: string): AuditEntry[] {
  const auditPath = path.join(getSpacesDir(baseDir), "audit.jsonl");
  if (!fs.existsSync(auditPath)) return [];

  const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
  return lines
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditEntry);
}

function appendAudit(entry: Omit<AuditEntry, "id" | "timestamp">, baseDir?: string): void {
  const auditPath = path.join(getSpacesDir(baseDir), "audit.jsonl");
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });

  const full: AuditEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  };

  fs.appendFileSync(auditPath, JSON.stringify(full) + "\n");
}

// ── Internal helpers ─────────────────────────────────────────────────────────

interface CopyOptions {
  filterIds?: string[];
  force?: boolean;
}

function copyMemories(
  sourceDir: string,
  targetDir: string,
  options?: CopyOptions,
): { merged: number; conflicts: ConflictEntry[]; skipped: number } {
  let merged = 0;
  const conflicts: ConflictEntry[] = [];
  let skipped = 0;

  if (!fs.existsSync(sourceDir)) {
    return { merged: 0, conflicts: [], skipped: 0 };
  }

  const sourceRoot = fs.realpathSync(sourceDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const targetRoot = fs.realpathSync(targetDir);

  const sourceFiles = walkMd(sourceRoot);
  for (const sourcePath of sourceFiles) {
    const sourceRealPath = safeRealpath(sourcePath);
    if (!sourceRealPath || !isPathInsideRoot(sourceRealPath, sourceRoot)) {
      skipped++;
      continue;
    }
    const sourceStat = safeLstat(sourcePath);
    if (!sourceStat?.isFile()) {
      skipped++;
      continue;
    }
    const content = fs.readFileSync(sourcePath, "utf8");
    const relativePath = path.relative(sourceRoot, sourceRealPath);
    const targetPath = path.resolve(targetRoot, relativePath);
    if (!isPathInsideRoot(targetPath, targetRoot)) {
      skipped++;
      continue;
    }

    const sourceHash = hashContent(content);

    // Filter by IDs if specified
    if (options?.filterIds?.length) {
      const fm = parseSimpleFrontmatter(content);
      if (!fm?.id || !options.filterIds.includes(fm.id)) {
        skipped++;
        continue;
      }
    }

    // Check for conflict
    if (fs.existsSync(targetPath)) {
      const targetStat = safeLstat(targetPath);
      if (!targetStat?.isFile() || targetStat.isSymbolicLink()) {
        skipped++;
        continue;
      }
      const targetRealPath = safeRealpath(targetPath);
      if (!targetRealPath || !isPathInsideRoot(targetRealPath, targetRoot)) {
        skipped++;
        continue;
      }
    }

    if (fs.existsSync(targetPath) && !options?.force) {
      const targetContent = fs.readFileSync(targetPath, "utf8");
      const targetHash = hashContent(targetContent);

      if (sourceHash !== targetHash) {
        conflicts.push({
          memoryId: parseSimpleFrontmatter(content)?.id ?? relativePath,
          sourcePath,
          targetPath,
          conflictType: "content_mismatch",
          sourceHash,
          targetHash,
        });
        continue;
      }

      // Same content — skip
      skipped++;
      continue;
    }

    // Copy file
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const targetParentRealPath = safeRealpath(path.dirname(targetPath));
    if (!targetParentRealPath || !isPathInsideRoot(targetParentRealPath, targetRoot)) {
      skipped++;
      continue;
    }
    fs.writeFileSync(targetPath, content);
    merged++;
  }

  return { merged, conflicts, skipped };
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function walkMd(dir: string): string[] {
  const results: string[] = [];

  function walk(d: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fullPath = path.join(d, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

function safeLstat(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

function safeRealpath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface SimpleFrontmatter {
  id?: string;
  [key: string]: string | undefined;
}

function parseSimpleFrontmatter(content: string): SimpleFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm: SimpleFrontmatter = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fm[key] = value;
  }
  return fm;
}
