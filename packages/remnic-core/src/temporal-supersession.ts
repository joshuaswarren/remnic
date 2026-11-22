/**
 * Temporal Supersession (issue #375)
 *
 * When a new fact lands with `structuredAttributes` keyed on a known
 * `entityRef`, any prior fact whose supersession key collides with the new
 * fact's key is marked `status: "superseded"` and linked via
 * `supersededBy` / `supersededAt`.  Recall filters those superseded memories
 * by default so agents see only the "current" value per entity attribute.
 *
 * The algorithm is intentionally O(N) over the memory corpus per write, but
 * skips cheaply when the new fact has no structuredAttributes.  It reuses the
 * cached `readAllMemories()` path so cost is amortized with the rest of the
 * write pipeline.
 */
import type { MemoryFile, MemoryFrontmatter, MemoryLifecycleEvent } from "./types.js";

import { createHash } from "node:crypto";
import { log } from "./logger.js";
import { effectiveValidAt } from "./temporal-validity.js";
import type {
  DependencyPropagationDeliveryPort,
  DependencyPropagationPreparationToken,
} from "./orchestration/dependency-propagation-delivery.js";
import type { PropagationEvent } from "./orchestration/dependency-propagation.js";
export interface TemporalSupersessionStorage {
  readAllMemories(): Promise<MemoryFile[]>;
  readAllColdMemories(): Promise<MemoryFile[]>;
  readMemoryByPath(memoryPath: string): Promise<MemoryFile | null>;
  writeMemoryFrontmatterIfUnchanged?: (
    memory: MemoryFile,
    patch: Partial<MemoryFrontmatter>,
    lifecycle?: {
      actor?: string;
      reasonCode?: string;
      relatedMemoryIds?: string[];
      correlationId?: string;
    },
  ) => Promise<boolean>;
  appendTombstone(input: {
    reason: "supersession";
    createdBy: "supersession";
    sourceMemoryId: string;
    rawContent: string;
    entityRef?: string;
    supersessionKey?: string;
    createdAt?: string;
    contentHash?: string;
    operationKey?: string;
  }): Promise<string | null>;
  hasExactTombstone?: (input: {
    sourceMemoryId: string;
    contentHash?: string;
    entityRef?: string;
    supersessionKey?: string;
    createdAt?: string;
    operationKey?: string;
  }) => Promise<boolean>;
  getMemoryTimeline: (memoryId: string, limit?: number) => Promise<MemoryLifecycleEvent[]>;
  isTombstonesEnabled?: () => boolean;
}

export function normalizeSupersessionKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, "-")
    // The previous line already collapsed runs to single hyphens, so ^-|-$ is
    // equivalent to ^-+|-+$ here and drops the anchored quantifier flagged by
    // CodeQL js/polynomial-redos.
    .replace(/^-|-$/g, "");
}

/**
 * Stable supersession key for an (entityRef, attributeName) pair.
 *
 * The algorithm is:
 *  - normalize the entityRef (trim, lower-case, collapse whitespace)
 *  - normalize the attributeName the same way
 *  - join with `::`
 *
 * Exported so tests and tools can recompute it without depending on storage.
 */
export function computeSupersessionKey(
  entityRef: string | undefined,
  attributeName: string,
): string | null {
  if (!entityRef || typeof entityRef !== "string") return null;
  if (!attributeName || typeof attributeName !== "string") return null;
  const entity = normalizeSupersessionKey(entityRef);
  const attr = normalizeSupersessionKey(attributeName);
  if (entity.length === 0 || attr.length === 0) return null;
  return `${entity}::${attr}`;
}

/**
 * Compute the full set of supersession keys for a fact with structured
 * attributes.  Returns an empty array if no keys can be derived.
 */
export function supersessionKeysForFact(spec: {
  entityRef?: string;
  structuredAttributes?: Record<string, string>;
}): string[] {
  if (!spec.entityRef) return [];
  if (!spec.structuredAttributes) return [];
  const keys: string[] = [];
  for (const attrName of Object.keys(spec.structuredAttributes)) {
    const key = computeSupersessionKey(spec.entityRef, attrName);
    if (key) keys.push(key);
  }
  return keys;
}

/**
 * Look up a structured-attribute value by a raw key, normalizing both sides
 * with `normalizeSupersessionKey` before comparing.  This ensures that keys
 * written by the LLM with mixed case, surrounding whitespace, or internal
 * whitespace (e.g. `"City"`, `" city "`, `"job   title"`, `"job-title"`)
 * are all matched against normalized keys produced by `computeSupersessionKey`
 * (Finding B fix — uses the same helper so both sides are identical).
 *
 * The storage format is NOT changed — we only normalize at lookup time.
 */
export function lookupAttributeByNormalizedKey(
  attributes: Record<string, unknown>,
  rawKey: string,
): unknown {
  const normalizedTarget = normalizeSupersessionKey(rawKey);
  for (const [k, v] of Object.entries(attributes)) {
    if (normalizeSupersessionKey(k) === normalizedTarget) return v;
  }
  return undefined;
}

/**
 * Decide whether an existing memory should be superseded by a newly-written
 * memory that carries the supplied supersession key set.
 *
 * Only memories that:
 *  - are currently `active`
 *  - share an `entityRef` with the new fact
 *  - share at least one supersession key with the new fact
 *  - are older than the new fact
 *  - have a conflicting value (different string) for the overlapping key
 * are eligible.  This keeps supersession local to the attribute that actually
 * changed — if fact A sets `{city: Austin, tool: vim}` and fact B sets
 * `{city: NYC}`, only the city attribute is superseded, not the tool.
 */
export function shouldSupersedeExisting(args: {
  candidate: MemoryFrontmatter;
  newEntityRef: string;
  newAttributes: Record<string, string>;
  newCreatedAt: string;
  newMemoryId: string;
}): { matchedKeys: string[] } | null {
  const { candidate, newEntityRef, newAttributes, newCreatedAt, newMemoryId } = args;

  if (candidate.id === newMemoryId) return null;
  if (candidate.status && candidate.status !== "active") return null;
  if (!candidate.entityRef) return null;
  if (!candidate.structuredAttributes) return null;

  const candidateEntityNorm = normalizeSupersessionKey(candidate.entityRef);
  const newEntityNorm = normalizeSupersessionKey(newEntityRef);
  if (candidateEntityNorm !== newEntityNorm) return null;

  const candidateCreated = Date.parse(effectiveValidAt(candidate));
  const newCreated = Date.parse(newCreatedAt);
  if (!Number.isFinite(candidateCreated) || !Number.isFinite(newCreated)) return null;
  if (candidateCreated >= newCreated) return null;

  const matchedKeys: string[] = [];
  for (const [attrName, newValue] of Object.entries(newAttributes)) {
    const candidateValue = lookupAttributeByNormalizedKey(
      candidate.structuredAttributes,
      attrName,
    );
    if (candidateValue === undefined) continue;
    if (normalizeValue(String(candidateValue)) === normalizeValue(newValue)) continue;
    const key = computeSupersessionKey(newEntityRef, attrName);
    if (key) matchedKeys.push(key);
  }

  return matchedKeys.length > 0 ? { matchedKeys } : null;
}

function normalizeValue(v: string): string {
  return v.trim().toLowerCase();
}
function temporalSupersessionOperationKey(
  sourceMemoryId: string,
  replacementId: string,
  mutation: TemporalSupersessionMutation,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceMemoryId,
        replacementId,
        cause: "temporal_supersession",
        supersededAt: mutation.supersededAt,
        invalidAt: mutation.invalidAt ?? null,
        matchedKeys: [...mutation.matchedKeys].sort(compareByteStable),
      }),
    )
    .digest("hex");
}
type TemporalMemorySnapshot = Pick<MemoryFile, "content" | "frontmatter">;
function compareByteStable(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function canonicalTemporalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalTemporalValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareByteStable(left, right))
        .map(([key, entry]) => [key, canonicalTemporalValue(entry)]),
    );
  }
  return value;
}

function temporalSnapshotKey(memory: TemporalMemorySnapshot): string {
  return JSON.stringify(
    canonicalTemporalValue({
      content: memory.content,
      frontmatter: memory.frontmatter,
    }),
  );
}

function temporalMutationPatch(
  replacementId: string,
  mutation: TemporalSupersessionMutation,
): Partial<MemoryFrontmatter> {
  return {
    status: "superseded",
    supersededBy: replacementId,
    supersededAt: mutation.supersededAt,
    updated: mutation.supersededAt,
    ...(mutation.invalidAt ? { invalid_at: mutation.invalidAt } : {}),
  };
}

type TemporalPrimaryCommitState = "committed" | "not-committed" | "unknown";

async function classifyTemporalPrimaryMutation(args: {
  storage: TemporalSupersessionStorage;
  path: string;
  before: TemporalMemorySnapshot;
  patch: Partial<MemoryFrontmatter>;
}): Promise<TemporalPrimaryCommitState> {
  let current: MemoryFile | null;
  try {
    current = await args.storage.readMemoryByPath(args.path);
  } catch {
    return "unknown";
  }
  if (!current) return "unknown";
  const beforeKey = temporalSnapshotKey(args.before);
  const committedKey = temporalSnapshotKey({
    content: args.before.content,
    frontmatter: { ...args.before.frontmatter, ...args.patch },
  });
  const currentKey = temporalSnapshotKey(current);
  if (currentKey === committedKey) return "committed";
  if (currentKey === beforeKey) return "not-committed";
  return "unknown";
}
type PreparedTemporalPropagation = {
  delivery: DependencyPropagationDeliveryPort;
  event: PropagationEvent;
  token: DependencyPropagationPreparationToken | null;
};

async function settleTemporalPropagationAfterPrimaryFailure(
  pending: PreparedTemporalPropagation,
  commitState: TemporalPrimaryCommitState,
  memoryId: string,
): Promise<void> {
  let token = pending.token;
  if (commitState === "not-committed") {
    if (token !== null) {
      try {
        await pending.delivery.cancel(token);
      } catch (error) {
        log.warn(
          `temporal-supersession: dependency propagation cancellation failed for ${memoryId}: ${error}`,
        );
      }
    }
    return;
  }
  if (token === null && (commitState === "committed" || commitState === "unknown")) {
    try {
      token = await pending.delivery.prepare(pending.event);
    } catch (error) {
      log.warn(
        `temporal-supersession: dependency propagation recovery preparation failed for ${memoryId}: ${error}`,
      );
    }
  }
  if (token !== null) {
    try {
      await pending.delivery.deferPrepared(token);
    } catch (error) {
      log.warn(`temporal-supersession: dependency propagation defer failed for ${memoryId}: ${error}`);
    }
    return;
  }
  if (commitState === "committed") {
    try {
      await pending.delivery.afterMutation(null, pending.event);
    } catch (error) {
      log.warn(`temporal-supersession: dependency propagation fallback failed for ${memoryId}: ${error}`);
    }
  }
}


async function hasTemporalLifecycleEffect(args: {
  storage: TemporalSupersessionStorage;
  memoryId: string;
  timestamp: string;
  operationKey: string;
  reasonCode: string;
  relatedMemoryIds: string[];
}): Promise<boolean> {
  const events = await args.storage.getMemoryTimeline(args.memoryId, 200);
  return events.some((event) => {
    if (
      event.memoryId !== args.memoryId ||
      (event.eventType !== "superseded" && event.eventType !== "updated") ||
      event.timestamp !== args.timestamp ||
      event.after?.status !== "superseded"
    ) {
      return false;
    }
    if (event.correlationId !== undefined) return event.correlationId === args.operationKey;
    // Rows written before correlation IDs existed can be replayed only with
    // their complete legacy identity. New rows always take the exact branch.
    return (
      event.reasonCode === args.reasonCode &&
      Array.isArray(event.relatedMemoryIds) &&
      event.relatedMemoryIds.length === args.relatedMemoryIds.length &&
      event.relatedMemoryIds.every((memoryId, index) => memoryId === args.relatedMemoryIds[index])
    );
  });
}

async function hasTemporalTombstoneEffect(args: {
  storage: TemporalSupersessionStorage;
  oldMemory: MemoryFile;
  supersessionKey?: string;
  operationKey: string;
  createdAt: string;
}): Promise<boolean> {
  if (!args.storage.hasExactTombstone) return false;
  return args.storage.hasExactTombstone({
    sourceMemoryId: args.oldMemory.frontmatter.id,
    ...(args.oldMemory.frontmatter.contentHash
      ? { contentHash: args.oldMemory.frontmatter.contentHash }
      : {}),
    ...(args.oldMemory.frontmatter.entityRef
      ? { entityRef: args.oldMemory.frontmatter.entityRef }
      : {}),
    ...(args.supersessionKey ? { supersessionKey: args.supersessionKey } : {}),
    createdAt: args.createdAt,
    operationKey: args.operationKey,
  });
}


async function ensureTemporalLifecycleEffect(args: {
  storage: TemporalSupersessionStorage;
  memory: MemoryFile;
  replacementId: string;
  mutation: TemporalSupersessionMutation;
  operationKey: string;
  child?: boolean;
}): Promise<boolean> {
  const reasonCode = args.child
    ? "structured-attribute-update-child-chunk"
    : "structured-attribute-update";
  const relatedMemoryIds = args.child
    ? [args.replacementId, args.memory.frontmatter.parentId ?? ""].filter(Boolean)
    : [args.replacementId];
  const lifecycleEffect = await hasTemporalLifecycleEffect({
    storage: args.storage,
    memoryId: args.memory.frontmatter.id,
    timestamp: args.mutation.supersededAt,
    operationKey: args.operationKey,
    reasonCode,
    relatedMemoryIds,
  });
  if (lifecycleEffect === undefined) return false;
  if (lifecycleEffect === true) return true;
  if (lifecycleEffect === false || args.memory.frontmatter.status !== "superseded") {
    if (!args.storage.writeMemoryFrontmatterIfUnchanged) return false;
    const wrote = await args.storage.writeMemoryFrontmatterIfUnchanged(
      args.memory,
      {
        status: "superseded",
        supersededBy: args.replacementId,
        supersededAt: args.mutation.supersededAt,
        updated: args.mutation.supersededAt,
        ...(args.mutation.invalidAt && !args.memory.frontmatter.invalid_at
          ? { invalid_at: args.mutation.invalidAt }
          : {}),
      },
      {
        actor: "temporal-supersession",
        reasonCode: args.child
          ? "structured-attribute-update-child-chunk"
          : "structured-attribute-update",
        relatedMemoryIds: args.child
          ? [args.replacementId, args.memory.frontmatter.parentId ?? ""].filter(Boolean)
          : [args.replacementId],
        correlationId: args.operationKey,
      },
    );
    return wrote;
  }
  return true;
}

async function expireChildChunksForSupersededParent(args: {
  storage: TemporalSupersessionStorage;
  allCandidates: MemoryFile[];
  parentId: string;
  newMemoryId: string;
  supersededAt: string;
  invalidAt?: string;
  operationKey: string;
}): Promise<boolean> {
  const processedChunkIds = new Set<string>();
  const chunks = args.allCandidates.filter(
    (candidate) => candidate.frontmatter.parentId === args.parentId,
  );

  for (const chunk of chunks) {
    const chunkKey = chunk.frontmatter.id ?? chunk.path;
    if (processedChunkIds.has(chunkKey)) continue;

    try {
      const freshChunk = await args.storage.readMemoryByPath(chunk.path);
      if (!freshChunk) continue;
      processedChunkIds.add(chunkKey);
      const freshStatus = freshChunk.frontmatter.status ?? "active";
      if (
        freshStatus !== "active" &&
        !(
          freshStatus === "superseded" &&
          freshChunk.frontmatter.supersededBy === args.newMemoryId
        )
      ) {
        continue;
      }
      const completed = await ensureTemporalLifecycleEffect({
        storage: args.storage,
        memory: freshChunk,
        replacementId: args.newMemoryId,
        mutation: {
          supersededAt: args.supersededAt,
          ...(args.invalidAt ? { invalidAt: args.invalidAt } : {}),
          matchedKeys: [],
        },
        operationKey: `${args.operationKey}:child:${freshChunk.frontmatter.id}`,
        child: true,
      });
      if (!completed) return false;
    } catch (err) {
      log.warn(
        `temporal-supersession: failed to expire child chunk ${chunk.frontmatter.id} for parent ${args.parentId}: ${err}`,
      );
      return false;
    }
  }
  return true;
}

export interface TemporalSupersessionMutation {
  supersededAt: string;
  invalidAt?: string;
  matchedKeys: string[];
}

export async function applyTemporalSupersessionPrimaryMutation(args: {
  storage: TemporalSupersessionStorage;
  oldMemory: MemoryFile;
  replacementId: string;
  mutation: TemporalSupersessionMutation;
  allCandidates?: MemoryFile[];
}): Promise<boolean> {
  const { storage, oldMemory, replacementId, mutation } = args;
  if (typeof storage.getMemoryTimeline !== "function") {
    log.warn("temporal-supersession: required memory timeline adapter is missing");
    return false;
  }
  const operationKey = temporalSupersessionOperationKey(
    oldMemory.frontmatter.id,
    replacementId,
    mutation,
  );
  const alreadyApplied =
    oldMemory.frontmatter.status === "superseded" &&
    oldMemory.frontmatter.supersededBy === replacementId &&
    oldMemory.frontmatter.supersededAt === mutation.supersededAt &&
    (mutation.invalidAt === undefined || oldMemory.frontmatter.invalid_at === mutation.invalidAt);
  const lifecycleEffect = alreadyApplied
    ? await hasTemporalLifecycleEffect({
        storage,
        memoryId: oldMemory.frontmatter.id,
        timestamp: mutation.supersededAt,
        operationKey,
        reasonCode: "structured-attribute-update",
        relatedMemoryIds: [replacementId],
      })
    : undefined;
  if (alreadyApplied && lifecycleEffect === undefined) return false;
  if (!alreadyApplied || lifecycleEffect === false) {
    if (!storage.writeMemoryFrontmatterIfUnchanged) return false;
    const wrote = await storage.writeMemoryFrontmatterIfUnchanged(
      oldMemory,
      temporalMutationPatch(replacementId, mutation),
      {
        actor: "temporal-supersession",
        reasonCode: "structured-attribute-update",
        relatedMemoryIds: [replacementId],
        correlationId: operationKey,
      },
    );
    if (!wrote) return false;
  }

  let allCandidates = args.allCandidates;
  if (!allCandidates) {
    let hotMemories: MemoryFile[];
    let coldMemories: MemoryFile[];
    try {
      hotMemories = await storage.readAllMemories();
    } catch (error) {
      log.warn(`temporal-supersession: recovery hot-memory scan failed: ${error}`);
      return false;
    }
    try {
      coldMemories = await storage.readAllColdMemories();
    } catch (error) {
      log.warn(`temporal-supersession: recovery cold-memory scan failed: ${error}`);
      return false;
    }
    allCandidates = [...hotMemories, ...coldMemories];
  }
  const childrenCompleted = await expireChildChunksForSupersededParent({
    storage,
    allCandidates,
    parentId: oldMemory.frontmatter.id,
    newMemoryId: replacementId,
    supersededAt: mutation.supersededAt,
    invalidAt: mutation.invalidAt ?? oldMemory.frontmatter.invalid_at,
    operationKey,
  });
  if (!childrenCompleted) return false;

  const keysToTombstone =
    mutation.matchedKeys.length > 0 ? mutation.matchedKeys : [undefined];
  for (const key of keysToTombstone) {
    const tombstoneOperationKey = `${operationKey}:tombstone:${key ?? "content"}`;
    if (
      await hasTemporalTombstoneEffect({
        storage,
        oldMemory,
        supersessionKey: key,
        operationKey: tombstoneOperationKey,
        createdAt: mutation.supersededAt,
      })
    ) {
      continue;
    }
    try {
      const tombstoneId = await storage.appendTombstone({
        reason: "supersession",
        createdBy: "supersession",
        sourceMemoryId: oldMemory.frontmatter.id,
        ...(oldMemory.frontmatter.contentHash
          ? { contentHash: oldMemory.frontmatter.contentHash }
          : {}),
        rawContent: oldMemory.content,
        ...(oldMemory.frontmatter.entityRef ? { entityRef: oldMemory.frontmatter.entityRef } : {}),
        ...(key ? { supersessionKey: key } : {}),
        createdAt: mutation.supersededAt,
        operationKey: tombstoneOperationKey,
      });
      if (tombstoneId === null && storage.isTombstonesEnabled?.() !== false) {
        return false;
      }
    } catch (error) {
      log.warn(
        `temporal-supersession: tombstone emit failed for ${oldMemory.frontmatter.id}${key ? ` (key=${key})` : ""} : ${error}`,
      );
      return false;
    }
  }
  return true;
}

export interface TemporalSupersessionResult {
  supersededIds: string[];
  matchedKeys: string[];
}

/**
 * Scan existing memories and mark any that are superseded by the
 * just-written memory.  Fails open on I/O errors — the new memory is already
 * on disk, and supersession is a best-effort hygiene step.
 */
export async function applyTemporalSupersession(args: {
  storage: TemporalSupersessionStorage;
  newMemoryId: string;
  entityRef?: string;
  structuredAttributes?: Record<string, string>;
  createdAt: string;
  enabled: boolean;
  /**
   * When true, skip the persisted `frontmatter.created` lookup and use
   * `args.createdAt` directly as the ordering anchor.  Set this on the
   * hash-dedup short-circuit path where `newMemoryId` points to an existing
   * OLD fact (no new file is written) and its persisted timestamp would be
   * stale relative to the incoming promotion event (PR #402 Finding Uyui).
   */
  useCallerTimestamp?: boolean;
  /** Namespace used by the dependency propagation worker. */
  namespaceScope?: string;
  /** Optional durable delivery for one-hop propagation. */
  dependencyPropagationDelivery?: DependencyPropagationDeliveryPort;
}): Promise<TemporalSupersessionResult> {
  const empty: TemporalSupersessionResult = { supersededIds: [], matchedKeys: [] };
  const createdAtMs = typeof args.createdAt === "string" ? Date.parse(args.createdAt) : Number.NaN;
  if (!Number.isFinite(createdAtMs)) {
    log.warn(`temporal-supersession: refusing mutation with invalid createdAt: ${String(args.createdAt)}`);
    return empty;
  }
  if (!args.enabled) return empty;
  if (!args.entityRef) return empty;
  if (!args.structuredAttributes) return empty;
  if (Object.keys(args.structuredAttributes).length === 0) return empty;
  if (typeof args.storage.getMemoryTimeline !== "function") {
    log.warn("temporal-supersession: required memory timeline adapter is missing");
    return empty;
  }

  const newKeys = supersessionKeysForFact({
    entityRef: args.entityRef,
    structuredAttributes: args.structuredAttributes,
  });
  if (newKeys.length === 0) return empty;

  let hotMemories: MemoryFile[];
  try {
    hotMemories = await args.storage.readAllMemories();
  } catch (err) {
    log.warn(`temporal-supersession: readAllMemories failed: ${err}`);
    return empty;
  }

  const newMemoryFile = hotMemories.find((m) => m.frontmatter.id === args.newMemoryId);
  const persistedCreatedAt = args.useCallerTimestamp
    ? args.createdAt
    : (newMemoryFile ? effectiveValidAt(newMemoryFile.frontmatter) : args.createdAt);

  const supersededIds: string[] = [];
  const matchedKeys = new Set<string>();

  const processedIds = new Set<string>();

  //
  //

  let coldMemories: MemoryFile[];
  try {
    coldMemories = await args.storage.readAllColdMemories();
  } catch (err) {
    log.warn(`temporal-supersession: readAllColdMemories failed: ${err}`);
    coldMemories = [];
  }

  const allCandidates: MemoryFile[] = [...hotMemories, ...coldMemories];
  const replacementMemory =
    allCandidates.find((memory) => memory.frontmatter.id === args.newMemoryId) ?? newMemoryFile;

  for (const memory of allCandidates) {
    if (memory.frontmatter.id === args.newMemoryId) continue;
    const dedupeKey = memory.frontmatter.id ?? memory.path;
    if (processedIds.has(dedupeKey)) continue;
    const snapshotStatus = memory.frontmatter.status ?? "active";
    if (snapshotStatus !== "active") {
      continue;
    }

    const decision = shouldSupersedeExisting({
      candidate: memory.frontmatter,
      newEntityRef: args.entityRef,
      newAttributes: args.structuredAttributes,
      newCreatedAt: persistedCreatedAt,
      newMemoryId: args.newMemoryId,
    });
    if (!decision) {
      processedIds.add(dedupeKey);
      continue;
    }

    let preparedPropagation: {
      delivery: DependencyPropagationDeliveryPort;
      event: PropagationEvent;
      token: DependencyPropagationPreparationToken | null;
    } | null = null;
    let primaryPath: string | null = null;
    let primaryBefore: TemporalMemorySnapshot | null = null;
    let primaryPatch: Partial<MemoryFrontmatter> | null = null;
    try {
      //
      const fresh = await args.storage.readMemoryByPath(memory.path);
      if (!fresh) {
        log.debug(
          `[engram] temporal supersession skipped candidate ${memory.frontmatter.id}: no longer readable at ${memory.path} — leaving id available for alternate tier`,
        );
        continue;
      }
      processedIds.add(dedupeKey);
      const freshStatus = fresh.frontmatter.status ?? "active";
      if (freshStatus !== "active" || fresh.frontmatter.supersededBy) {
        log.debug(
          `[engram] temporal supersession skipped candidate ${memory.frontmatter.id}: already superseded by concurrent writer`,
        );
        continue;
      }
      primaryPath = fresh.path;
      primaryBefore = {
        content: fresh.content,
        frontmatter: { ...fresh.frontmatter },
      };

      const oldCreatedMs = new Date(fresh.frontmatter.created).getTime();
      const newCreatedMs = new Date(persistedCreatedAt).getTime();
      const argCreatedMs = new Date(args.createdAt).getTime();
      const maxMs = Math.max(
        Number.isFinite(oldCreatedMs) ? oldCreatedMs : 0,
        Number.isFinite(newCreatedMs) ? newCreatedMs : 0,
        Number.isFinite(argCreatedMs) ? argCreatedMs : 0,
      );
      const supersededAt = new Date(maxMs).toISOString();

      //
      let invalidAtPatch: string | undefined;
      if (!fresh.frontmatter.invalid_at) {
        if (args.useCallerTimestamp) {
          invalidAtPatch = persistedCreatedAt;
        } else {
          const newValidAt = replacementMemory?.frontmatter.valid_at?.trim();
          invalidAtPatch =
            newValidAt && newValidAt.length > 0 ? newValidAt : persistedCreatedAt;
        }
      }
      const mutation: TemporalSupersessionMutation = {
        supersededAt,
        ...(invalidAtPatch ? { invalidAt: invalidAtPatch } : {}),
        matchedKeys: decision.matchedKeys,
      };
      primaryPatch = temporalMutationPatch(args.newMemoryId, mutation);
      const propagationEvent: PropagationEvent | null =
        args.dependencyPropagationDelivery && args.namespaceScope
          ? {
              oldMemory: {
                content: fresh.content,
                frontmatter: {
                  ...fresh.frontmatter,
                  ...(fresh.frontmatter.links
                    ? { links: fresh.frontmatter.links.map((link) => ({ ...link })) }
                    : {}),
                },
              },
              replacementId: args.newMemoryId,
              replacementContent: replacementMemory?.content ?? null,
              cause: "temporal_supersession",
              namespaceScope: args.namespaceScope,
              temporalMutation: mutation,
            }
          : null;
      if (propagationEvent && args.dependencyPropagationDelivery) {
        preparedPropagation = {
          delivery: args.dependencyPropagationDelivery,
          event: propagationEvent,
          token: null,
        };
        try {
          preparedPropagation.token =
            await args.dependencyPropagationDelivery.prepare(propagationEvent);
        } catch (prepareErr) {
          log.warn(
            `temporal-supersession: dependency propagation preparation failed for ${fresh.frontmatter.id}: ${prepareErr}`,
          );
        }
      }
      const wrote = await applyTemporalSupersessionPrimaryMutation({
        storage: args.storage,
        oldMemory: fresh,
        replacementId: args.newMemoryId,
        mutation,
        allCandidates,
      });
      if (!wrote) {
        const commitState = await classifyTemporalPrimaryMutation({
          storage: args.storage,
          path: fresh.path,
          before: primaryBefore,
          patch: primaryPatch,
        });
        if (preparedPropagation) {
          await settleTemporalPropagationAfterPrimaryFailure(
            preparedPropagation,
            commitState,
            fresh.frontmatter.id,
          );
          if (commitState !== "not-committed") {
            log.warn(
              `temporal-supersession: retaining dependency propagation recovery for ${fresh.frontmatter.id} after ${commitState} primary mutation`,
            );
          }
        }
        preparedPropagation = null;
        continue;
      }
      if (preparedPropagation) {
        const completedPropagation = preparedPropagation;
        preparedPropagation = null;
        try {
          await completedPropagation.delivery.afterMutation(
            completedPropagation.token,
            completedPropagation.event,
          );
        } catch (afterMutationErr) {
          log.warn(
            `temporal-supersession: dependency propagation delivery failed for ${memory.frontmatter.id}: ${afterMutationErr}`,
          );
        }
      }
      supersededIds.push(memory.frontmatter.id);
      for (const key of decision.matchedKeys) matchedKeys.add(key);
    } catch (err) {
      let commitState: TemporalPrimaryCommitState = "unknown";
      if (primaryPath && primaryBefore && primaryPatch) {
        commitState = await classifyTemporalPrimaryMutation({
          storage: args.storage,
          path: primaryPath,
          before: primaryBefore,
          patch: primaryPatch,
        });
      }
      if (preparedPropagation) {
        await settleTemporalPropagationAfterPrimaryFailure(
          preparedPropagation,
          commitState,
          memory.frontmatter.id,
        );
        if (commitState !== "not-committed") {
          log.warn(
            `temporal-supersession: retaining dependency propagation recovery for ${memory.frontmatter.id} after ${commitState} primary mutation`,
          );
        }
      }
      preparedPropagation = null;
      log.warn(
        `temporal-supersession: failed to mark ${memory.frontmatter.id} superseded: ${err}`,
      );
    }
  }

  if (supersededIds.length > 0) {
    log.debug(
      `temporal-supersession: marked ${supersededIds.length} memories superseded by ${args.newMemoryId} (keys=${Array.from(matchedKeys).join(",")})`,
    );
  }

  return { supersededIds, matchedKeys: Array.from(matchedKeys) };
}

/**
 * Recall-side filter: returns true when the candidate should be excluded
 * from recall because it has been temporally superseded.  When
 * `includeInRecall` is true, this always returns false (the fact is kept),
 * matching the audit/history opt-in described in the config.
 */
export function shouldFilterSupersededFromRecall(
  frontmatter: MemoryFrontmatter,
  options: { enabled: boolean; includeInRecall: boolean },
): boolean {
  if (!options.enabled) return false;
  if (options.includeInRecall) return false;
  return frontmatter.status === "superseded";
}
