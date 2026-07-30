import path from "node:path";

import { capabilityAllowsNamespace, type TokenCapabilities } from "../access-token-capabilities.js";
import { resolveNamespaceCapabilities } from "../capabilities.js";
import { resolveCorpusNamespaceRoots, type CorpusNamespaceRoot } from "../corpus-watermark.js";
import { normalizeNamespaceIdentity } from "../namespaces/identity.js";
import type { ExtractionRootStats, ExtractionWatermarkRead } from "../extraction-liveness.js";
import type { MetaState, PluginConfig } from "../types.js";

export interface ExtractionWatermarkMeta extends Pick<MetaState, "lastExtractionAt"> {
  extractionCount?: number;
  lastConsolidationAt?: string | null;
}

export interface ExtractionWatermarkStorage {
  readonly dir: string;
  loadMeta(): Promise<ExtractionWatermarkMeta>;
}

export interface ExtractionNamespaceRootCache {
  getResolvedRootsStatus(compute: () => Promise<CorpusNamespaceRoot[]>): {
    roots: CorpusNamespaceRoot[] | undefined;
    refreshError: unknown;
  };
}

export interface AggregateExtractionWatermarkOptions {
  config: PluginConfig;
  rootStorage: ExtractionWatermarkStorage;
  rootMeta?: ExtractionWatermarkMeta;
  storageForNamespace(
    namespace: string,
    rootDir: string
  ): ExtractionWatermarkStorage | Promise<ExtractionWatermarkStorage>;
  rootsCache?: ExtractionNamespaceRootCache;
  caps?: TokenCapabilities;
}

function readFailure(reason: string): ExtractionWatermarkRead {
  return {
    lastExtractionAt: null,
    readFailed: true,
    readError: reason,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ISO_TIMESTAMP_PATTERN =
  /^([+-]?\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/i;

function validatedTimestampMs(value: string): number | null {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  const parsed = Date.parse(value);
  if (!match || !Number.isFinite(parsed)) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] = match;
  const normalizedZone = zone.toUpperCase();
  const offsetMinuteText = normalizedZone.includes(":")
    ? normalizedZone.slice(4, 6)
    : normalizedZone.slice(3, 5);
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!) return null;
  if (hour === 24) {
    const isEndOfDay = minute === 0 && second === 0 && /^0*$/.test(fraction ?? "");
    return isEndOfDay ? parsed : null;
  }
  const zoneSign = normalizedZone === "Z" || normalizedZone[0] === "+" ? 1 : -1;
  const offsetMinutes =
    normalizedZone === "Z"
      ? 0
      : zoneSign * (Number(normalizedZone.slice(1, 3)) * 60 + Number(offsetMinuteText));
  const representedCalendar = new Date(parsed + offsetMinutes * 60_000);
  const millisecond = Number((fraction ?? "").padEnd(3, "0").slice(0, 3));
  const expected = [
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
  ];
  const actual = [
    representedCalendar.getUTCFullYear(),
    representedCalendar.getUTCMonth() + 1,
    representedCalendar.getUTCDate(),
    representedCalendar.getUTCHours(),
    representedCalendar.getUTCMinutes(),
    representedCalendar.getUTCSeconds(),
    representedCalendar.getUTCMilliseconds(),
  ];
  return actual.every((part, index) => part === expected[index]) ? parsed : null;
}

function mergeRootStats(
  current: ExtractionRootStats | undefined,
  candidate: ExtractionRootStats | undefined,
): ExtractionRootStats | undefined {
  if (!current && !candidate) return undefined;
  const currentCount = current?.extractionCount;
  const candidateCount = candidate?.extractionCount;
  const extractionCount =
    currentCount === undefined && candidateCount === undefined
      ? undefined
      : (currentCount ?? 0) + (candidateCount ?? 0);
  const currentConsolidation = current?.lastConsolidationAt;
  const candidateConsolidation = candidate?.lastConsolidationAt;
  const hasConsolidation =
    currentConsolidation !== undefined || candidateConsolidation !== undefined;
  return {
    ...(extractionCount === undefined ? {} : { extractionCount }),
    ...(hasConsolidation
      ? {
          lastConsolidationAt: newerWatermark(
            currentConsolidation ?? null,
            candidateConsolidation ?? null,
          ),
        }
      : {}),
  };
}

function watermarkFromMeta(meta: ExtractionWatermarkMeta, name: string): ExtractionWatermarkRead {
  if (
    meta.lastExtractionAt !== null &&
    meta.lastExtractionAt !== undefined &&
    validatedTimestampMs(meta.lastExtractionAt) === null
  ) {
    return readFailure(`${name} watermark timestamp invalid`);
  }
  if (
    meta.lastConsolidationAt !== null &&
    meta.lastConsolidationAt !== undefined &&
    validatedTimestampMs(meta.lastConsolidationAt) === null
  ) {
    return readFailure(`${name} consolidation timestamp invalid`);
  }
  const hasRootStats = meta.extractionCount !== undefined || meta.lastConsolidationAt !== undefined;
  return {
    lastExtractionAt: meta.lastExtractionAt ?? null,
    readFailed: false,
    ...(hasRootStats
      ? {
          rootStats: {
            extractionCount: meta.extractionCount,
            lastConsolidationAt: meta.lastConsolidationAt,
          },
        }
      : {}),
  };
}

async function readWatermark(storage: ExtractionWatermarkStorage, name: string): Promise<ExtractionWatermarkRead> {
  try {
    return watermarkFromMeta(await storage.loadMeta(), name);
  } catch (error) {
    return readFailure(`${name} watermark unreadable: ${errorMessage(error)}`);
  }
}

async function resolveRoots(
  options: AggregateExtractionWatermarkOptions
): Promise<CorpusNamespaceRoot[] | ExtractionWatermarkRead> {
  const compute = () =>
    resolveCorpusNamespaceRoots({
      config: options.config,
      propagateDiscoveryErrors: true,
    });
  if (options.rootsCache) {
    const { roots, refreshError } = options.rootsCache.getResolvedRootsStatus(compute);
    if (refreshError !== undefined) {
      return readFailure(`namespace watermark enumeration failed: ${errorMessage(refreshError)}`);
    }
    return roots ?? { lastExtractionAt: null, readFailed: false, pending: true };
  }
  try {
    return await compute();
  } catch (error) {
    return readFailure(`namespace watermark enumeration failed: ${errorMessage(error)}`);
  }
}

function isReadFailure(value: CorpusNamespaceRoot[] | ExtractionWatermarkRead): value is ExtractionWatermarkRead {
  return !Array.isArray(value);
}

function newerWatermark(current: string | null, candidate: string | null): string | null {
  if (candidate === null) return current;
  const candidateMs = validatedTimestampMs(candidate);
  if (candidateMs === null) return current;
  if (current === null) return candidate;
  const currentMs = validatedTimestampMs(current);
  return currentMs === null || candidateMs > currentMs ? candidate : current;
}

export async function readAggregateExtractionWatermark(
  options: AggregateExtractionWatermarkOptions
): Promise<ExtractionWatermarkRead> {
  if (!resolveNamespaceCapabilities(options.config).namespaces) {
    return options.rootMeta
      ? watermarkFromMeta(options.rootMeta, "root store")
      : readWatermark(options.rootStorage, "root store");
  }

  const resolved = await resolveRoots(options);
  if (isReadFailure(resolved)) return resolved;

  const rootDir = path.resolve(options.rootStorage.dir);
  const seenDirs = new Set<string>([rootDir]);
  const targets: CorpusNamespaceRoot[] = [];
  for (const root of resolved) {
    if (
      options.caps &&
      !root.namespaces.some((ns) =>
        capabilityAllowsNamespace(options.caps, normalizeNamespaceIdentity(ns)),
      )
    ) {
      continue;
    }
    const resolvedDir = path.resolve(root.rootDir);
    if (seenDirs.has(resolvedDir)) continue;
    seenDirs.add(resolvedDir);
    targets.push(root);
  }

  const defaultNamespace = normalizeNamespaceIdentity(options.config.defaultNamespace);
  const hasMigratedDefault = resolved.some(
    (root) =>
      path.resolve(root.rootDir) !== rootDir &&
      root.namespaces.some((namespace) => normalizeNamespaceIdentity(namespace) === defaultNamespace),
  );
  const canAccessRoot =
    !hasMigratedDefault &&
    (!options.caps || capabilityAllowsNamespace(options.caps, defaultNamespace));
  let rootRead: ExtractionWatermarkRead = { lastExtractionAt: null, readFailed: false };
  if (canAccessRoot) {
    rootRead = options.rootMeta
      ? watermarkFromMeta(options.rootMeta, "root store")
      : await readWatermark(options.rootStorage, "root store");
    if (rootRead.readFailed) return rootRead;
  }
  let lastExtractionAt = rootRead.lastExtractionAt;
  let rootStats = rootRead.rootStats;

  const reads = await Promise.all(
    targets.map(async (target) => {
      try {
        const storage = await options.storageForNamespace(target.namespace, target.rootDir);
        return await readWatermark(storage, "namespace");
      } catch (error) {
        return readFailure(`namespace watermark storage unavailable: ${errorMessage(error)}`);
      }
    })
  );

  for (const read of reads) {
    if (read.readFailed) {
      return readFailure(read.readError ?? "namespace watermark unreadable");
    }
    lastExtractionAt = newerWatermark(lastExtractionAt, read.lastExtractionAt);
    rootStats = mergeRootStats(rootStats, read.rootStats);
  }
  return {
    lastExtractionAt,
    readFailed: false,
    ...(rootStats ? { rootStats } : {}),
  };
}
