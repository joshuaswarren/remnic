import { createHash } from "node:crypto";
import { inferMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { ContentHashIndex, type ContentHashPathEntry } from "../storage/content-hash-index.js";
import type { MemoryFrontmatter, MemoryStatus } from "../types.js";
import { RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";
import {
  type ReconcileFileState,
  type ReconcilePlan,
  type ReconcilePlanEntry,
  type ReconcileSemanticAgreement,
  type ReconcileSemanticChange,
  summarizeReconcilePlan,
} from "./plan.js";

export const RECONCILE_MANIFEST_FORMAT = "remnic-reconcile-manifest";
export const RECONCILE_MANIFEST_SCHEMA_VERSION = 1;

export interface ReconcileMemoryIdentity {
  id: string;
  category: string;
  contentHash: string;
  status: MemoryStatus;
}

export interface ReconcileManifestFile extends ReconcileFileState {
  memory?: ReconcileMemoryIdentity;
}

type ActiveFactManifestFile = ReconcileManifestFile & { memory: ReconcileMemoryIdentity };

export interface ReconcileManifest {
  format: typeof RECONCILE_MANIFEST_FORMAT;
  schemaVersion: typeof RECONCILE_MANIFEST_SCHEMA_VERSION;
  files: ReconcileManifestFile[];
}

export type ReconcileMemoryParser = (
  raw: string,
) => { frontmatter: MemoryFrontmatter; content: string } | null;

export interface BuildReconcileManifestOptions {
  files: Iterable<ReconcileFileState>;
  readFile: (file: ReconcileFileState) => Promise<Buffer | string | null>;
  parseMemory: ReconcileMemoryParser;
  cachedFiles?: Iterable<ReconcileManifestFile>;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MEMORY_DIRS = new Set(RECALL_FALLBACK_DIRS);

function isMemoryPath(filePath: string): boolean {
  if (!filePath.endsWith(".md")) return false;
  const segments = filePath.split("/");
  let index = 0;
  if (segments[index] === "cold" || segments[index] === "archive") index += 1;
  return MEMORY_DIRS.has(segments[index] ?? "");
}


function parsedMemoryIdentity(
  filePath: string,
  raw: Buffer | string,
  parseMemory: ReconcileMemoryParser,
): ReconcileMemoryIdentity | undefined {
  if (!isMemoryPath(filePath)) return undefined;
  const parsed = parseMemory(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
  if (!parsed?.frontmatter.id) return undefined;
  const storedHash = parsed.frontmatter.contentHash;
  const contentHash =
    storedHash && SHA256_PATTERN.test(storedHash)
      ? storedHash.toLowerCase()
      : ContentHashIndex.computeHash(parsed.content);
  return {
    id: parsed.frontmatter.id,
    category: parsed.frontmatter.category,
    contentHash,
    status: inferMemoryStatus(parsed.frontmatter, filePath),
  };
}

export async function buildReconcileManifestFile(
  file: ReconcileFileState,
  readFile: (file: ReconcileFileState) => Promise<Buffer | string | null>,
  parseMemory: ReconcileMemoryParser,
): Promise<ReconcileManifestFile> {
  let raw: Buffer | string | null = null;
  if (isMemoryPath(file.path)) {
    try {
      raw = await readFile(file);
    } catch {
      raw = null;
    }
  }
  if (raw !== null && createHash("sha256").update(raw).digest("hex") !== file.sha256.toLowerCase()) {
    raw = null;
  }
  const memory = raw === null ? undefined : parsedMemoryIdentity(file.path, raw, parseMemory);
  return { ...file, ...(memory ? { memory } : {}) };
}

export async function buildReconcileManifest(options: BuildReconcileManifestOptions): Promise<ReconcileManifest> {
  const cachedByPath = new Map<string, ReconcileManifestFile>();
  for (const cached of options.cachedFiles ?? []) {
    cachedByPath.set(cached.path, cached);
  }

  const files: ReconcileManifestFile[] = [];
  for (const file of options.files) {
    const cached = cachedByPath.get(file.path);
    if (cached?.sha256.toLowerCase() === file.sha256.toLowerCase()) {
      files.push({ ...file, ...(cached.memory ? { memory: cached.memory } : {}) });
      continue;
    }

    files.push(await buildReconcileManifestFile(file, options.readFile, options.parseMemory));
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    format: RECONCILE_MANIFEST_FORMAT,
    schemaVersion: RECONCILE_MANIFEST_SCHEMA_VERSION,
    files,
  };
}

function activeFactByPath(manifest: ReconcileManifest | undefined): Map<string, ActiveFactManifestFile> {
  const result = new Map<string, ActiveFactManifestFile>();
  for (const file of manifest?.files ?? []) {
    if (file.memory?.category === "fact" && file.memory.status === "active") {
      result.set(file.path, file as ActiveFactManifestFile);
    }
  }
  return result;
}

function contentHashRows(files: Iterable<ActiveFactManifestFile>): ContentHashPathEntry[] {
  const rows: ContentHashPathEntry[] = [];
  for (const file of files) {
    rows.push({ path: file.path, contentHash: file.memory.contentHash });
  }
  return rows;
}

function comparePlanEntries(left: ReconcilePlanEntry, right: ReconcilePlanEntry): number {
  if (left.namespace !== right.namespace) return left.namespace < right.namespace ? -1 : 1;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function semanticAgreementKey(agreement: ReconcileSemanticAgreement): string {
  return `${agreement.local.path}\0${agreement.peer.path}`;
}

function classifySemanticChange(
  current: ReconcileSemanticAgreement,
  prior: ReconcileSemanticAgreement | undefined
): ReconcileSemanticChange {
  if (!prior) return "unchanged";
  const localChanged = current.local.sha256 !== prior.local.sha256;
  const peerChanged = current.peer.sha256 !== prior.peer.sha256;
  if (localChanged && peerChanged) return "both_modified";
  if (localChanged) return "local_changed";
  if (peerChanged) return "peer_changed";
  return "unchanged";
}

export function collapseActiveFactDuplicates(
  plan: ReconcilePlan,
  localManifests: ReadonlyMap<string, ReconcileManifest>,
  peerManifests: ReadonlyMap<string, ReconcileManifest>,
  priorSemanticAgreements?: ReadonlyMap<string, readonly ReconcileSemanticAgreement[]>,
): ReconcilePlan {
  const entriesByNamespace = new Map<string, ReconcilePlanEntry[]>();
  for (const entry of plan.entries) {
    const entries = entriesByNamespace.get(entry.namespace) ?? [];
    entries.push({ ...entry });
    entriesByNamespace.set(entry.namespace, entries);
  }

  let changed = false;
  for (const namespace of new Set([...localManifests.keys(), ...peerManifests.keys()])) {
    const entries = entriesByNamespace.get(namespace) ?? [];
    const localManifest = localManifests.get(namespace);
    const peerManifest = peerManifests.get(namespace);
    const localByPath = activeFactByPath(localManifest);
    const peerByPath = activeFactByPath(peerManifest);
    const localFilesByPath = new Map((localManifest?.files ?? []).map((file) => [file.path, file]));
    const peerFilesByPath = new Map((peerManifest?.files ?? []).map((file) => [file.path, file]));
    const priorSemanticByPathPair = new Map(
      (priorSemanticAgreements?.get(namespace) ?? []).map((agreement) => [
        semanticAgreementKey(agreement),
        agreement,
      ])
    );
    const localByHash = new Map<string, ActiveFactManifestFile[]>();
    const peerByHash = new Map<string, ActiveFactManifestFile[]>();

    for (const file of localByPath.values()) {
      const hash = file.memory.contentHash;
      const bucket = localByHash.get(hash) ?? [];
      bucket.push(file);
      localByHash.set(hash, bucket);
    }
    for (const file of peerByPath.values()) {
      const hash = file.memory.contentHash;
      const bucket = peerByHash.get(hash) ?? [];
      bucket.push(file);
      peerByHash.set(hash, bucket);
    }

    const removed = new Set<ReconcilePlanEntry>();
    const replacements: ReconcilePlanEntry[] = [];
    for (const hash of new Set([...localByHash.keys(), ...peerByHash.keys()])) {
      const localCandidates = (localByHash.get(hash) ?? []).filter((file) => {
        const opposite = peerFilesByPath.get(file.path);
        const activeOpposite = peerByPath.get(file.path);
        return opposite === undefined || activeOpposite?.memory.contentHash === hash;
      });
      const peerCandidates = (peerByHash.get(hash) ?? []).filter((file) => {
        const opposite = localFilesByPath.get(file.path);
        const activeOpposite = localByPath.get(file.path);
        return opposite === undefined || activeOpposite?.memory.contentHash === hash;
      });
      const localPath = ContentHashIndex.resolvePathByHash(hash, contentHashRows(localCandidates));
      const peerPath = ContentHashIndex.resolvePathByHash(hash, contentHashRows(peerCandidates));

      if (localPath && peerPath && localPath !== peerPath) {
        const localFile = localByPath.get(localPath);
        const peerFile = peerByPath.get(peerPath);
        if (!localFile || !peerFile) continue;
        const duplicatePaths = new Set([
          ...localCandidates.map((file) => file.path),
          ...peerCandidates.map((file) => file.path),
        ]);
        const authoritativeSamePathEntries = new Set(entries.filter(
          (entry) =>
            duplicatePaths.has(entry.path)
            && localFilesByPath.has(entry.path)
            && peerFilesByPath.has(entry.path)
            && entry.action !== "identical"
        ));
        if (authoritativeSamePathEntries.size > 0) {
          for (const entry of entries) {
            if (
              duplicatePaths.has(entry.path)
              && !authoritativeSamePathEntries.has(entry)
              && (entry.action === "pull" || entry.action === "push" || entry.action === "identical")
            ) {
              removed.add(entry);
              changed = true;
            }
          }
          continue;
        }
        const unsafeEntry = entries.some(
          (entry) => duplicatePaths.has(entry.path) && (entry.action === "suppress" || entry.action === "conflict")
        );
        if (unsafeEntry) continue;
        for (const entry of entries) {
          if (
            duplicatePaths.has(entry.path) &&
            (entry.action === "pull" || entry.action === "push" || entry.action === "identical")
          ) {
            removed.add(entry);
          }
        }
        const semanticAgreement: ReconcileSemanticAgreement = {
          local: { path: localPath, sha256: localFile.sha256 },
          peer: { path: peerPath, sha256: peerFile.sha256 },
        };
        replacements.push({
          path: localPath < peerPath ? localPath : peerPath,
          namespace,
          action: "identical",
          reason: "semantic_duplicate",
          semanticAgreement,
          semanticChange: classifySemanticChange(
            semanticAgreement,
            priorSemanticByPathPair.get(semanticAgreementKey(semanticAgreement))
          ),
        });
        changed = true;
        continue;
      }

      const sameSideEntries = entries.filter((entry) => {
        if (localPath && entry.reason === "local_only") {
          return localCandidates.some((file) => file.path === entry.path);
        }
        if (peerPath && entry.reason === "peer_only") {
          return peerCandidates.some((file) => file.path === entry.path);
        }
        return false;
      });
      const canonicalPath = localPath ?? peerPath;
      const hasSharedCanonical = localPath !== undefined && localPath === peerPath;
      if (!canonicalPath || sameSideEntries.length === 0 || (!hasSharedCanonical && sameSideEntries.length < 2)) {
        continue;
      }
      for (const entry of sameSideEntries) {
        if (entry.path !== canonicalPath) {
          removed.add(entry);
          changed = true;
        }
      }
    }

    if (removed.size > 0 || replacements.length > 0) {
      entriesByNamespace.set(
        namespace,
        [...entries.filter((entry) => !removed.has(entry)), ...replacements].sort(comparePlanEntries)
      );
    }
  }

  if (!changed) return plan;
  const entries = [...entriesByNamespace.values()].flat().sort(comparePlanEntries);
  return {
    entries,
    byNamespace: summarizeReconcilePlan(entries),
    converged: entries.every((entry) => entry.action === "identical"),
  };
}
