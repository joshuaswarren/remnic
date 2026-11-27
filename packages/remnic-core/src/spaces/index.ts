/**
 * @remnic/core — Spaces + Collaboration
 *
 * First-class memory spaces (personal, project, team) with merge/conflict
 * flows, promotion workflow, and audit trail.
 *
 * Each space is an isolated memory directory. Spaces can share memories
 * through push/pull and promotion workflows.
 */

import { evaluateSubjectGuard } from "../memory-subject.js";
import type { SubjectGuardMode } from "../types.js";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readEnvVar, resolveHomeDir } from "../runtime/env.js";
import { bumpMemoryCorpusVersionForDir } from "../memory-corpus-version.js";
import {
  HistoricalEntityCanonicalIdCache,
  canonicalizeEntityRefFrontmatter,
  classifyEntityRefWritePath,
  readEntityRefFromFrontmatter,
  repairContentAfterJournalMoveSync,
  requestEntityCanonicalIdReconcileSync,
} from "../storage/entity-canonical-id-references.js";
import { withRawEntityPageMutation } from "../storage/entity-canonical-id-lock.js";

const historicalIdCache = new HistoricalEntityCanonicalIdCache();


export type SpaceKind = "personal" | "project" | "team";

export interface Space {
  id: string;
  name: string;
  kind: SpaceKind;
  description?: string;
  /** Memory directory path (absolute) */
  memoryDir: string;
  createdAt: string;
  updatedAt: string;
  owner?: string;
  members?: string[];
  parentSpaceId?: string;
}

export interface SpaceManifest {
  activeSpaceId: string;
  spaces: Space[];
  version: number;
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
  /** Subject-guard warnings (issue #2372): user-subject memories promoted to a shared team space under "warn". */
  subjectWarnings?: string[];
}

export interface ConflictEntry {
  memoryId: string;
  sourcePath: string;
  targetPath: string;
  conflictType: "content_mismatch" | "metadata_mismatch" | "both";
  sourceHash: string;
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


const MANIFEST_VERSION = 1;
const MANIFEST_LOCK_STALE_MS = 30_000;
const MANIFEST_LOCK_TIMEOUT_MS = MANIFEST_LOCK_STALE_MS + 10_000;
const MANIFEST_LOCK_SLEEP_MS = 20;

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
  if (fs.existsSync(getManifestPath(baseDir))) {
    try {
      return readManifestUnlocked(baseDir, memoryDirOverride, { bootstrapIfMissing: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return updateManifest(baseDir, (manifest) => manifest, memoryDirOverride);
}

export function saveManifest(manifest: SpaceManifest, baseDir?: string): void {
  withManifestLock(baseDir, () => {
    saveManifestUnlocked(manifest, baseDir);
  });
}

export function updateManifest<T>(
  baseDir: string | undefined,
  updater: (manifest: SpaceManifest) => T,
  memoryDirOverride?: string
): T {
  return withManifestLock(baseDir, () => {
    const manifest = readManifestUnlocked(baseDir, memoryDirOverride);
    const result = updater(manifest);
    saveManifestUnlocked(manifest, baseDir);
    return result;
  });
}

function readManifestUnlocked(
  baseDir?: string,
  memoryDirOverride?: string,
  options: { bootstrapIfMissing?: boolean } = {}
): SpaceManifest {
  const manifestPath = getManifestPath(baseDir);

  if (!fs.existsSync(manifestPath)) {
    if (options.bootstrapIfMissing === false) {
      const error = new Error(`Spaces manifest not found: ${manifestPath}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    const personalSpace = createPersonalSpace(baseDir, memoryDirOverride);
    return {
      activeSpaceId: personalSpace.id,
      spaces: [personalSpace],
      version: MANIFEST_VERSION,
    };
  }

  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return raw as SpaceManifest;
}

function saveManifestUnlocked(manifest: SpaceManifest, baseDir?: string): void {
  const manifestPath = getManifestPath(baseDir);
  const manifestDir = path.dirname(manifestPath);
  fs.mkdirSync(manifestDir, { recursive: true });
  const tempPath = path.join(manifestDir, `.manifest.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(tempPath, manifestPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Ignore cleanup failures; surface the original write/rename error.
    }
    throw error;
  }
}

function withManifestLock<T>(baseDir: string | undefined, operation: () => T): T {
  const lockDir = `${getManifestPath(baseDir)}.lock`;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const lockOwner = acquireManifestLock(lockDir);
  try {
    return operation();
  } finally {
    releaseManifestLock(lockDir, lockOwner);
  }
}

function acquireManifestLock(lockDir: string): string {
  const deadline = Date.now() + MANIFEST_LOCK_TIMEOUT_MS;
  const owner = createManifestLockOwner();
  const reclaimDir = getManifestLockReclaimDir(lockDir);
  while (true) {
    if (fs.existsSync(reclaimDir)) {
      removeStaleManifestReclaimLock(reclaimDir);
    }
    if (fs.existsSync(reclaimDir)) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for spaces manifest reclaim lock: ${reclaimDir}`);
      }
      sleepSync(MANIFEST_LOCK_SLEEP_MS);
      continue;
    }

    try {
      fs.mkdirSync(lockDir, { recursive: false });
      try {
        fs.writeFileSync(path.join(lockDir, "owner"), `${owner}\n`, { flag: "wx" });
      } catch (error) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        throw error;
      }
      if (fs.existsSync(reclaimDir)) {
        releaseManifestLock(lockDir, owner);
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for spaces manifest reclaim lock: ${reclaimDir}`);
        }
        sleepSync(MANIFEST_LOCK_SLEEP_MS);
        continue;
      }
      return owner;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      removeStaleManifestLock(lockDir);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for spaces manifest lock: ${lockDir}`);
      }
      sleepSync(MANIFEST_LOCK_SLEEP_MS);
    }
  }
}

function releaseManifestLock(lockDir: string, owner: string): void {
  try {
    const ownerPath = path.join(lockDir, "owner");
    if (fs.readFileSync(ownerPath, "utf8").trim() === owner) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function removeStaleManifestLock(lockDir: string): void {
  const reclaimDir = getManifestLockReclaimDir(lockDir);
  const reclaimOwner = createManifestLockOwner();
  try {
    fs.mkdirSync(reclaimDir, { recursive: false });
    try {
      fs.writeFileSync(path.join(reclaimDir, "owner"), `${reclaimOwner}\n`, { flag: "wx" });
    } catch (error) {
      fs.rmSync(reclaimDir, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return;
    }
    throw error;
  }

  try {
    const snapshot = readManifestLockSnapshot(lockDir);
    if (!snapshot || Date.now() - snapshot.mtimeMs <= MANIFEST_LOCK_STALE_MS) {
      return;
    }

    if (isManifestLockOwnerActive(snapshot.owner)) {
      return;
    }

    const tombstoneDir = `${lockDir}.stale.${process.pid}.${crypto.randomUUID()}`;
    try {
      fs.renameSync(lockDir, tombstoneDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return;
    }
    fs.rmSync(tombstoneDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(reclaimDir, { recursive: true, force: true });
  }
}

function getManifestLockReclaimDir(lockDir: string): string {
  return `${lockDir}.reclaim`;
}

function createManifestLockOwner(): string {
  return JSON.stringify({
    pid: process.pid,
    startKey: readProcessStartKey(process.pid),
    token: crypto.randomUUID(),
  });
}

function removeStaleManifestReclaimLock(reclaimDir: string): void {
  const snapshot = readManifestLockSnapshot(reclaimDir);
  if (!snapshot || Date.now() - snapshot.mtimeMs <= MANIFEST_LOCK_STALE_MS) {
    return;
  }

  if (isManifestLockOwnerActive(snapshot.owner)) {
    return;
  }

  const tombstoneDir = `${reclaimDir}.stale.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(reclaimDir, tombstoneDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return;
  }
  fs.rmSync(tombstoneDir, { recursive: true, force: true });
}

function readManifestLockSnapshot(lockDir: string): { mtimeMs: number; owner?: string } | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  try {
    const owner = fs.readFileSync(path.join(lockDir, "owner"), "utf8").trim();
    return { mtimeMs: stat.mtimeMs, owner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { mtimeMs: stat.mtimeMs };
    }
    throw error;
  }
}

function isManifestLockOwnerActive(owner: string | undefined): boolean {
  if (!owner) {
    return false;
  }

  const parsed = parseManifestLockOwner(owner);
  if (!parsed) {
    return false;
  }

  const currentStartKey = readProcessStartKey(parsed.pid);
  if (currentStartKey && parsed.startKey) {
    return currentStartKey === parsed.startKey;
  }

  return isProcessAlive(parsed.pid);
}

function parseManifestLockOwner(owner: string): { pid: number; startKey?: string } | undefined {
  try {
    const parsed = JSON.parse(owner) as { pid?: unknown; startKey?: unknown };
    const pid = typeof parsed.pid === "number" ? parsed.pid : Number.NaN;
    if (Number.isInteger(pid) && pid > 0) {
      return {
        pid,
        startKey: typeof parsed.startKey === "string" && parsed.startKey.length > 0 ? parsed.startKey : undefined,
      };
    }
  } catch {
    // Fall through to legacy owner format.
  }

  const legacyPid = Number(owner.split(":", 1)[0]);
  return Number.isInteger(legacyPid) && legacyPid > 0 ? { pid: legacyPid } : undefined;
}

function readProcessStartKey(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }

  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }
  const startKey = result.stdout.trim().replace(/\s+/g, " ");
  return startKey.length > 0 ? startKey : undefined;
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function createPersonalSpace(baseDir?: string, memoryDirOverride?: string): Space {
  const homeDir = baseDir ?? resolveHomeDir();
  const standalonePath = path.join(homeDir, ".engram", "memory");
  const openclawPath = path.join(homeDir, ".openclaw", "workspace", "memory", "local");
  const memoryDir =
    memoryDirOverride ??
    readEnvVar("REMNIC_MEMORY_DIR") ??
    readEnvVar("ENGRAM_MEMORY_DIR") ??
    (fs.existsSync(standalonePath) ? standalonePath : fs.existsSync(openclawPath) ? openclawPath : standalonePath);
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
  const id = options.name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
  const now = new Date().toISOString();
  const memoryDir = normalizeSpaceMemoryDir(
    options.memoryDir ?? path.join(getSpacesDir(options.baseDir), id, "memory")
  );

  const space = updateManifest(options.baseDir, (manifest) => {
    if (manifest.spaces.some((s) => s.id === id)) {
      throw new Error(`Space "${id}" already exists`);
    }

    if (options.parentSpaceId && !manifest.spaces.some((s) => s.id === options.parentSpaceId)) {
      throw new Error(`Parent space "${options.parentSpaceId}" not found`);
    }

    const created: Space = {
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

    fs.mkdirSync(memoryDir, { recursive: true });

    manifest.spaces.push(created);
    manifest.updatedAt = now;
    return created;
  });

  appendAudit(
    {
      action: "space.create",
      sourceSpaceId: id,
      details: `Created ${options.kind} space "${options.name}"`,
    },
    options.baseDir
  );

  return space;
}

export function deleteSpace(spaceId: string, baseDir?: string): void {
  if (spaceId === "personal") {
    throw new Error("Cannot delete the personal space");
  }

  updateManifest(baseDir, (manifest) => {
    const idx = manifest.spaces.findIndex((s) => s.id === spaceId);
    if (idx === -1) throw new Error(`Space "${spaceId}" not found`);

    if (manifest.activeSpaceId === spaceId) {
      manifest.activeSpaceId = "personal";
    }

    for (const space of manifest.spaces) {
      if (space.parentSpaceId === spaceId) {
        space.parentSpaceId = undefined;
      }
    }

    manifest.spaces.splice(idx, 1);
  });

  appendAudit(
    {
      action: "space.delete",
      sourceSpaceId: spaceId,
      details: `Deleted space "${spaceId}"`,
    },
    baseDir
  );
}


export function switchSpace(spaceId: string, baseDir?: string): SpaceSwitchResult {
  const { previousId, spaceName } = updateManifest(baseDir, (manifest) => {
    const space = manifest.spaces.find((s) => s.id === spaceId);
    if (!space) throw new Error(`Space "${spaceId}" not found`);
    const previousId = manifest.activeSpaceId;
    manifest.activeSpaceId = spaceId;
    return { previousId, spaceName: space.name };
  });

  appendAudit(
    {
      action: "space.switch",
      sourceSpaceId: previousId,
      targetSpaceId: spaceId,
      details: `Switched from "${previousId}" to "${spaceId}"`,
    },
    baseDir
  );

  return {
    previousSpaceId: previousId,
    currentSpaceId: spaceId,
    message: `Switched to "${spaceName}"`,
  };
}


export async function pushToSpace(
  sourceSpaceId: string,
  targetSpaceId: string,
  options?: { memoryIds?: string[]; force?: boolean; baseDir?: string }
): Promise<SpacePushResult> {
  const startTime = Date.now();
  const manifest = loadManifest(options?.baseDir);

  const source = manifest.spaces.find((s) => s.id === sourceSpaceId);
  const target = manifest.spaces.find((s) => s.id === targetSpaceId);

  if (!source) throw new Error(`Source space "${sourceSpaceId}" not found`);
  if (!target) throw new Error(`Target space "${targetSpaceId}" not found`);

  const result = await copyMemories(source.memoryDir, target.memoryDir, {
    filterIds: options?.memoryIds,
    force: options?.force,
  });

  appendAudit(
    {
      action: "space.push",
      sourceSpaceId,
      targetSpaceId,
      details: `Pushed ${result.merged} memories, ${result.conflicts.length} conflicts`,
    },
    options?.baseDir
  );

  return {
    sourceSpaceId,
    targetSpaceId,
    memoriesPushed: result.merged,
    conflicts: result.conflicts,
    durationMs: Date.now() - startTime,
  };
}

export async function pullFromSpace(
  sourceSpaceId: string,
  targetSpaceId: string,
  options?: { memoryIds?: string[]; force?: boolean; baseDir?: string }
): Promise<SpacePullResult> {
  const startTime = Date.now();
  const manifest = loadManifest(options?.baseDir);

  const source = manifest.spaces.find((s) => s.id === sourceSpaceId);
  const target = manifest.spaces.find((s) => s.id === targetSpaceId);

  if (!source) throw new Error(`Source space "${sourceSpaceId}" not found`);
  if (!target) throw new Error(`Target space "${targetSpaceId}" not found`);

  const result = await copyMemories(source.memoryDir, target.memoryDir, {
    filterIds: options?.memoryIds,
    force: options?.force,
  });

  appendAudit(
    {
      action: "space.pull",
      sourceSpaceId,
      targetSpaceId,
      details: `Pulled ${result.merged} memories, ${result.conflicts.length} conflicts`,
    },
    options?.baseDir
  );

  return {
    sourceSpaceId,
    targetSpaceId,
    memoriesPulled: result.merged,
    conflicts: result.conflicts,
    durationMs: Date.now() - startTime,
  };
}


export function shareSpace(spaceId: string, members: string[], baseDir?: string): SpaceShareResult {
  const spaceName = updateManifest(baseDir, (manifest) => {
    const space = manifest.spaces.find((s) => s.id === spaceId);
    if (!space) throw new Error(`Space "${spaceId}" not found`);
    if (space.kind === "personal") throw new Error("Cannot share personal space");

    space.members = [...new Set([...(space.members ?? []), ...members])];
    space.updatedAt = new Date().toISOString();
    return space.name;
  });

  appendAudit(
    {
      action: "space.share",
      sourceSpaceId: spaceId,
      details: `Shared with: ${members.join(", ")}`,
    },
    baseDir
  );

  return {
    spaceId,
    sharedWith: members,
    message: `Shared "${spaceName}" with ${members.length} member(s)`,
  };
}


export async function promoteSpace(
  sourceSpaceId: string,
  targetSpaceId: string,
  options?: {
    memoryIds?: string[]; force?: boolean; forceOverwrite?: boolean; baseDir?: string;
    subjectGuard?: SubjectGuardMode; allowUserSubject?: boolean;
  }
): Promise<SpacePromoteResult> {
  const startTime = Date.now();
  const manifest = loadManifest(options?.baseDir);

  const source = manifest.spaces.find((s) => s.id === sourceSpaceId);
  const target = manifest.spaces.find((s) => s.id === targetSpaceId);

  if (!source) throw new Error(`Source space "${sourceSpaceId}" not found`);
  if (!target) throw new Error(`Target space "${targetSpaceId}" not found`);

  if (source.parentSpaceId !== targetSpaceId && target.parentSpaceId !== sourceSpaceId) {
    if (!options?.force) {
      throw new Error("Spaces must have a parent-child relationship for promotion. Use --force to override.");
    }
  }

  const subjectWarnings: string[] = [];
  const warnedMemoryIds: string[] = [];
  if (target.kind === "team") {
    const sourceFiles = fs.existsSync(source.memoryDir) ? walkMd(fs.realpathSync(source.memoryDir)) : [];
    for (const file of sourceFiles) {
      const fm = parseSimpleFrontmatter(fs.readFileSync(file, "utf8"));
      if (!fm?.id) continue;
      if (options?.memoryIds?.length && !options.memoryIds.includes(fm.id)) continue;
      const decision = evaluateSubjectGuard({
        subject: fm.subject === "user" || fm.subject === "agent" ? fm.subject : undefined,
        sharedTarget: true,
        mode: options?.subjectGuard ?? "warn",
        allowUserSubject: options?.allowUserSubject,
      });
      if (decision.action === "reject") {
        throw new Error(`space promote blocked by subject guard: memory ${fm.id} — ${decision.reason}`);
      }
      if (decision.action === "warn") {
        subjectWarnings.push(`memory ${fm.id}: ${decision.reason}`);
        warnedMemoryIds.push(fm.id);
      }
    }
  }

  const result = await copyMemories(source.memoryDir, target.memoryDir, {
    filterIds: options?.memoryIds,
    force: options?.forceOverwrite !== undefined ? options.forceOverwrite : (options?.force ?? false),
  });

  appendAudit(
    {
      action: "space.promote",
      sourceSpaceId,
      targetSpaceId,
      details: `Promoted ${result.merged} memories from "${source.name}" to "${target.name}"${subjectWarnings.length > 0 ? `; subject-guard warned ${subjectWarnings.length} user-subject memories (${warnedMemoryIds.join(", ")})` : ""}${options?.allowUserSubject === true ? "; user-subject override: --allow-user-subject" : ""}`,
      ...(warnedMemoryIds.length > 0 ? { memoryIds: warnedMemoryIds } : {}),
    },
    options?.baseDir
  );

  return {
    sourceSpaceId,
    targetSpaceId,
    memoriesPromoted: result.merged,
    conflicts: result.conflicts,
    durationMs: Date.now() - startTime,
    ...(subjectWarnings.length > 0 ? { subjectWarnings } : {}),
  };
}


export async function mergeSpaces(
  sourceSpaceId: string,
  targetSpaceId: string,
  options?: { force?: boolean; baseDir?: string }
): Promise<MergeResult> {
  const startTime = Date.now();
  const manifest = loadManifest(options?.baseDir);

  const source = manifest.spaces.find((s) => s.id === sourceSpaceId);
  const target = manifest.spaces.find((s) => s.id === targetSpaceId);

  if (!source) throw new Error(`Source space "${sourceSpaceId}" not found`);
  if (!target) throw new Error(`Target space "${targetSpaceId}" not found`);

  const result = await copyMemories(source.memoryDir, target.memoryDir, {
    force: options?.force,
  });

  appendAudit(
    {
      action: "space.merge",
      sourceSpaceId,
      targetSpaceId,
      details: `Merged: ${result.merged} merged, ${result.conflicts.length} conflicts, ${result.skipped} skipped`,
    },
    options?.baseDir
  );

  return {
    ...result,
    durationMs: Date.now() - startTime,
  };
}


export function getAuditLog(baseDir?: string): AuditEntry[] {
  const auditPath = path.join(getSpacesDir(baseDir), "audit.jsonl");
  if (!fs.existsSync(auditPath)) return [];

  const lines = fs.readFileSync(auditPath, "utf8").trim().split("\n");
  return lines.filter((l) => l.trim()).map((l) => JSON.parse(l) as AuditEntry);
}

function appendAudit(entry: Omit<AuditEntry, "id" | "timestamp">, baseDir?: string): void {
  const auditPath = path.join(getSpacesDir(baseDir), "audit.jsonl");
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });

  const full: AuditEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  };

  fs.appendFileSync(auditPath, `${JSON.stringify(full)}\n`);
}


interface CopyOptions {
  filterIds?: string[];
  force?: boolean;
}

type CopyResult = { merged: number; conflicts: ConflictEntry[]; skipped: number };

async function copyMemories(
  sourceDir: string,
  targetDir: string,
  options?: CopyOptions
): Promise<CopyResult> {
  if (!fs.existsSync(sourceDir)) {
    return { merged: 0, conflicts: [], skipped: 0 };
  }

  const sourceRoot = fs.realpathSync(sourceDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const targetRoot = fs.realpathSync(targetDir);

  const sourceFiles = walkMd(sourceRoot);
  const sourceEntityIds = new Set(
    sourceFiles
      .filter((p) => {
        const rp = safeRealpath(p);
        if (!rp || !isPathInsideRoot(rp, sourceRoot)) return false;
        const rel = path.relative(sourceRoot, rp);
        const mapped = path.resolve(targetRoot, rel);
        if (!isPathInsideRoot(mapped, targetRoot)) return false;
        return classifyEntityRefWritePath(targetRoot, mapped) === "entity";
      })
      .map((p) => path.basename(p, ".md")),
  );
  const firstEntityId = sourceEntityIds.values().next().value;
  if (firstEntityId === undefined) {
    return copyPreparedMemories(sourceFiles, sourceRoot, targetRoot, sourceEntityIds, options);
  }
  return withRawEntityPageMutation(
    targetRoot,
    path.join(targetRoot, "entities", `${firstEntityId}.md`),
    async () => copyPreparedMemories(
      sourceFiles,
      sourceRoot,
      targetRoot,
      sourceEntityIds,
      options,
    ),
  );
}

function copyPreparedMemories(
  sourceFiles: string[],
  sourceRoot: string,
  targetRoot: string,
  sourceEntityIds: ReadonlySet<string>,
  options?: CopyOptions,
): CopyResult {
  let merged = 0;
  const conflicts: ConflictEntry[] = [];
  let skipped = 0;
  let reconcileNeeded = false;
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

    const targetKind = classifyEntityRefWritePath(targetRoot, targetPath);
    const idsAtCompare = historicalIdCache.get(path.join(targetRoot, "state"));
    const sourceRef = targetKind === "memory" ? readEntityRefFromFrontmatter(content) : null;
    const refHasSourceClaimant = sourceRef !== null && sourceEntityIds.has(sourceRef);
    const canonicalContent =
      targetKind === "memory" && !refHasSourceClaimant
        ? canonicalizeEntityRefFrontmatter(content, idsAtCompare)
        : content;
    const sourceHash = hashContent(content);

    if (options?.filterIds?.length) {
      const fm = parseSimpleFrontmatter(content);
      if (!fm?.id || !options.filterIds.includes(fm.id)) {
        skipped++;
        continue;
      }
    }

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

      if (
        hashContent(canonicalContent) === targetHash
        && historicalIdCache.get(path.join(targetRoot, "state")) === idsAtCompare
      ) {
        skipped++;
        continue;
      }
      if (hashContent(canonicalContent) !== targetHash && sourceHash !== targetHash) {
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
      // Fall through and rewrite in place: the target matches the RAW source
      // while a mapping applies (a skip would leave the legacy entityRef on
      // disk forever), or it matched the canonical form under a journal that
      // moved mid-compare (the write path re-resolves and repairs) (#2213).
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const targetParentRealPath = safeRealpath(path.dirname(targetPath));
    if (!targetParentRealPath || !isPathInsideRoot(targetParentRealPath, targetRoot)) {
      skipped++;
      continue;
    }
    const stateDir = path.join(targetRoot, "state");
    if (targetKind === "memory" && !refHasSourceClaimant) {
      const idsAtWrite = historicalIdCache.get(stateDir);
      const written = canonicalizeEntityRefFrontmatter(content, idsAtWrite);
      let priorTarget: string | null = null;
      try {
        priorTarget = fs.readFileSync(targetPath, "utf8");
      } catch {
        priorTarget = null;
      }
      fs.writeFileSync(targetPath, written);
      try {
        repairContentAfterJournalMoveSync({
          stateDir,
          cache: historicalIdCache,
          idsAtWrite,
          rawContent: content,
          lastWritten: written,
          rewrite: (next) => fs.writeFileSync(targetPath, next),
        });
      } catch (err) {
        try {
          if (priorTarget === null) {
            fs.unlinkSync(targetPath);
          } else {
            fs.writeFileSync(targetPath, priorTarget);
          }
        } catch {
          // Best effort — the retryable repair error is the primary signal.
        }
        throw err;
      }
    } else if (targetKind === "memory") {
      fs.writeFileSync(targetPath, content);
      reconcileNeeded = true;
    } else {
      fs.writeFileSync(targetPath, content);
      if (targetKind === "entity") {
        reconcileNeeded = true;
      }
    }
    merged++;
    bumpMemoryCorpusVersionForDir(targetRoot);
  }

  if (reconcileNeeded) {
    requestEntityCanonicalIdReconcileSync(path.join(targetRoot, "state"));
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
