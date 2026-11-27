import { statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  realpathSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { log } from "../logger.js";
import { isErrnoCode } from "../utils/errno.js";
import { RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";
import { withEntityCanonicalMutationLock } from "./entity-canonical-id-lock.js";
import { assertSafeEntityId } from "./entity-id-safety.js";
import { normalizeSupersessionKey } from "../temporal-supersession.js";

export const ENTITY_CANONICAL_ID_MIGRATION_FILE = "entity-canonical-id-migration-v1.json";

function parseJournalMappings(raw: string): Readonly<Record<string, string>> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("mappings" in parsed)) return {};
  const mappings = parsed.mappings;
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) return {};
  const cleaned: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [legacyId, canonicalId] of Object.entries(mappings)) {
    if (legacyId.length > 0 && typeof canonicalId === "string" && canonicalId.length > 0) {
      assertSafeEntityId(legacyId);
      assertSafeEntityId(canonicalId);
      cleaned[legacyId] = canonicalId;
    }
  }
  return cleaned;
}

function parseJournalComplete(raw: string): boolean {
  // SAFETY: JSON.parse output is unknown; the shape is validated on access.
  const parsed = JSON.parse(raw) as { complete?: unknown };
  return parsed !== null && parsed.complete === true;
}

type JournalRead =
  | { kind: "ok"; raw: string; key: string }
  | { kind: "missing" }
  | { kind: "refused" }
  | { kind: "error" };

function readJournalFileNoFollow(statePath: string): JournalRead {
  let fd: number;
  try {
    fd = openSync(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return { kind: "missing" };
    if (isErrnoCode(error, "ELOOP")) return { kind: "refused" };
    return { kind: "error" };
  }
  try {
    const s = fstatSync(fd);
    if (!s.isFile()) return { kind: "refused" };
    const parent = lstatSync(path.dirname(statePath));
    if (parent.isSymbolicLink() || !parent.isDirectory()) return { kind: "refused" };
    const l = lstatSync(statePath);
    if (l.isSymbolicLink() || l.dev !== s.dev || l.ino !== s.ino) return { kind: "refused" };
    return {
      kind: "ok",
      raw: readFileSync(fd, "utf-8"),
      key: `${s.dev}:${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`,
    };
  } catch {
    return { kind: "error" };
  } finally {
    closeSync(fd);
  }
}

/** The journal fields completion attestation needs; extra journal fields are ignored. */
const CompletedJournalAttestationSchema = z.object({
  version: z.literal(1),
  complete: z.literal(true),
  completionFingerprint: z.string(),
});

/** Skip compatibility scans only when journal completion attests to the live inputs. */
export async function entityCanonicalIdMigrationCompleted(
  stateDir: string,
  readFingerprint: () => Promise<string>,
): Promise<boolean> {
  const result = readJournalFileNoFollow(path.join(stateDir, ENTITY_CANONICAL_ID_MIGRATION_FILE));
  if (result.kind !== "ok") return false;
  try {
    const parsed = CompletedJournalAttestationSchema.safeParse(JSON.parse(result.raw));
    if (!parsed.success) return false;
    return parsed.data.completionFingerprint === await readFingerprint();
  } catch {
    return false;
  }
}

export function loadHistoricalEntityCanonicalIds(stateDir: string): Readonly<Record<string, string>> {
  const result = readJournalFileNoFollow(path.join(stateDir, ENTITY_CANONICAL_ID_MIGRATION_FILE));
  if (result.kind !== "ok") return {};
  try {
    return parseJournalMappings(result.raw);
  } catch {
    return {};
  }
}

export async function appendCanonicalizedTombstone(
  stateDir: string,
  input: { entityRef?: string; supersessionKey?: string },
  currentIds: () => Readonly<Record<string, string>>,
  append: (identity: TombstoneIdentity) => Promise<string | null>,
  revoke: (tombstoneId: string) => Promise<unknown>,
  label: string,
): Promise<string | null> {
  let refIds = currentIds();
  let identity = canonicalizeTombstoneIdentity(input.entityRef, input.supersessionKey, refIds);
  let result = await append(identity);
  const replaceIfChanged = async (next: TombstoneIdentity): Promise<boolean> => {
    if (next.entityRef === identity.entityRef && next.supersessionKey === identity.supersessionKey) {
      return false;
    }
    identity = next;
    const superseded = result;
    result = await append(next);
    if (superseded !== null) {
      try {
        await revoke(superseded);
      } catch (err) {
        log.warn(`failed to revoke superseded tombstone ${superseded} for ${label}: ${err}`);
      }
    }
    return true;
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = currentIds();
    if (fresh === refIds) return result;
    refIds = fresh;
    if (!(await replaceIfChanged(canonicalizeTombstoneIdentity(input.entityRef, input.supersessionKey, fresh)))) {
      return result;
    }
  }
  await withEntityCanonicalMutationLock(stateDir, async () => {
    await replaceIfChanged(canonicalizeTombstoneIdentity(input.entityRef, input.supersessionKey, currentIds()));
  });
  return result;
}


/** Journal lookup result: mapping table plus its completion flag. */
export type HistoricalEntityIdsEntry = {
  mappings: Readonly<Record<string, string>>;
  complete: boolean;
};



export function memoizedJournalCompletion(
  cache: HistoricalEntityCanonicalIdCache,
  stateDir: () => string,
): () => boolean {
  let memo: { key: string; complete: boolean } | undefined;
  return (): boolean => {
    let key = "missing";
    try {
      const journalPath = path.join(stateDir(), ENTITY_CANONICAL_ID_MIGRATION_FILE);
      const j = statSync(journalPath);
      key = `${j.dev}:${j.ino}:${j.mtimeMs}:${j.ctimeMs}:${j.size}`;
    } catch {
      key = "missing";
    }
    if (memo && memo.key === key) return memo.complete;
    const entry = cache.getEntry(stateDir());
    memo = { key, complete: entry.complete };
    return memo.complete;
  };
}

export class HistoricalEntityCanonicalIdCache {
  private mappings: Readonly<Record<string, string>> = {};
  private complete = false;
  private key: string | null = null;
  private stateDir: string | null = null;

  get(stateDir: string): Readonly<Record<string, string>> {
    return this.getEntry(stateDir).mappings;
  }


  /** Table plus the journal's completion flag, cached under one identity. */
  getEntry(stateDir: string): HistoricalEntityIdsEntry {
    const lastKnownMappings = this.stateDir === stateDir ? this.mappings : {};
    const lastKnownComplete = this.stateDir === stateDir ? this.complete : false;
    const lastKnown: HistoricalEntityIdsEntry = { mappings: lastKnownMappings, complete: lastKnownComplete };
    const result = readJournalFileNoFollow(path.join(stateDir, ENTITY_CANONICAL_ID_MIGRATION_FILE));
    if (result.kind === "refused") {
      log.warn("ignoring non-regular entity canonical-id journal (symlink refused)");
      return lastKnown;
    }
    if (result.kind === "error") {
      return lastKnown;
    }
    const key = result.kind === "missing" ? "missing" : result.key;
    if (key !== this.key || stateDir !== this.stateDir) {
      let table: Readonly<Record<string, string>> = {};
      let complete = false;
      if (result.kind === "ok") {
        try {
          table = parseJournalMappings(result.raw);
          complete = parseJournalComplete(result.raw);
        } catch {
          return lastKnown;
        }
      }
      this.mappings = table;
      this.complete = complete;
      this.key = key;
      this.stateDir = stateDir;
    }
    return { mappings: this.mappings, complete: this.complete };
  }
}

export function resolveHistoricalEntityCanonicalId(
  normalized: string,
  mappings: Readonly<Record<string, string>>,
): string {
  let current = normalized;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = Object.hasOwn(mappings, current) ? mappings[current] : undefined;
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

export function canonicalizeEntityRefOption<T extends { entityRef?: string }>(
  options: T,
  mappings: Readonly<Record<string, string>>,
): T {
  if (typeof options.entityRef !== "string") return options;
  return { ...options, entityRef: resolveHistoricalEntityCanonicalId(options.entityRef, mappings) };
}

export function canonicalizeEntityRefFrontmatter(
  content: string,
  mappings: Readonly<Record<string, string>>,
): string {
  if (Object.keys(mappings).length === 0) return content;
  const loc = locateEntityRefLine(content);
  if (loc === null) return content;
  const canonical = resolveHistoricalEntityCanonicalId(loc.value, mappings);
  if (canonical === loc.value) return content;
  const line = loc.lines[loc.index]!;
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  loc.lines[loc.index] = `${indent}entityRef: ${canonical}${line.endsWith("\r") ? "\r" : ""}`;
  return loc.lines.join("\n") + content.slice(loc.closeIndex);
}

/** The raw `entityRef` value in a record's leading frontmatter, or null. */
export function readEntityRefFromFrontmatter(content: string): string | null {
  return locateEntityRefLine(content)?.value ?? null;
}

function locateEntityRefLine(
  content: string,
): { lines: string[]; index: number; value: string; closeIndex: number } | null {
  if (!/^---\r?\n/.test(content)) return null;
  const close = /\r?\n---(?:\r?\n|$)/g;
  close.lastIndex = content.indexOf("\n") + 1;
  const closeMatch = close.exec(content);
  if (!closeMatch) return null;
  const lines = content.slice(0, closeMatch.index).split("\n");
  let index = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^\s*entityRef\s*:/.test(lines[i] ?? "")) index = i;
  }
  if (index === -1) return null;
  const line = lines[index]!;
  const value = line.slice(line.indexOf(":") + 1).replace(/\r$/, "").trim();
  if (value.length === 0) return null;
  return { lines, index, value, closeIndex: closeMatch.index };
}

export const ENTITY_CANONICAL_ID_RECONCILE_MARKER = "entity-canonical-id-reconcile.pending";
/** The generation a migration run renamed aside for consumption; a crash can strand it. */
export const ENTITY_CANONICAL_ID_RECONCILE_CONSUMING_MARKER = `${ENTITY_CANONICAL_ID_RECONCILE_MARKER}.consuming`;

export function requestEntityCanonicalIdReconcileSync(stateDir: string): void {
  const markerPath = path.join(stateDir, ENTITY_CANONICAL_ID_RECONCILE_MARKER);
  const temporary = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const parent = lstatSync(stateDir);
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      log.warn(`refusing to write entity canonical-id reconcile marker: ${stateDir} is not a real directory`);
      return;
    }
    const parentRealPath = realpathSync(stateDir);
    writeFileSync(temporary, `${new Date().toISOString()}\n`, { mode: 0o600 });
    const recheck = lstatSync(stateDir);
    if (recheck.isSymbolicLink() || !recheck.isDirectory() || realpathSync(stateDir) !== parentRealPath) {
      rmSync(temporary, { force: true });
      log.warn(`refusing to publish entity canonical-id reconcile marker: ${stateDir} changed during write`);
      return;
    }
    renameSync(temporary, markerPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    log.warn(`could not request entity canonical-id reconcile: ${error}`);
  }
}

export async function requestEntityCanonicalIdReconcile(stateDir: string): Promise<void> {
  requestEntityCanonicalIdReconcileSync(stateDir);
}

export function reconcileIfJournalMovedSync(
  stateDir: string,
  idsAtResolve: Readonly<Record<string, string>>,
  idsAfterWrite: Readonly<Record<string, string>>,
): void {
  if (idsAtResolve === idsAfterWrite) return;
  requestEntityCanonicalIdReconcileSync(stateDir);
}

export async function reconcileIfJournalMoved(
  stateDir: string,
  idsAtResolve: Readonly<Record<string, string>>,
  idsAfterWrite: Readonly<Record<string, string>>,
): Promise<void> {
  reconcileIfJournalMovedSync(stateDir, idsAtResolve, idsAfterWrite);
}

export type EntityRefWritePathKind = "memory" | "entity" | "outside";

export function classifyEntityRefWritePath(baseDir: string, filePath: string): EntityRefWritePathKind {
  if (!filePath.endsWith(".md")) return "outside";
  const rel = path.relative(baseDir, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return "outside";
  const top = rel.split(path.sep)[0] ?? "";
  if (top === "entities") return "entity";
  return RECALL_FALLBACK_DIRS.includes(top) || top === "cold" || top === "archive" ? "memory" : "outside";
}

/** True when `filePath` is in the migration's scan scope at all. */
export function pathMayCarryEntityRefs(baseDir: string, filePath: string): boolean {
  return classifyEntityRefWritePath(baseDir, filePath) !== "outside";
}

export interface TombstoneIdentity {
  entityRef: string | undefined;
  supersessionKey: string | undefined;
}

export function canonicalizeTombstoneIdentity(
  entityRef: string | undefined,
  supersessionKey: string | undefined,
  refIds: Readonly<Record<string, string>>,
): TombstoneIdentity {
  if (typeof entityRef !== "string") return { entityRef, supersessionKey };
  const canonical = resolveHistoricalEntityCanonicalId(entityRef, refIds);
  if (canonical === entityRef) return { entityRef, supersessionKey };
  if (supersessionKey) {
    const stalePrefix = `${normalizeSupersessionKey(entityRef)}::`;
    if (supersessionKey.startsWith(stalePrefix)) {
      supersessionKey = `${normalizeSupersessionKey(canonical)}::${supersessionKey.slice(stalePrefix.length)}`;
    }
  }
  return { entityRef: canonical, supersessionKey };
}

export async function repairEntityRefAfterJournalMove(options: {
  stateDir: string;
  currentIds: () => Readonly<Record<string, string>>;
  idsAtResolve: Readonly<Record<string, string>>;
  rawRef: string;
  frontmatter: { entityRef?: string };
  rewrite: () => Promise<void>;
}): Promise<void> {
  let refIds = options.idsAtResolve;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = options.currentIds();
    if (fresh === refIds) return;
    refIds = fresh;
    const desired = resolveHistoricalEntityCanonicalId(options.rawRef, fresh);
    if (desired === options.frontmatter.entityRef) return;
    options.frontmatter.entityRef = desired;
    await options.rewrite();
  }
  await withEntityCanonicalMutationLock(options.stateDir, async () => {
    const desired = resolveHistoricalEntityCanonicalId(options.rawRef, options.currentIds());
    if (desired !== options.frontmatter.entityRef) {
      options.frontmatter.entityRef = desired;
      await options.rewrite();
    }
  });
  await requestEntityCanonicalIdReconcile(options.stateDir);
}

/**
 * Content-form counterpart of {@link repairEntityRefAfterJournalMove} for
 * async writers that persist raw record bytes (capsule import/merge,
 * binary-lifecycle redirects): same bounded loop, same locked settle.
 */
export async function repairContentAfterJournalMove(options: {
  stateDir: string;
  cache: HistoricalEntityCanonicalIdCache;
  idsAtWrite: Readonly<Record<string, string>>;
  rawContent: string;
  lastWritten: string;
  rewrite: (content: string) => Promise<void>;
}): Promise<void> {
  let refIds = options.idsAtWrite;
  let written = options.lastWritten;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = options.cache.get(options.stateDir);
    if (fresh === refIds) return;
    refIds = fresh;
    const desired = canonicalizeEntityRefFrontmatter(options.rawContent, fresh);
    if (desired === written) return;
    written = desired;
    await options.rewrite(desired);
  }
  await withEntityCanonicalMutationLock(options.stateDir, async () => {
    const desired = canonicalizeEntityRefFrontmatter(options.rawContent, options.cache.get(options.stateDir));
    if (desired !== written) {
      written = desired;
      await options.rewrite(desired);
    }
  });
  await requestEntityCanonicalIdReconcile(options.stateDir);
}

export function repairContentAfterJournalMoveSync(options: {
  stateDir: string;
  cache: HistoricalEntityCanonicalIdCache;
  idsAtWrite: Readonly<Record<string, string>>;
  rawContent: string;
  lastWritten: string;
  rewrite: (content: string) => void;
}): void {
  let refIds = options.idsAtWrite;
  let written = options.lastWritten;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = options.cache.get(options.stateDir);
    if (fresh === refIds) return;
    refIds = fresh;
    const desired = canonicalizeEntityRefFrontmatter(options.rawContent, fresh);
    if (desired === written) return;
    written = desired;
    options.rewrite(desired);
  }
  requestEntityCanonicalIdReconcileSync(options.stateDir);
  throw new Error(
    "entity canonical-id journal kept changing during post-write repair; retry the write",
  );
}
