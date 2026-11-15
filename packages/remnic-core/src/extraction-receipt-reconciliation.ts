import { syncReceiptArtifact } from "./extraction-receipt-artifact-sync.js";
/** Recover only effects whose exact provenance was committed in the actual fact. */
import { type ReceiptPlan, receiptHash, receiptMemoryDigest } from "./extraction-receipt-provenance.js";
import type { ArtifactEvidence, ArtifactJournal, AttemptToken, ExtractionReceiptStore } from "./extraction-receipts.js";
import type { StorageManager } from "./storage.js";
import {
  buildCapturePathLockIdentity,
  buildExplicitCaptureDedupKey,
} from "./storage/tombstone-blocked-capture-mutation.js";
import type { MemoryFile } from "./types.js";

export interface RecoveredReceiptFact {
  memory: MemoryFile;
  journalId: string;
  evidence: ArtifactEvidence;
}
export async function reconcileReceiptFacts(
  store: ExtractionReceiptStore,
  token: AttemptToken,
  plan: ReceiptPlan,
  storage: StorageManager
): Promise<{
  artifacts: ArtifactEvidence[];
  complete: boolean;
  fresh?: boolean;
  facts?: Map<string, RecoveredReceiptFact>;
}> {
  const journals = new Map<string, ArtifactJournal>();
  for (const member of token.members) {
    const receipt = await store.get(member.receiptId);
    const state = receipt?.members.find((m) => m.memberId === member.memberId);
    if (!state || state.plan?.digest !== plan.digest) return { artifacts: [], complete: false };
    for (const journal of state.journal) journals.set(journal.journalId, journal);
  }
  if (!journals.size) return { artifacts: [], complete: false, fresh: true };
  const memories = await storage.readAllMemories();
  const artifacts: ArtifactEvidence[] = [];
  const facts = new Map<string, RecoveredReceiptFact>();
  const slots = new Set<string>();
  let incomplete = false;
  for (const journal of journals.values()) {
    const effect = journal.effect;
    if (
      !effect ||
      effect.planDigest !== plan.digest ||
      effect.identityDigest !== plan.identityDigest ||
      !plan.slots.includes(effect.slot) ||
      journal.artifact.namespace !== effect.namespace
    ) {
      incomplete = true;
      continue;
    }
    if (
      receiptHash(
        effect.members
          .map(({ receiptId, memberId }) => ({ receiptId, memberId }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      ) !== receiptHash(plan.members)
    ) {
      incomplete = true;
      continue;
    }
    const matches = memories.filter((m) =>
      m.frontmatter.extractionEffects?.some((e) => e.journalId === journal.journalId)
    );
    if (matches.length !== 1) {
      incomplete = true;
      continue;
    }
    const memory = matches[0]!;
    const provenance = memory.frontmatter.extractionEffects?.find((e) => e.journalId === journal.journalId);
    if (
      !provenance ||
      receiptHash({ ...provenance, effectDigest: undefined }) !== receiptHash(effect) ||
      provenance.effectDigest !== receiptMemoryDigest(memory.frontmatter, memory.content) ||
      memory.frontmatter.category !== "fact" ||
      (memory.frontmatter.status ?? "active") !== "active" ||
      memory.frontmatter.expiresAt ||
      memory.frontmatter.valid_at ||
      memory.frontmatter.invalid_at ||
      memory.frontmatter.tags.includes("chunked") ||
      memory.frontmatter.parentId ||
      memory.frontmatter.chunkIndex !== undefined ||
      memory.frontmatter.chunkTotal !== undefined ||
      memory.frontmatter.entityRef ||
      memory.frontmatter.structuredAttributes ||
      memory.frontmatter.sourceMemoryId ||
      /[\\/]artifacts[\\/]/.test(memory.path) ||
      memory.frontmatter.artifactType ||
      memory.frontmatter.source === "artifact"
    ) {
      incomplete = true;
      continue;
    }
    const evidence: ArtifactEvidence = {
      kind: "memory",
      namespace: effect.namespace,
      id: memory.frontmatter.id,
      disposition: journal.artifact.disposition,
      effectDigest: provenance.effectDigest,
    };
    await confirmReceiptMemory(store, token, journal.journalId, evidence, storage, memory);
    artifacts.push(evidence);
    facts.set(effect.slot, { memory, journalId: journal.journalId, evidence });
    slots.add(effect.slot);
  }
  return { artifacts, complete: !incomplete && plan.slots.every((slot) => slots.has(slot)), facts };
}

/** Lock order: optional fact-dedup window -> receipt store -> capture mutation. */
export async function confirmReceiptMemory(
  store: ExtractionReceiptStore,
  token: AttemptToken,
  journalId: string,
  evidence: ArtifactEvidence,
  storage: StorageManager,
  memory: MemoryFile
): Promise<void> {
  await store.confirmArtifact(token, journalId, evidence, (commit) =>
    storage.withTombstoneBlockedCaptureWriteLock(async () => {
      const current = await storage.readMemoryByPath(memory.path);
      if (!current || receiptHash(current) !== receiptHash(memory))
        throw new Error("Receipt artifact changed before confirmation");
      if (!(await syncReceiptArtifact(storage, "memory", evidence.id, { id: evidence.id, memory: current })))
        throw new Error("Receipt artifact sync failed");
      await commit();
    }, [
      buildCapturePathLockIdentity(memory.path),
      buildExplicitCaptureDedupKey(memory.content, memory.frontmatter.category, memory.frontmatter.sourceConnector),
    ])
  );
}
