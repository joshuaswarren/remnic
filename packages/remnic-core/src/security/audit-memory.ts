import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import { screenCandidateFact } from "./injection-screen.js";
import type { InjectionScreenProfile } from "./injection-screen.js";
import { inferMemoryStatus, isArchivedMemoryPath, toMemoryPathRel } from "../memory-lifecycle-ledger-utils.js";
import { parseStrictCliDate } from "../training-export/date-parse.js";

export type AuditMemoryFindingCategory =
  | "injection-signature"
  | "write-burst"
  | "authority-escalation";

export interface AuditMemoryFinding {
  memoryId: string;
  category: AuditMemoryFindingCategory;
  rule: string;
  excerpt: string;
  lineageHint: string;
}

export interface AuditMemoryStorage {
  readAllMemories(): Promise<MemoryFile[]>;
  readAllColdMemories?: () => Promise<MemoryFile[]>;
  readMemoryByPath(filePath: string): Promise<MemoryFile | null>;
  writeMemoryFrontmatterIfUnchanged(
    expected: MemoryFile,
    patch: Partial<MemoryFrontmatter>,
    lifecycle?: {
      actor?: string;
      reasonCode?: string;
      ruleVersion?: string;
      at?: Date;
    },
  ): Promise<boolean>;
}

export interface AuditMemoryStoreOptions {
  memoryDir: string;
  since?: string | Date;
  quarantine?: boolean;
  /** Screen profile; defaults to "default" (named defense modes pass "hardened"). */
  profile?: InjectionScreenProfile;
  now?: Date;
  storage: AuditMemoryStorage;
}

export interface AuditMemoryReport {
  since?: string;
  scannedMemories: number;
  activeMemories: number;
  findings: AuditMemoryFinding[];
  quarantinedMemoryIds: string[];
  transitions: number;
  writeBurstStats: {
    groupCount: number;
    mean: number;
    standardDeviation: number;
    threshold: number;
    anomalousGroups: Array<{ lineageHint: string; count: number }>;
  };
}

function isActive(memory: MemoryFile, memoryDir: string): boolean {
  // #1955 review: legacy memories without an explicit status ARE active in
  // normal recall (inferMemoryStatus handles missing status), so the audit
  // must include them — otherwise injection-bearing legacy memories can
  // never be reported or quarantined. Explicit non-active statuses bail.
  const status = memory.frontmatter.status;
  if (status !== undefined && status !== "active") return false;
  if (memory.frontmatter.archivedAt !== undefined) return false;
  const pathRel = toMemoryPathRel(memoryDir, memory.path);
  if (isArchivedMemoryPath(memory.path) || isArchivedMemoryPath(pathRel)) return false;
  return inferMemoryStatus(memory.frontmatter, pathRel) === "active";
}

function parseSince(value: string | Date | undefined): Date | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("invalid --since date");
    return new Date(value.getTime());
  }
  // Strict parse (rejects calendar overflow like 2026-02-31 and trailing
  // junk) — a silently reinterpreted date changes which memories
  // --quarantine may mutate (#1955 review).
  return parseStrictCliDate(value, "--since");
}

function isInWindow(memory: MemoryFile, since: Date | undefined): boolean {
  if (since === undefined) return true;
  const created = Date.parse(memory.frontmatter.created);
  const updated = Date.parse(memory.frontmatter.updated);
  return (Number.isFinite(created) && created >= since.getTime())
    || (Number.isFinite(updated) && updated >= since.getTime());
}

function excerpt(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

type LineageMetadata = MemoryFrontmatter & {
  sessionKey?: unknown;
  sourceSessionKey?: unknown;
  conversationId?: unknown;
};

function lineageHint(memory: MemoryFile): string {
  const frontmatter = memory.frontmatter as LineageMetadata;
  const source = frontmatter.sources?.[0];
  if (typeof source?.sessionKey === "string" && source.sessionKey.trim().length > 0) {
    return source.sessionKey.trim();
  }
  for (const value of [
    frontmatter.sourceSessionKey,
    frontmatter.sessionKey,
    frontmatter.conversationId,
    frontmatter.sourceTurnId,
    frontmatter.sourceConnector,
    frontmatter.source,
  ]) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "unknown";
}

const GENERIC_LINEAGE_VALUES: Record<string, true> = {
  unknown: true,
  none: true,
  null: true,
  "n/a": true,
  na: true,
  extraction: true,
  connector: true,
};

function lineageKey(memory: MemoryFile): string | undefined {
  const frontmatter = memory.frontmatter as LineageMetadata;
  const source = frontmatter.sources?.[0];
  for (const value of [
    source?.sessionKey,
    frontmatter.sourceSessionKey,
    frontmatter.sessionKey,
    frontmatter.conversationId,
  ]) {
    if (typeof value !== "string") continue;
    const key = value.trim();
    if (key.length > 0 && GENERIC_LINEAGE_VALUES[key.toLowerCase()] !== true) return key;
  }
  return undefined;
}

/**
 * Group by lineage AND creation day: a burst is many writes in a SHORT
 * interval, so a long-lived legitimate session must not aggregate months of
 * normal writes into one quarantine-eligible bucket (#1955 review).
 */
function sourceGroups(memories: MemoryFile[]): Map<string, MemoryFile[]> {
  const groups = new Map<string, MemoryFile[]>();
  for (const memory of memories) {
    const lineage = lineageKey(memory);
    // Do not create an "unknown" group. Generic or absent provenance cannot
    // establish a write burst.
    if (lineage === undefined) continue;
    const day = typeof memory.frontmatter.created === "string" ? memory.frontmatter.created.slice(0, 10) : "";
    if (!day) continue;
    const key = `${lineage}@${day}`;
    const group = groups.get(key) ?? [];
    group.push(memory);
    groups.set(key, group);
  }
  return groups;
}

function burstBaseline(counts: number[]): {
  mean: number;
  standardDeviation: number;
  threshold: number;
} {
  if (counts.length === 0) return { mean: 0, standardDeviation: 0, threshold: 10 };
  const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
  const variance = counts.reduce((sum, count) => sum + (count - mean) ** 2, 0) / counts.length;
  const standardDeviation = Math.sqrt(variance);
  return {
    mean,
    standardDeviation,
    threshold: Math.max(10, mean + 3 * standardDeviation),
  };
}

function writeBurstStats(groups: Map<string, MemoryFile[]>): AuditMemoryReport["writeBurstStats"] {
  const entries = [...groups.entries()];
  const counts = entries.map(([, group]) => group.length);
  const summary = burstBaseline(counts);
  const anomalousGroups = entries
    .filter(([, group], candidateIndex) => {
      const baselineCounts = counts.filter((_, index) => index !== candidateIndex);
      const baseline = burstBaseline(baselineCounts);
      return group.length > baseline.threshold;
    })
    .map(([lineage, group]) => ({ lineageHint: lineage, count: group.length }));
  return {
    groupCount: counts.length,
    mean: summary.mean,
    standardDeviation: summary.standardDeviation,
    threshold: summary.threshold,
    anomalousGroups,
  };
}

export async function auditMemoryStore(options: AuditMemoryStoreOptions): Promise<AuditMemoryReport> {
  const since = parseSince(options.since);
  const storage = options.storage;
  const hotMemories = await storage.readAllMemories();
  const coldMemories = storage.readAllColdMemories ? await storage.readAllColdMemories() : [];
  const allMemories = [...hotMemories, ...coldMemories];
  const activeMemories = allMemories.filter(
    (memory) => isActive(memory, options.memoryDir) && isInWindow(memory, since),
  );
  const findings: AuditMemoryFinding[] = [];
  const quarantinePaths = new Map<string, { injection: boolean; burst: boolean }>();
  const profile = options.profile ?? "default";

  for (const memory of activeMemories) {
    const screened = screenCandidateFact(memory.content, profile);
    if (screened.quarantine === true) quarantinePaths.set(memory.path, { injection: true, burst: false });
    for (const screenFinding of screened.findings) {
      findings.push({
        memoryId: memory.frontmatter.id,
        category: "injection-signature",
        rule: screenFinding.rule,
        excerpt: excerpt(screenFinding.excerpt || memory.content),
        lineageHint: lineageHint(memory),
      });
      if (screenFinding.rule === "authority-escalation") {
        findings.push({
          memoryId: memory.frontmatter.id,
          category: "authority-escalation",
          rule: screenFinding.rule,
          excerpt: excerpt(screenFinding.excerpt || memory.content),
          lineageHint: lineageHint(memory),
        });
      }
    }
  }

  const groups = sourceGroups(activeMemories);
  const burstStats = writeBurstStats(groups);
  const anomalousLineages = new Set(burstStats.anomalousGroups.map((group) => group.lineageHint));
  for (const [lineage, group] of groups) {
    if (!anomalousLineages.has(lineage)) continue;
    for (const memory of group) {
      const q = quarantinePaths.get(memory.path) ?? { injection: false, burst: false };
      q.burst = true;
      quarantinePaths.set(memory.path, q);
      findings.push({
        memoryId: memory.frontmatter.id,
        category: "write-burst",
        rule: "write-burst",
        excerpt: excerpt(memory.content),
        lineageHint: lineage,
      });
    }
  }

  const quarantinedMemoryIds: string[] = [];
  if (options.quarantine) {
    const now = (options.now ?? new Date()).toISOString();
    for (const staleMemory of activeMemories) {
      const qInfo = quarantinePaths.get(staleMemory.path);
      if (!qInfo) continue;
      // #1955 review: the stale snapshot from readAllMemories can be old enough
      // that intermediate gateway writes would be lost if rewritten blindly. Fetch
      // the live record first.
      const memory = await storage.readMemoryByPath(staleMemory.path);
      if (!memory || !isActive(memory, options.memoryDir)) continue;
      if (qInfo.injection && !qInfo.burst && !screenCandidateFact(memory.content, profile).quarantine) continue;
      const changed = await storage.writeMemoryFrontmatterIfUnchanged(memory, {
        status: "pending_review",
        updated: now,
      }, {
        actor: "cli.security.audit-memory",
        reasonCode: "memory-poisoning-hardening",
        ruleVersion: "memory-poisoning.v1",
      });
      if (changed) quarantinedMemoryIds.push(memory.frontmatter.id);
    }
  }

  return {
    ...(since ? { since: since.toISOString() } : {}),
    scannedMemories: allMemories.length,
    activeMemories: activeMemories.length,
    findings,
    quarantinedMemoryIds,
    transitions: quarantinedMemoryIds.length,
    writeBurstStats: burstStats,
  };
}

export function formatAuditMemoryReport(report: AuditMemoryReport): string {
  const lines = [
    "Memory security audit",
    `Scanned: ${report.scannedMemories} total, ${report.activeMemories} active`,
    `Findings: ${report.findings.length}`,
    `Quarantined: ${report.transitions}`,
    "",
    "CATEGORY               MEMORY ID                 RULE                    LINEAGE              EXCERPT",
  ];
  if (report.findings.length === 0) {
    lines.push("(none)");
  } else {
    for (const finding of report.findings) {
      lines.push([
        finding.category.padEnd(22),
        finding.memoryId.padEnd(25),
        finding.rule.padEnd(23),
        finding.lineageHint.slice(0, 19).padEnd(20),
        finding.excerpt,
      ].join(" "));
    }
  }
  return lines.join("\n");
}
