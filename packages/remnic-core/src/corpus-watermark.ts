/**
 * Corpus watermark (issue #2149) — a cheap, comparable fingerprint of a
 * daemon's active-memory corpus.
 *
 * Deployment shape this addresses: two daemons behind an active/backup VIP,
 * each owning its own memory directory. Nothing compared the two corpora, so a
 * pair could diverge for months (e.g. one holding ~190k files, its backup
 * ~340k with different histories) with no signal until a manual audit. This
 * module ships the WATERMARK primitive and the read surfaces that expose it;
 * peer polling and divergence alerting are a follow-up.
 *
 * The digest is a CENSUS fingerprint (per day-partition file counts), NOT a
 * content hash — two daemons that agree on how many active memories live in
 * each `<category>/<day>` partition produce the same digest, so a differing
 * digest is a cheap divergence signal without reading or hashing file bodies.
 * `newestWriteAt` is scoped to the NEWEST partition only, so the freshness
 * probe stays O(one day's files) even on a 100k+ corpus.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveNamespaceCapabilities } from "./capabilities.js";
import type { PluginConfig } from "./types.js";

export interface CorpusWatermark {
  namespace: string;
  activeMemoryCount: number;
  /** Newest `YYYY-MM-DD` day-partition seen, or null when none is dated. */
  newestPartition: string | null;
  /** ISO max mtime within the newest partition, or null when it has no files. */
  newestWriteAt: string | null;
  /** sha256 hex over the deterministic per-partition census. */
  digest: string;
  computedAt: string;
}

/** Explicit bucket for paths that do not match the `<category>/<day>` shape. */
export const UNPARTITIONED_BUCKET = "unpartitioned";

const DAY_PARTITION_RE = /^\d{4}-\d{2}-\d{2}$/;

interface ParsedPath {
  readonly bucket: string;
  readonly date: string | null;
}

function parsePartition(baseDir: string, filePath: string): ParsedPath {
  const rel = path.relative(baseDir, filePath).split(path.sep).join("/");
  const parts = rel.split("/");
  if (parts.length >= 2 && DAY_PARTITION_RE.test(parts[1])) {
    return { bucket: `${parts[0]}/${parts[1]}`, date: parts[1] };
  }
  return { bucket: UNPARTITIONED_BUCKET, date: null };
}

/**
 * Build the per-partition census: bucket key -> file count. Paths not matching
 * a day-partition land in the explicit {@link UNPARTITIONED_BUCKET}; they are
 * never silently dropped. Pure — no filesystem access.
 */
export function buildPartitionCensus(paths: readonly string[], baseDir: string): Map<string, number> {
  const census = new Map<string, number>();
  for (const filePath of paths) {
    const { bucket } = parsePartition(baseDir, filePath);
    census.set(bucket, (census.get(bucket) ?? 0) + 1);
  }
  return census;
}

/**
 * Deterministic census -> digest. Bucket keys are SORTED before serialization
 * (AGENTS.md pattern 26: insertion order must not affect a hash), then emitted
 * as `"<bucket>:<count>"` lines joined by `\n` and hashed with sha256. Pure —
 * separately exported so it can be unit-tested without a filesystem.
 */
export function digestPartitionCensus(census: ReadonlyMap<string, number> | Record<string, number>): string {
  const entries = census instanceof Map ? [...census.entries()] : Object.entries(census);
  const serialized = entries
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, count]) => `${bucket}:${count}`)
    .join("\n");
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Compute a watermark for a single namespace from an already-collected path
 * list plus its memory base directory. Never throws on an empty list — an
 * empty corpus yields the digest of the empty census and null timestamps.
 * Only the newest partition's files are `stat`-ed, so freshness stays cheap.
 */
export async function computeCorpusWatermark(input: {
  namespace: string;
  paths: readonly string[];
  baseDir: string;
  now?: Date;
}): Promise<CorpusWatermark> {
  const { namespace, paths, baseDir } = input;
  const computedAt = (input.now ?? new Date()).toISOString();

  const census = new Map<string, number>();
  let newestPartition: string | null = null;
  const parsedByPath: ParsedPath[] = [];
  for (const filePath of paths) {
    const parsed = parsePartition(baseDir, filePath);
    parsedByPath.push(parsed);
    census.set(parsed.bucket, (census.get(parsed.bucket) ?? 0) + 1);
    if (parsed.date !== null && (newestPartition === null || parsed.date > newestPartition)) {
      newestPartition = parsed.date;
    }
  }

  const digest = digestPartitionCensus(census);

  let newestWriteAt: string | null = null;
  if (newestPartition !== null) {
    let maxMtimeMs = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < paths.length; i += 1) {
      if (parsedByPath[i].date !== newestPartition) continue;
      try {
        const st = await stat(paths[i]);
        if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
      } catch {
        // File vanished between scan and stat — skip it, never fail the probe.
      }
    }
    if (maxMtimeMs > Number.NEGATIVE_INFINITY) {
      newestWriteAt = new Date(maxMtimeMs).toISOString();
    }
  }

  return {
    namespace,
    activeMemoryCount: paths.length,
    newestPartition,
    newestWriteAt,
    digest,
    computedAt,
  };
}

/** Minimal storage surface a watermark needs — satisfied by StorageManager. */
export interface CorpusStorage {
  readonly dir: string;
  collectActiveMemoryPaths(): Promise<string[]>;
}

/**
 * Compute watermarks for a set of namespaces. A namespace whose storage is
 * unavailable is skipped rather than failing the whole read, so a single bad
 * namespace never blanks the health/doctor payload.
 */
export async function computeCorpusWatermarks(
  namespaces: readonly string[],
  storageFor: (namespace: string) => CorpusStorage | Promise<CorpusStorage>,
  now?: Date
): Promise<CorpusWatermark[]> {
  const watermarks: CorpusWatermark[] = [];
  for (const namespace of namespaces) {
    try {
      const storage = await storageFor(namespace);
      const paths = await storage.collectActiveMemoryPaths();
      watermarks.push(await computeCorpusWatermark({ namespace, paths, baseDir: storage.dir, now }));
    } catch {
      // Storage unavailable for this namespace — degrade gracefully.
    }
  }
  return watermarks;
}

/** Orchestrator surface the service watermark builder reads — satisfied by Orchestrator. */
export interface CorpusWatermarkHost {
  config: PluginConfig;
  namespaceCatalog?: { listNamespaces?(): Promise<ReadonlyArray<{ namespace: string }>> };
  getStorage(namespace: string): CorpusStorage | Promise<CorpusStorage>;
}

/**
 * Build the per-namespace watermark array served on `/health`. With namespaces
 * disabled this is a single-element array for the default namespace; with them
 * enabled it enumerates the live namespace catalog (always including the
 * default). Degrades to an empty array — never throws — if the catalog or
 * storage is unavailable.
 */
export async function computeServiceCorpusWatermarks(
  host: CorpusWatermarkHost,
  now?: Date
): Promise<CorpusWatermark[]> {
  try {
    const namespaces = await resolveServiceNamespaces(host);
    return await computeCorpusWatermarks(namespaces, (ns) => host.getStorage(ns), now);
  } catch {
    return [];
  }
}

async function resolveServiceNamespaces(host: CorpusWatermarkHost): Promise<string[]> {
  const namespaces = new Set<string>([host.config.defaultNamespace]);
  if (resolveNamespaceCapabilities(host.config).namespaces === true) {
    try {
      const records = (await host.namespaceCatalog?.listNamespaces?.()) ?? [];
      for (const record of records) {
        if (record && typeof record.namespace === "string" && record.namespace.length > 0) {
          namespaces.add(record.namespace);
        }
      }
    } catch {
      // Catalog unavailable — fall back to the default namespace only.
    }
  }
  return [...namespaces];
}
