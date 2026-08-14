import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import { screenCandidateFact } from "./injection-screen.js";

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
  writeMemoryFrontmatter(
    memory: MemoryFile,
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

function isActive(memory: MemoryFile): boolean {
  return memory.frontmatter.status === undefined || memory.frontmatter.status === "active";
}

function parseSince(value: string | Date | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid --since date: ${String(value)}`);
  }
  return parsed;
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

function lineageHint(memory: MemoryFile): string {
  const frontmatter = memory.frontmatter as MemoryFrontmatter & {
    sessionKey?: unknown;
    sourceSessionKey?: unknown;
    conversationId?: unknown;
  };
  const source = frontmatter.sources?.[0];
  if (source?.sessionKey) return source.sessionKey;
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

function sourceGroups(memories: MemoryFile[]): Map<string, MemoryFile[]> {
  const groups = new Map<string, MemoryFile[]>();
  for (const memory of memories) {
    const key = lineageHint(memory);
    const group = groups.get(key) ?? [];
    group.push(memory);
    groups.set(key, group);
  }
  return groups;
}

function writeBurstStats(groups: Map<string, MemoryFile[]>): AuditMemoryReport["writeBurstStats"] {
  const counts = [...groups.values()].map((group) => group.length);
  const groupCount = counts.length;
  const mean = groupCount === 0 ? 0 : counts.reduce((sum, count) => sum + count, 0) / groupCount;
  const variance = groupCount === 0
    ? 0
    : counts.reduce((sum, count) => sum + (count - mean) ** 2, 0) / groupCount;
  const standardDeviation = Math.sqrt(variance);
  // Issue #1955: a burst must exceed both the statistical threshold and 10 writes.
  const threshold = Math.max(10, mean + 3 * standardDeviation);
  const anomalousGroups = [...groups.entries()]
    .filter(([, group]) => group.length > threshold)
    .map(([lineage, group]) => ({ lineageHint: lineage, count: group.length }));
  return { groupCount, mean, standardDeviation, threshold, anomalousGroups };
}

export async function auditMemoryStore(options: AuditMemoryStoreOptions): Promise<AuditMemoryReport> {
  const since = parseSince(options.since);
  const storage = options.storage;
  const hotMemories = await storage.readAllMemories();
  const coldMemories = storage.readAllColdMemories ? await storage.readAllColdMemories() : [];
  const allMemories = [...hotMemories, ...coldMemories];
  const activeMemories = allMemories.filter((memory) => isActive(memory) && isInWindow(memory, since));
  const findings: AuditMemoryFinding[] = [];

  for (const memory of activeMemories) {
    const screened = screenCandidateFact(memory.content);
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
    const flaggedIds = new Set(findings.map((finding) => finding.memoryId));
    const now = (options.now ?? new Date()).toISOString();
    for (const memory of activeMemories) {
      if (!flaggedIds.has(memory.frontmatter.id)) continue;
      const changed = await storage.writeMemoryFrontmatter(memory, {
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
