import { createHash, randomUUID } from "node:crypto";
import { composeMemoryEnvelope } from "./write-envelope.js";
import { log } from "./logger.js";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { StorageManager } from "./storage.js";
import type { MemoryFile, MemoryLink } from "./types.js";
import { isErrnoCode } from "./utils/errno.js";

export interface SemanticRulePromotionCandidate {
  id: string;
  sourceMemoryId: string;
  content: string;
  confidence: number;
  tags: string[];
  memoryKind: "note";
  lineage: string[];
}

export interface SemanticRulePromotionSkip {
  sourceMemoryId: string;
  reason:
    | "disabled"
    | "source-memory-missing"
    | "source-memory-forgotten"
    | "source-memory-not-episode"
    | "no-explicit-rule"
    | "duplicate-rule";
  existingRuleId?: string;
}

export interface SemanticRulePromotionReport {
  enabled: boolean;
  dryRun: boolean;
  promoted: SemanticRulePromotionCandidate[];
  skipped: SemanticRulePromotionSkip[];
}

const PROMOTION_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const PROMOTION_LOCK_RETRY_MS = 25;
const PROMOTION_LOCK_STALE_MS = 5 * 60 * 1000;
const PROMOTION_LOCK_OWNERLESS_GRACE_MS = 1000;
const PROMOTION_LOCK_HEARTBEAT_MS = 30 * 1000;

type SemanticRulePromotionTestHooks = {
  beforeLockOwnerWrite?: (lockDir: string, ownerToken: string) => Promise<void> | void;
  beforeLockRelease?: (lockDir: string, ownerToken: string) => Promise<void> | void;
  beforePromotedRuleWrite?: (lockDir: string, ownerToken: string) => Promise<void> | void;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  staleLockMs?: number;
  ownerlessGraceMs?: number;
  heartbeatMs?: number;
};

let testHooks: SemanticRulePromotionTestHooks | null = null;

export function setSemanticRulePromotionTestHooks(hooks: SemanticRulePromotionTestHooks | null): void {
  testHooks = hooks;
}

function promotionLockTimeoutMs(): number {
  return testHooks?.lockTimeoutMs ?? PROMOTION_LOCK_TIMEOUT_MS;
}

function promotionLockRetryMs(): number {
  return testHooks?.lockRetryMs ?? PROMOTION_LOCK_RETRY_MS;
}

function promotionLockStaleMs(): number {
  return testHooks?.staleLockMs ?? PROMOTION_LOCK_STALE_MS;
}

function promotionLockOwnerlessGraceMs(): number {
  return testHooks?.ownerlessGraceMs ?? PROMOTION_LOCK_OWNERLESS_GRACE_MS;
}

function promotionLockHeartbeatMs(): number {
  return testHooks?.heartbeatMs ?? PROMOTION_LOCK_HEARTBEAT_MS;
}

function promotionLockDir(memoryDir: string, ruleKey: string): string {
  const digest = createHash("sha256").update(ruleKey).digest("hex");
  return path.join(path.resolve(memoryDir), "state", "semantic-rule-promotion-locks", `${digest}.lock`);
}

function promotionHeartbeatPath(lockDir: string, token: string): string {
  return path.join(lockDir, `heartbeat.${token}.json`);
}

function promotionReapDir(lockDir: string): string {
  return `${lockDir}.reap`;
}

function promotionReleaseDir(lockDir: string): string {
  return `${lockDir}.release`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return false;
    throw err;
  }
}

async function readPromotionLockOwner(lockDir: string): Promise<{
  acquiredAtMs: number | null;
  heartbeatAtMs: number | null;
  token: string | null;
}> {
  try {
    const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as {
      acquiredAt?: unknown;
      heartbeatAt?: unknown;
      token?: unknown;
    };
    const acquiredAtMs = typeof owner.acquiredAt === "string" ? Date.parse(owner.acquiredAt) : Number.NaN;
    const heartbeatAtMs = typeof owner.heartbeatAt === "string" ? Date.parse(owner.heartbeatAt) : Number.NaN;
    return {
      acquiredAtMs: Number.isFinite(acquiredAtMs) ? acquiredAtMs : null,
      heartbeatAtMs: Number.isFinite(heartbeatAtMs) ? heartbeatAtMs : null,
      token: typeof owner.token === "string" ? owner.token : null,
    };
  } catch {
    return {
      acquiredAtMs: null,
      heartbeatAtMs: null,
      token: null,
    };
  }
}

async function tryWritePromotionLockOwner(
  lockDir: string,
  owner: { token: string; acquiredAt: string }
): Promise<boolean> {
  const ownerPath = path.join(lockDir, "owner.json");
  const tempPath = path.join(lockDir, `owner.${process.pid}.${randomUUID()}.tmp`);
  await testHooks?.beforeLockOwnerWrite?.(lockDir, owner.token);
  try {
    await writeFile(
      tempPath,
      `${JSON.stringify(
        {
          pid: process.pid,
          token: owner.token,
          acquiredAt: owner.acquiredAt,
        },
        null,
        2
      )}\n`
    );
    await link(tempPath, ownerPath);
    return true;
  } catch (err) {
    if (isErrnoCode(err, "EEXIST") || isErrnoCode(err, "ENOENT")) {
      return false;
    }
    throw err;
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function writePromotionLockHeartbeat(lockDir: string, token: string): Promise<void> {
  const heartbeatPath = promotionHeartbeatPath(lockDir, token);
  const tempPath = path.join(lockDir, `heartbeat.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(
      tempPath,
      `${JSON.stringify(
        {
          pid: process.pid,
          token,
          heartbeatAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`
    );
    await rename(tempPath, heartbeatPath);
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  }
}

async function refreshPromotionLockHeartbeat(lockDir: string, token: string): Promise<boolean> {
  const owner = await readPromotionLockOwner(lockDir);
  if (owner.token !== token) {
    return false;
  }
  await writePromotionLockHeartbeat(lockDir, token);
  return true;
}

async function readPromotionLockHeartbeatMs(lockDir: string, token: string | null): Promise<number | null> {
  if (!token) return null;
  try {
    return (await stat(promotionHeartbeatPath(lockDir, token))).mtimeMs;
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null;
    throw err;
  }
}

async function reapAbandonedPromotionGuard(guardDir: string): Promise<boolean> {
  let reapStat: { mtimeMs: number };
  try {
    reapStat = await stat(guardDir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return false;
    throw err;
  }
  if (Date.now() - reapStat.mtimeMs < promotionLockStaleMs()) {
    return false;
  }

  const staleReapDir = `${guardDir}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(guardDir, staleReapDir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return false;
    throw err;
  }
  await rm(staleReapDir, { recursive: true, force: true });
  return true;
}

async function reapAbandonedPromotionGuards(lockDir: string): Promise<boolean> {
  const reapedReapGuard = await reapAbandonedPromotionGuard(promotionReapDir(lockDir));
  const reapedReleaseGuard = await reapAbandonedPromotionGuard(promotionReleaseDir(lockDir));
  return reapedReapGuard || reapedReleaseGuard;
}

async function hasPromotionGuard(lockDir: string): Promise<boolean> {
  return (await pathExists(promotionReapDir(lockDir))) || (await pathExists(promotionReleaseDir(lockDir)));
}

async function reapStalePromotionLock(lockDir: string): Promise<boolean> {
  if (await hasPromotionGuard(lockDir)) {
    await reapAbandonedPromotionGuards(lockDir);
    return false;
  }

  const reapDir = promotionReapDir(lockDir);
  try {
    await mkdir(reapDir);
  } catch (err) {
    if (isErrnoCode(err, "EEXIST")) return false;
    throw err;
  }

  let staleDir: string | null = null;
  try {
    return await reapStalePromotionLockWithGuard(lockDir, (value) => {
      staleDir = value;
    });
  } finally {
    if (staleDir) {
      await rm(staleDir, { recursive: true, force: true });
    }
    await rm(reapDir, { recursive: true, force: true });
  }
}

async function reapStalePromotionLockWithGuard(
  lockDir: string,
  setStaleDir: (staleDir: string) => void
): Promise<boolean> {
  let lockStat: { mtimeMs: number };
  try {
    lockStat = await stat(lockDir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return false;
    throw err;
  }

  const owner = await readPromotionLockOwner(lockDir);
  const heartbeatMs = await readPromotionLockHeartbeatMs(lockDir, owner.token);
  const lockedAtMs = heartbeatMs ?? owner.heartbeatAtMs ?? owner.acquiredAtMs ?? lockStat.mtimeMs;
  const ownerlessLock = owner.token === null && owner.heartbeatAtMs === null && owner.acquiredAtMs === null;
  const staleAfterMs = ownerlessLock ? promotionLockOwnerlessGraceMs() : promotionLockStaleMs();
  if (Date.now() - lockedAtMs < staleAfterMs) {
    return false;
  }

  const staleDir = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockDir, staleDir);
    setStaleDir(staleDir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return false;
    throw err;
  }

  const staleOwner = await readPromotionLockOwner(staleDir);
  const staleHeartbeatMs = await readPromotionLockHeartbeatMs(staleDir, staleOwner.token);
  const staleLockedAtMs = staleHeartbeatMs ?? staleOwner.heartbeatAtMs ?? staleOwner.acquiredAtMs ?? lockStat.mtimeMs;
  const staleOwnerlessLock =
    staleOwner.token === null && staleOwner.heartbeatAtMs === null && staleOwner.acquiredAtMs === null;
  const staleAfterRecheckMs = staleOwnerlessLock ? promotionLockOwnerlessGraceMs() : promotionLockStaleMs();
  if (Date.now() - staleLockedAtMs < staleAfterRecheckMs) {
    await rename(staleDir, lockDir);
    setStaleDir("");
    return false;
  }

  await rm(staleDir, { recursive: true, force: true });
  setStaleDir("");
  return true;
}

async function releasePromotionLock(lockDir: string, token: string): Promise<void> {
  const releaseDir = promotionReleaseDir(lockDir);
  const deadline = Date.now() + promotionLockTimeoutMs();
  await testHooks?.beforeLockRelease?.(lockDir, token);
  for (;;) {
    try {
      await mkdir(releaseDir);
      break;
    } catch (err) {
      if (!isErrnoCode(err, "EEXIST")) {
        throw err;
      }
      const owner = await readPromotionLockOwner(lockDir);
      if (owner.token !== token) {
        return;
      }
      await reapAbandonedPromotionGuard(releaseDir);
      if (Date.now() >= deadline) {
        throw new Error("Timed out releasing semantic rule promotion lock");
      }
      await sleep(promotionLockRetryMs());
    }
  }

  try {
    const owner = await readPromotionLockOwner(lockDir);
    if (owner.token !== token) {
      return;
    }
    await rm(lockDir, { recursive: true, force: true });
  } finally {
    await rm(releaseDir, { recursive: true, force: true });
  }
}

type PromotionLockLease = {
  assertHeld: () => Promise<void>;
  beforePromotedRuleWrite: () => Promise<void>;
};

async function withPromotionLock<T>(
  memoryDir: string,
  ruleKey: string,
  fn: (lease: PromotionLockLease) => Promise<T>
): Promise<T> {
  const lockDir = promotionLockDir(memoryDir, ruleKey);
  const lockRoot = path.dirname(lockDir);
  const deadline = Date.now() + promotionLockTimeoutMs();
  let lockToken: string | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  await mkdir(lockRoot, { recursive: true });
  for (;;) {
    try {
      if (await hasPromotionGuard(lockDir)) {
        await reapAbandonedPromotionGuards(lockDir);
        if (Date.now() >= deadline) {
          throw new Error("Timed out acquiring semantic rule promotion lock");
        }
        await sleep(promotionLockRetryMs());
        continue;
      }
      await mkdir(lockDir);
      if (await hasPromotionGuard(lockDir)) {
        await reapAbandonedPromotionGuards(lockDir);
        if (Date.now() >= deadline) {
          throw new Error("Timed out acquiring semantic rule promotion lock");
        }
        await sleep(promotionLockRetryMs());
        continue;
      }
      try {
        lockToken = randomUUID();
        const lockOwner = {
          token: lockToken,
          acquiredAt: new Date().toISOString(),
        };
        const wroteOwner = await tryWritePromotionLockOwner(lockDir, lockOwner);
        if (!wroteOwner) {
          lockToken = null;
          if (Date.now() >= deadline) {
            throw new Error("Timed out acquiring semantic rule promotion lock");
          }
          await sleep(promotionLockRetryMs());
          continue;
        }
        await writePromotionLockHeartbeat(lockDir, lockToken);
        const heartbeatToken = lockToken;
        const heartbeatMs = promotionLockHeartbeatMs();
        if (heartbeatMs > 0) {
          heartbeat = setInterval(() => {
            void refreshPromotionLockHeartbeat(lockDir, heartbeatToken)
              .then((ownsLock) => {
                if (!ownsLock && heartbeat) {
                  clearInterval(heartbeat);
                  heartbeat = null;
                }
              })
              .catch(() => undefined);
          }, heartbeatMs);
        }
      } catch (err) {
        lockToken = null;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        await rm(lockDir, { recursive: true, force: true });
        throw err;
      }
      break;
    } catch (err) {
      if (!isErrnoCode(err, "EEXIST")) {
        throw err;
      }
      if (await reapStalePromotionLock(lockDir)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out acquiring semantic rule promotion lock");
      }
      await sleep(promotionLockRetryMs());
    }
  }

  const assertHeld = async () => {
    if (!lockToken) {
      throw new Error("Semantic rule promotion lock is no longer held");
    }
    const ownsLock = await refreshPromotionLockHeartbeat(lockDir, lockToken);
    if (!ownsLock) {
      throw new Error("Semantic rule promotion lock is no longer held");
    }
  };

  let hasResult = false;
  let result: T | undefined;
  let callbackError: unknown;
  let releaseError: unknown;
  try {
    await assertHeld();
    result = await fn({
      assertHeld,
      beforePromotedRuleWrite: async () => {
        if (!lockToken) {
          throw new Error("Semantic rule promotion lock is no longer held");
        }
        await testHooks?.beforePromotedRuleWrite?.(lockDir, lockToken);
        await assertHeld();
      },
    });
    hasResult = true;
  } catch (err) {
    callbackError = err;
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (lockToken) {
      try {
        await releasePromotionLock(lockDir, lockToken);
      } catch (err) {
        if (!hasResult && !callbackError) {
          releaseError = err;
        }
      }
    }
  }
  if (releaseError) {
    throw releaseError;
  }
  if (callbackError) {
    throw callbackError;
  }
  return result as T;
}

function normalizeRuleWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTrailingClausePunctuation(value: string): string {
  // Linear trailing-punctuation strip (no `/[,:;]+$/` — CodeQL flags that as a
  // polynomial-backtracking ReDoS on long runs of ',;:'). Walk back once, O(n).
  let end = value.length;
  while (end > 0) {
    const ch = value[end - 1];
    if (ch === "," || ch === ":" || ch === ";") end--;
    else break;
  }
  return value.slice(0, end).trim();
}

function canonicalizeRuleContent(value: string): string {
  return extractExplicitIfThenRule(value) ?? normalizeRuleWhitespace(value);
}

function canonicalizeRuleKey(value: string): string {
  return canonicalizeRuleContent(value).toLowerCase();
}

function extractExplicitIfThenRule(content: string): string | null {
  const match = content.match(/\bif\b([\s\S]+?)\bthen\b([\s\S]+?)(?:[.!?](?:\s|$)|$)/i);
  if (!match) return null;
  const condition = stripTrailingClausePunctuation(normalizeRuleWhitespace(match[1] ?? ""));
  const outcome = stripTrailingClausePunctuation(normalizeRuleWhitespace(match[2] ?? ""));
  if (condition.length === 0 || outcome.length === 0) return null;
  return `IF ${condition} THEN ${outcome}.`;
}

function promotionConfidence(memory: MemoryFile): number {
  const base = Number.isFinite(memory.frontmatter.confidence) ? memory.frontmatter.confidence : 0.8;
  return Math.max(0.6, Math.min(0.98, base));
}

function promotionTags(memory: MemoryFile): string[] {
  return Array.from(new Set([...(memory.frontmatter.tags ?? []), "semantic-rule", "promoted-rule"]));
}

function buildSupportLinks(sourceMemoryId: string, confidence: number): MemoryLink[] {
  return [
    {
      targetId: sourceMemoryId,
      linkType: "supports",
      strength: confidence,
      reason: "Promoted from verified episodic memory",
    },
  ];
}

export async function promoteSemanticRuleFromMemory(options: {
  memoryDir: string;
  enabled: boolean;
  sourceMemoryId: string;
  dryRun?: boolean;
}): Promise<SemanticRulePromotionReport> {
  const report: SemanticRulePromotionReport = {
    enabled: options.enabled,
    dryRun: options.dryRun === true,
    promoted: [],
    skipped: [],
  };
  if (!options.enabled) {
    report.skipped.push({
      sourceMemoryId: options.sourceMemoryId,
      reason: "disabled",
    });
    return report;
  }

  const storage = new StorageManager(options.memoryDir);
  const sourceMemory = await storage.getMemoryById(options.sourceMemoryId);
  if (!sourceMemory) {
    report.skipped.push({
      sourceMemoryId: options.sourceMemoryId,
      reason: "source-memory-missing",
    });
    return report;
  }
  if (sourceMemory.frontmatter.status === "forgotten") {
    report.skipped.push({
      sourceMemoryId: options.sourceMemoryId,
      reason: "source-memory-forgotten",
    });
    return report;
  }
  if (sourceMemory.frontmatter.status === "archived" || sourceMemory.frontmatter.memoryKind !== "episode") {
    report.skipped.push({
      sourceMemoryId: options.sourceMemoryId,
      reason: "source-memory-not-episode",
    });
    return report;
  }

  const content = extractExplicitIfThenRule(sourceMemory.content);
  if (!content) {
    report.skipped.push({
      sourceMemoryId: options.sourceMemoryId,
      reason: "no-explicit-rule",
    });
    return report;
  }

  const ruleKey = canonicalizeRuleKey(content);
  const confidence = promotionConfidence(sourceMemory);
  const candidateBase = {
    sourceMemoryId: options.sourceMemoryId,
    content,
    confidence,
    tags: promotionTags(sourceMemory),
    memoryKind: "note" as const,
    lineage: [options.sourceMemoryId],
  };

  return withPromotionLock(options.memoryDir, ruleKey, async (lock) => {
    storage.invalidateAllMemoriesCacheForDir();
    const existingRule = (await storage.readAllMemories()).find(
      (memory) =>
        memory.frontmatter.category === "rule" &&
        memory.frontmatter.status !== "archived" &&
        memory.frontmatter.status !== "forgotten" &&
        canonicalizeRuleKey(memory.content) === ruleKey
    );
    if (existingRule) {
      report.skipped.push({
        sourceMemoryId: options.sourceMemoryId,
        reason: "duplicate-rule",
        existingRuleId: existingRule.frontmatter.id,
      });
      return report;
    }

    if (options.dryRun === true) {
      await lock.assertHeld();
      report.promoted.push({
        id: `dry-run:${options.sourceMemoryId}`,
        ...candidateBase,
      });
      return report;
    }

    await lock.beforePromotedRuleWrite();
    // Sealed-envelope write (issue #1989 PR4): rule content and tags are
    // derived from stored/LLM data — salvage; drops are warn-logged.
    const ruleEnvelope = composeMemoryEnvelope(
      { content, category: "rule", confidence, tags: candidateBase.tags, origin: sourceMemory.frontmatter.origin },
      { source: "semantic-rule-promotion" },
      { salvage: true },
    );
    if (ruleEnvelope.salvageNotes.length > 0) {
      log.warn(`rule-promotion write salvaged invalid fields: ${ruleEnvelope.salvageNotes.join("; ")}`);
    }
    const { id: id } = await storage.writeSealedMemory(ruleEnvelope, {
      lineage: candidateBase.lineage,
      sourceMemoryId: options.sourceMemoryId,
      memoryKind: "note",
      links: buildSupportLinks(options.sourceMemoryId, confidence),
    });
    report.promoted.push({
      id,
      ...candidateBase,
    });
    return report;
  });
}
