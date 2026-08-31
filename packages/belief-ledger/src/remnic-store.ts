import {
  composeSalvagedEnvelope,
  ContentHashIndex,
  normalizeAttributePairs,
  sanitizeMemoryContent,
  STRUCTURED_ATTRIBUTE_LIMITS,
  type MemoryFile,
  type StorageManager,
} from "@remnic/core";
import {
  claimFromMemory,
  claimTags,
  claimToStructuredAttributes,
  memoryFrontmatterPatchForClaim,
  mergeClaimPatch,
  normalizeIsoTimestamp,
  remnicMemoryStatusForClaim,
  serializeClaimBody,
} from "./schema.js";
import type { LedgerClaim, LedgerClaimKind, LedgerClaimStatus, LedgerStore } from "./types.js";

function serializeClaimMemoryContent(claim: LedgerClaim): string {
  const attributes = normalizeAttributePairs(claimToStructuredAttributes(claim));
  return `${serializeClaimBody(claim)}\n[Attributes: ${attributes}]`;
}

const JSON_ARRAY_ATTRIBUTES = new Set([
  "ledger.entities",
  "ledger.parentIds",
  "ledger.evidenceLinks",
]);
const ATTRIBUTE_TRUNCATION_SUFFIX = " [truncated]";

function boundClaimAttributesForEnvelope(
  attributes: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => {
      if (value.length <= STRUCTURED_ATTRIBUTE_LIMITS.maxValueLength) return [key, value];

      if (JSON_ARRAY_ATTRIBUTES.has(key)) {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) {
            const retained: unknown[] = [];
            for (const item of parsed) {
              const candidate = JSON.stringify([...retained, item]);
              if (candidate.length > STRUCTURED_ATTRIBUTE_LIMITS.maxValueLength) break;
              retained.push(item);
            }
            return [key, JSON.stringify(retained)];
          }
        } catch {
        }
      }

      const contentLength =
        STRUCTURED_ATTRIBUTE_LIMITS.maxValueLength - ATTRIBUTE_TRUNCATION_SUFFIX.length;
      return [key, `${value.slice(0, contentLength)}${ATTRIBUTE_TRUNCATION_SUFFIX}`];
    }),
  );
}

export class RemnicLedgerTombstoneBlockedError extends Error {
  readonly code = "tombstone_blocked" as const;
  readonly memoryId: string;
  constructor(memoryId: string) {
    super(
      `claim write was tombstone-blocked (pending_review ${memoryId}) — content is queued for review, not actively stored`,
    );
    this.name = "RemnicLedgerTombstoneBlockedError";
    this.memoryId = memoryId;
  }
}

export interface RemnicLedgerStoreOptions {
  now?: () => Date;
  source?: string;
  writeEntityLinks?: boolean;
}

export class RemnicLedgerStore implements LedgerStore {
  private readonly storage: StorageManager;
  private readonly now: () => Date;
  private readonly source: string;
  private readonly shouldWriteEntityLinks: boolean;

  constructor(storage: StorageManager, options: RemnicLedgerStoreOptions = {}) {
    this.storage = storage;
    this.now = options.now ?? (() => new Date());
    this.source = options.source ?? "belief-ledger";
    this.shouldWriteEntityLinks = options.writeEntityLinks ?? true;
  }

  async createClaim(input: Omit<LedgerClaim, "id" | "memoryId" | "sourceMemory">): Promise<LedgerClaim> {
    const pending: LedgerClaim = {
      ...input,
      id: "pending",
      memoryId: "pending",
    };
    // Sealed-envelope write (issue #1989 PR4): claims are system-serialized
    // but structured attributes (ledger.sourceText, evidence excerpts) may
    // exceed the envelope's value-length limit — SALVAGE keeps oversized
    // fields from aborting a valid claim; drops warn-logged.
    const claimEnvelope = composeSalvagedEnvelope(
      "belief-ledger",
      {
        content: serializeClaimBody(pending),
        category: "fact",
        confidence: pending.confidence,
        tags: claimTags(pending),
        entityRef: pending.scope.entities[0],
        validAt: pending.createdAt,
        structuredAttributes: boundClaimAttributesForEnvelope(claimToStructuredAttributes(pending)),
      },
      { source: this.source },
    );
    const { id: memoryId, tombstoneBlocked } = await this.storage.writeSealedMemory(claimEnvelope, {
      actor: this.source,
      supersedes: pending.supersedes,
      lineage: pending.parentIds.length > 0 ? pending.parentIds : undefined,
      memoryKind: "note",
      status: remnicMemoryStatusForClaim(pending),
    });

    // #1645: a tombstone-blocked claim write lands pending_review (no active
    // copy). getClaim hides pending_review (HIDDEN_REMNIC_STATUSES), so the
    // readback below would throw a misleading "could not be read back" error
    // that looks transient — callers retry and multiply pending_review rows.
    // Check the block BEFORE readback and throw a distinct, honest error so the
    // caller knows this content is permanently blocked, not transiently failed.
    if (tombstoneBlocked) {
      throw new RemnicLedgerTombstoneBlockedError(memoryId);
    }

    const claim = await this.getClaim(memoryId);
    if (!claim) {
      throw new Error(`created claim ${memoryId} could not be read back`);
    }
    await this.writeEntityLinksBestEffort(claim);
    return claim;
  }

  async getClaim(id: string): Promise<LedgerClaim | null> {
    const memory = await this.getLedgerMemoryById(id);
    return memory ? this.claimFromMemorySafely(memory) : null;
  }

  async listClaims(
    filter: {
      statuses?: LedgerClaimStatus[];
      kinds?: LedgerClaimKind[];
    } = {}
  ): Promise<LedgerClaim[]> {
    const memories = await this.readAllLedgerCandidateMemories();
    const statuses = filter.statuses ? new Set(filter.statuses) : null;
    const kinds = filter.kinds ? new Set(filter.kinds) : null;
    return memories
      .map((memory) => this.claimFromMemorySafely(memory))
      .filter((claim): claim is LedgerClaim => claim !== null)
      .filter((claim) => !statuses || statuses.has(claim.status))
      .filter((claim) => !kinds || kinds.has(claim.kind))
      .sort((a, b) => {
        const updatedOrder = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
        if (updatedOrder !== 0) return updatedOrder;
        return a.id.localeCompare(b.id);
      });
  }

  async updateClaim(id: string, patch: Partial<LedgerClaim>): Promise<LedgerClaim> {
    const memory = await this.getLedgerMemoryById(id);
    const existing = this.claimFromMemorySafely(memory);
    if (!existing) {
      throw new Error(`claim ${id} not found`);
    }
    const updated = mergeClaimPatch(existing, patch, this.now().toISOString());

    const contentUpdated = await this.writeClaimMemory(memory, updated, { actor: this.source });
    if (!contentUpdated) {
      throw new Error(`claim ${id} content update failed`);
    }

    const reread = await this.getClaim(id);
    if (!reread) {
      throw new Error(`claim ${id} could not be read after update`);
    }
    await this.writeEntityLinksBestEffort(reread);
    return reread;
  }

  async supersedeClaim(priorId: string, newId: string, reason: string): Promise<boolean> {
    const cleanReason = reason.trim();
    if (!cleanReason) {
      throw new Error("supersede reason must not be empty");
    }
    const prior = await this.getClaim(priorId);
    const next = await this.getClaim(newId);
    if (!prior || !next) return false;

    const parentIds = [...new Set([...next.parentIds, priorId])];
    await this.updateClaim(newId, {
      supersedes: priorId,
      parentIds,
      updatedAt: this.now().toISOString(),
    });

    try {
      await this.updateClaim(priorId, {
        status: "superseded",
        supersededBy: newId,
        updatedAt: this.now().toISOString(),
      });
    } catch (error) {
      const restored = await this.restoreClaimBestEffort(next);
      if (!restored) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`claim ${newId} rollback failed after prior supersession update failed: ${message}`);
      }
      throw error;
    }

    await this.writeSupersessionCorrectionBestEffort(prior, next, cleanReason);
    return true;
  }

  private async getLedgerMemoryById(id: string): Promise<MemoryFile | null> {
    const memories = await this.readAllLedgerCandidateMemories();
    return memories.find((memory) => memory.frontmatter.id === id) ?? null;
  }

  private async readAllLedgerCandidateMemories(): Promise<MemoryFile[]> {
    const [hot, cold, archived] = await Promise.all([
      this.storage.readAllMemories(),
      this.storage.readAllColdMemories(),
      this.storage.readArchivedMemories(),
    ]);
    const byId = new Map<string, MemoryFile>();
    for (const memory of [...hot, ...cold, ...archived]) {
      if (!byId.has(memory.frontmatter.id)) {
        byId.set(memory.frontmatter.id, memory);
      }
    }
    return [...byId.values()];
  }

  private async writeClaimMemory(
    memory: MemoryFile | null,
    claim: LedgerClaim,
    options: { actor: string }
  ): Promise<boolean> {
    if (!memory) return false;
    const sanitized = sanitizeMemoryContent(serializeClaimMemoryContent(claim));
    const relatedMemoryIds = [
      ...(claim.supersedes ? [claim.supersedes] : []),
      ...(claim.supersededBy ? [claim.supersededBy] : []),
      ...claim.parentIds,
    ];
    return this.storage.writeMemoryFrontmatter(
      { ...memory, content: sanitized.text },
      {
        ...memoryFrontmatterPatchForClaim(claim),
        contentHash: ContentHashIndex.computeHash(sanitized.text),
      },
      {
        actor: options.actor,
        reasonCode: "belief-ledger-update",
        relatedMemoryIds,
      }
    );
  }

  private async restoreClaimBestEffort(claim: LedgerClaim): Promise<boolean> {
    try {
      return await this.writeClaimMemory(claim.sourceMemory ?? (await this.getLedgerMemoryById(claim.id)), claim, {
        actor: this.source,
      });
    } catch {
      return false;
    }
  }

  private async writeSupersessionCorrectionBestEffort(
    prior: LedgerClaim,
    next: LedgerClaim,
    reason: string
  ): Promise<void> {
    try {
      // Sealed-envelope write (issue #1989 PR4): system-built audit body.
      // Audit-trail correction — system-built body, salvage for the same
      // attribute-limit reason as the claim write.
      await this.storage.writeSealedMemory(
        composeSalvagedEnvelope(
          "belief-ledger:audit",
          {
            content: `Superseded: ${prior.statement}\n\nReplacement: ${next.statement}\n\nReason: ${reason}`,
            category: "correction",
            confidence: 1,
            tags: ["belief-ledger:audit", "supersession", "auto-resolved"],
          },
          { source: this.source },
        ),
        { actor: this.source, lineage: [prior.id, next.id] },
      );
    } catch {
      // The ledger link is already durable; correction memory is an audit side effect.
    }
  }

  private claimFromMemorySafely(memory: MemoryFile | null): LedgerClaim | null {
    if (!memory) return null;
    try {
      return claimFromMemory(memory);
    } catch {
      return null;
    }
  }

  private async writeEntityLinksBestEffort(claim: LedgerClaim): Promise<void> {
    if (!this.shouldWriteEntityLinks) return;
    try {
      await this.writeEntityLinks(claim);
    } catch {
      // Entity links are an index side effect; the claim itself is already durable.
    }
  }

  private async writeEntityLinks(claim: LedgerClaim): Promise<void> {
    const timestamp = normalizeIsoTimestamp("createdAt", claim.createdAt);
    for (const entity of claim.scope.entities) {
      await this.storage.writeEntity(entity, "topic", [], {
        timestamp,
        source: this.source,
        structuredSections: [
          {
            key: "belief-ledger",
            title: "Belief Ledger",
            facts: beliefLedgerEntityFacts(claim),
          },
        ],
      });
    }
  }
}

function beliefLedgerEntityFacts(claim: LedgerClaim): string[] {
  const prefix = `claim=${claim.id}; status=${claim.status}; updatedAt=${claim.updatedAt}`;
  return [
    `${prefix}; ${claim.kind}: ${claim.statement}`,
    `${prefix}; stance=${claim.stance}; confidence=${claim.confidence}`,
  ];
}
