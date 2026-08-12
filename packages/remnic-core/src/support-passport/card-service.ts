import path from "node:path";

import type { StorageManager } from "../index.js";
import { log } from "../logger.js";
import type { MemoryFile } from "../types.js";
import { serializeMutations, withHeldFileLock } from "../utils/serialize-mutations.js";
import { composeMemoryEnvelope } from "../write-envelope.js";
import {
  SUPPORT_PASSPORT_ATTRIBUTE_KEYS,
  SUPPORT_PASSPORT_CARD_TAG,
  type StoredSupportPassportCard,
  projectSupportPassportCard,
} from "./card-projection.js";
import {
  type SupportPassportCard,
  type SupportPassportCardCategory,
  SupportPassportCardListSchema,
  type SupportPassportCardMutationInput,
  SupportPassportCardMutationInputSchema,
  SupportPassportListCardsInputSchema,
  type SupportPassportManualDraftInput,
  SupportPassportManualDraftInputSchema,
  type SupportPassportReplaceCardInput,
  SupportPassportReplaceCardInputSchema,
  computeSupportPassportCardRevision,
} from "./contracts.js";
import { SupportPassportError } from "./errors.js";

export interface SupportPassportOwnerScope {
  namespace: string;
  storage: StorageManager;
}

export interface SupportPassportCardServiceDependencies {
  resolveOwner(principal: string): Promise<SupportPassportOwnerScope>;
  now?: () => Date;
}

const OWNER_VISIBLE_STATUSES = new Set(["pending_review", "active"]);
const MAX_OWNER_VISIBLE_CARDS = 100;
const CARD_MUTATION_LOCK_STALE_MS = 60_000;
const CARD_MUTATION_LOCK_MAX_WAIT_MS = 30_000;

function invalidInput(): SupportPassportError {
  return new SupportPassportError("invalid_input", "The support card request is invalid.", 400);
}

export class SupportPassportCardService {
  private readonly resolveOwner: SupportPassportCardServiceDependencies["resolveOwner"];
  private readonly now: () => Date;

  constructor(dependencies: SupportPassportCardServiceDependencies) {
    this.resolveOwner = dependencies.resolveOwner;
    this.now = dependencies.now ?? (() => new Date());
  }

  async listCards(input: { principal: string }): Promise<SupportPassportCard[]> {
    const parsed = SupportPassportListCardsInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { storage } = await this.resolveOwner(parsed.data.principal);
    return await this.withOwnerLock(storage, async () => {
      const stored = await this.readStoredCards(storage);
      const cards = stored
        .filter((item) => OWNER_VISIBLE_STATUSES.has(item.card.status))
        .sort((a, b) => a.order - b.order || a.card.cardId.localeCompare(b.card.cardId))
        .map((item) => item.card);
      const output = SupportPassportCardListSchema.safeParse(cards);
      if (!output.success) {
        throw new SupportPassportError("card_data_invalid", "The support card data is invalid.", 500);
      }
      return output.data;
    });
  }

  async createManualDraft(input: SupportPassportManualDraftInput): Promise<SupportPassportCard> {
    const parsed = SupportPassportManualDraftInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { storage } = await this.resolveOwner(parsed.data.principal);
    return await this.withOwnerLock(storage, () =>
      this.createDraft(storage, {
        title: parsed.data.title,
        statement: parsed.data.statement,
        category: parsed.data.category,
        reviewBy: parsed.data.reviewBy,
        sourceMemoryIds: [],
      })
    );
  }

  async replaceCard(input: SupportPassportReplaceCardInput): Promise<SupportPassportCard> {
    const parsed = SupportPassportReplaceCardInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { storage } = await this.resolveOwner(parsed.data.principal);
    return await this.withOwnerLock(storage, async () => {
      const loadedPrior = await this.requireCard(storage, parsed.data.cardId);
      this.requireRevision(loadedPrior, parsed.data.expectedRevision);
      if (loadedPrior.card.status === "pending_review" || loadedPrior.card.status === "active") {
        const storedCards = await this.readStoredCards(storage);
        const interruptedReplacements = storedCards.filter(
          (item) =>
            item.card.status === "pending_review" &&
            (loadedPrior.card.status === "pending_review"
              ? item.replacesDraftId === loadedPrior.card.cardId
              : item.memory.frontmatter.supersedes === loadedPrior.card.cardId)
        );
        if (interruptedReplacements.length > 1) {
          throw new SupportPassportError(
            "storage_conflict",
            "Multiple support card edits already completed. Reload the support passport.",
            409
          );
        }
        const [interruptedReplacement] = interruptedReplacements;
        if (interruptedReplacement) {
          const matchesRetry =
            interruptedReplacement.card.title === parsed.data.title &&
            interruptedReplacement.card.statement === parsed.data.statement &&
            interruptedReplacement.card.category === parsed.data.category &&
            interruptedReplacement.card.reviewBy === parsed.data.reviewBy;
          if (!matchesRetry) {
            throw new SupportPassportError(
              "storage_conflict",
              "A different support card edit already completed. Reload the support passport.",
              409
            );
          }
          return interruptedReplacement.card;
        }
      }
      const refreshedPrior = await this.requireCard(storage, parsed.data.cardId);
      this.requireRevision(refreshedPrior, parsed.data.expectedRevision);
      const recoveredMemory = await this.recoverReplacementTransition(storage, refreshedPrior.memory);
      const prior = this.projectRequiredCard(recoveredMemory);
      if (prior.card.status !== "active" && prior.card.status !== "pending_review") {
        throw new SupportPassportError(
          "invalid_card_status",
          "Only a draft or approved support card can be edited.",
          409
        );
      }
      const replacement = await this.createDraft(storage, {
        title: parsed.data.title,
        statement: parsed.data.statement,
        category: parsed.data.category,
        reviewBy: parsed.data.reviewBy,
        sourceMemoryIds: prior.sourceMemoryIds,
        supersedes: prior.card.status === "active" ? prior.card.cardId : prior.memory.frontmatter.supersedes,
        replacesDraftId: prior.card.status === "pending_review" ? prior.card.cardId : undefined,
        order: prior.order,
      });
      if (prior.card.status === "active") return replacement;

      const replacedAt = this.now().toISOString();
      const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
        prior.memory,
        { status: "rejected", updated: replacedAt },
        { actor: "support-passport.replace-draft", reasonCode: "owner-replaced-draft" }
      );
      if (rejected) return replacement;
      const currentPrior = await storage.getMemoryById(prior.card.cardId);
      if (currentPrior?.frontmatter.status === "rejected") return replacement;

      await this.rejectCreatedDraft(storage, replacement.cardId, "draft-replacement-failed");
      throw new SupportPassportError("storage_conflict", "The support card changed before it was edited.", 409);
    });
  }

  async approveCard(input: SupportPassportCardMutationInput): Promise<SupportPassportCard> {
    const parsed = SupportPassportCardMutationInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { storage } = await this.resolveOwner(parsed.data.principal);
    return await this.withOwnerLock(storage, async () => {
      const loadedCard = await this.requireCard(storage, parsed.data.cardId);
      this.requireRevision(loadedCard, parsed.data.expectedRevision);
      this.requireStatus(loadedCard, "pending_review");
      const recoveredMemory = await this.recoverReplacementTransition(storage, loadedCard.memory);
      const card = this.projectRequiredCard(recoveredMemory);
      if (card.card.status === "active") return card.card;
      this.requireStatus(card, "pending_review");
      const retiredPriorId = await this.preparePriorForReplacement(storage, card);
      const updatedAt = this.now().toISOString();
      let approved: boolean;
      try {
        approved = await storage.writeMemoryFrontmatterIfUnchanged(
          card.memory,
          { status: "active", updated: updatedAt },
          { actor: "support-passport.approve", reasonCode: "owner-approved" }
        );
      } catch (error) {
        if (retiredPriorId) {
          const current = await storage.getMemoryById(card.card.cardId);
          const currentCard = current ? projectSupportPassportCard(current) : null;
          if (currentCard?.card.status === "active") {
            await this.completePriorRetirement(storage, retiredPriorId, card.card.cardId);
            return currentCard.card;
          }
          await this.restorePriorAfterApprovalFailure(storage, retiredPriorId, card.card.cardId);
        }
        throw error;
      }
      if (!approved) {
        const current = await storage.getMemoryById(card.card.cardId);
        const currentCard = current ? projectSupportPassportCard(current) : null;
        if (currentCard?.card.status === "active") {
          if (retiredPriorId) {
            await this.completePriorRetirement(storage, retiredPriorId, card.card.cardId);
          }
          return currentCard.card;
        }
        if (retiredPriorId) {
          await this.restorePriorAfterApprovalFailure(storage, retiredPriorId, card.card.cardId);
        }
        throw new SupportPassportError("storage_conflict", "The support card changed before approval.", 409);
      }
      if (retiredPriorId) {
        await this.completePriorRetirement(storage, retiredPriorId, card.card.cardId);
      }
      return (await this.requireCard(storage, card.card.cardId)).card;
    });
  }

  async rejectCard(input: SupportPassportCardMutationInput): Promise<SupportPassportCard> {
    return await this.changeStatus(input, "pending_review", "rejected", "support-passport.reject");
  }

  async withdrawCard(input: SupportPassportCardMutationInput): Promise<SupportPassportCard> {
    return await this.changeStatus(input, "active", "archived", "support-passport.withdraw");
  }

  private async createDraft(
    storage: StorageManager,
    input: {
      title: string;
      statement: string;
      category: SupportPassportCardCategory;
      reviewBy?: string;
      sourceMemoryIds: string[];
      supersedes?: string;
      replacesDraftId?: string;
      order?: number;
    }
  ): Promise<SupportPassportCard> {
    const now = this.now();
    const reviewBy = input.reviewBy ?? now.toISOString();
    const storedCards = await this.readStoredCards(storage);
    const visibleCardCount = storedCards.filter((item) => OWNER_VISIBLE_STATUSES.has(item.card.status)).length;
    const replacesVisibleDraft =
      input.replacesDraftId !== undefined &&
      storedCards.some(
        (item) => item.card.cardId === input.replacesDraftId && item.card.status === "pending_review"
      );
    if (visibleCardCount - (replacesVisibleDraft ? 1 : 0) >= MAX_OWNER_VISIBLE_CARDS) {
      throw new SupportPassportError("invalid_input", "A support passport can contain at most 100 visible cards.", 400);
    }
    const order = input.order ?? storedCards.reduce((maximum, card) => Math.max(maximum, card.order), -1) + 1;
    const envelope = composeMemoryEnvelope(
      {
        content: input.statement,
        category: "preference",
        tags: [SUPPORT_PASSPORT_CARD_TAG],
        structuredAttributes: {
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.title]: input.title,
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.category]: input.category,
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.order]: String(order),
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.reviewBy]: reviewBy,
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.sourceMemoryIds]: input.sourceMemoryIds.join(","),
          ...(input.replacesDraftId
            ? { [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.replacesDraftId]: input.replacesDraftId }
            : {}),
        },
        sourceReason: "support-passport",
      },
      { source: "support-passport", now: this.now }
    );
    if (envelope.sanitizeViolations.length > 0) throw invalidInput();
    const written = await storage.writeSealedMemory(envelope, {
      actor: "support-passport.create-draft",
      status: "pending_review",
      lineage: input.sourceMemoryIds.length > 0 ? input.sourceMemoryIds : undefined,
      supersedes: input.supersedes,
    });
    if (written.tombstoneBlocked) {
      throw new SupportPassportError("storage_conflict", "The support card needs memory review before use.", 409);
    }
    return (await this.requireCard(storage, written.id)).card;
  }

  private async changeStatus(
    input: SupportPassportCardMutationInput,
    expectedStatus: "pending_review" | "active",
    nextStatus: "rejected" | "archived",
    actor: string
  ): Promise<SupportPassportCard> {
    const parsed = SupportPassportCardMutationInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { storage } = await this.resolveOwner(parsed.data.principal);
    return await this.withOwnerLock(storage, async () => {
      let card = await this.requireCard(storage, parsed.data.cardId);
      this.requireRevision(card, parsed.data.expectedRevision);
      if (expectedStatus === "pending_review") {
        card = this.projectRequiredCard(await this.recoverReplacementTransition(storage, card.memory));
      }
      this.requireStatus(card, expectedStatus);
      const updatedAt = this.now().toISOString();
      const changed = await storage.writeMemoryFrontmatterIfUnchanged(
        card.memory,
        {
          status: nextStatus,
          updated: updatedAt,
          ...(nextStatus === "archived" ? { archivedAt: updatedAt } : {}),
        },
        { actor, reasonCode: nextStatus === "archived" ? "owner-withdrew" : "owner-rejected" }
      );
      if (!changed)
        throw new SupportPassportError(
          "storage_conflict",
          "The support card changed before the request completed.",
          409
        );
      return {
        ...card.card,
        status: nextStatus,
        updatedAt,
        revision: this.revisionFor(card.card, nextStatus, updatedAt),
      };
    });
  }

  private revisionFor(card: SupportPassportCard, status: SupportPassportCard["status"], updatedAt: string): string {
    return computeSupportPassportCardRevision({
      cardId: card.cardId,
      title: card.title,
      statement: card.statement,
      category: card.category,
      status,
      updatedAt,
      reviewBy: card.reviewBy,
    });
  }

  private async rejectCreatedDraft(storage: StorageManager, cardId: string, reasonCode: string): Promise<void> {
    try {
      const current = await this.requireCard(storage, cardId);
      const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
        current.memory,
        { status: "rejected", updated: this.now().toISOString() },
        { actor: "support-passport.replace-draft-rollback", reasonCode }
      );
      if (!rejected) log.warn("support passport could not roll back a replacement draft");
    } catch (error) {
      log.warn(
        `support passport could not roll back a replacement draft: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async requireCard(storage: StorageManager, cardId: string): Promise<StoredSupportPassportCard> {
    const stored = await storage.getMemoryById(cardId);
    const card = stored ? projectSupportPassportCard(stored) : null;
    if (!card) throw new SupportPassportError("card_not_found", "The support card was not found.", 404);
    return card;
  }

  private projectRequiredCard(memory: MemoryFile): StoredSupportPassportCard {
    const card = projectSupportPassportCard(memory);
    if (!card) throw new SupportPassportError("card_data_invalid", "The support card data is invalid.", 500);
    return card;
  }

  private requireRevision(card: StoredSupportPassportCard, expectedRevision: string): void {
    if (card.card.revision !== expectedRevision) {
      throw new SupportPassportError("revision_conflict", "The support card changed after it was loaded.", 409);
    }
  }

  private requireStatus(card: StoredSupportPassportCard, status: SupportPassportCard["status"]): void {
    if (card.card.status !== status) {
      throw new SupportPassportError("invalid_card_status", `The support card must have status ${status}.`, 409);
    }
  }

  private async readStoredCards(storage: StorageManager): Promise<StoredSupportPassportCard[]> {
    const initial = await storage.readAllMemories();
    let recovered = false;
    for (const memory of initial) {
      if ((await this.recoverReplacementTransition(storage, memory)) !== memory) recovered = true;
    }
    const memories: MemoryFile[] = recovered ? await storage.readAllMemories() : initial;
    const projected = memories
      .map(projectSupportPassportCard)
      .filter((card): card is StoredSupportPassportCard => card !== null);
    const ids = new Set<string>();
    for (const item of projected) {
      if (ids.has(item.card.cardId)) {
        throw new SupportPassportError("card_data_invalid", "Support card IDs must be unique.", 500);
      }
      ids.add(item.card.cardId);
    }
    return projected;
  }

  private async preparePriorForReplacement(
    storage: StorageManager,
    replacement: StoredSupportPassportCard
  ): Promise<string | null> {
    const priorId = replacement.memory.frontmatter.supersedes;
    if (!priorId) return null;
    const priorMemory = await storage.getMemoryById(priorId);
    const alreadyRetired =
      priorMemory?.frontmatter.status === "superseded" &&
      priorMemory.frontmatter.supersededBy === replacement.card.cardId;
    const prior = priorMemory && !alreadyRetired ? projectSupportPassportCard(priorMemory) : null;
    if (prior?.card.status === "rejected") return null;
    if (!priorMemory || (!alreadyRetired && prior?.card.status !== "active")) {
      throw new SupportPassportError("storage_conflict", "The prior support card changed before replacement.", 409);
    }
    if (alreadyRetired) return priorId;
    const retiredAt = this.now().toISOString();
    const retired = await storage.writeMemoryFrontmatterIfUnchanged(
      priorMemory,
      {
        status: "superseded",
        supersededBy: replacement.card.cardId,
        supersededAt: retiredAt,
        supersessionCause: "direct",
        updated: retiredAt,
      },
      {
        actor: "support-passport.approve-prepare",
        reasonCode: "support-passport-replacement-pending",
        relatedMemoryIds: [replacement.card.cardId],
      }
    );
    if (!retired) {
      throw new SupportPassportError("storage_conflict", "The prior support card changed before replacement.", 409);
    }
    return priorId;
  }

  private async recoverReplacementTransition(storage: StorageManager, memory: MemoryFile): Promise<MemoryFile> {
    const replacement = projectSupportPassportCard(memory);
    if (replacement?.card.status !== "pending_review" && replacement?.card.status !== "active") return memory;
    if (!replacement.replacesDraftId && !memory.frontmatter.supersedes) return memory;
    await this.recoverReplacedDraft(storage, replacement);
    const currentMemory = (await storage.getMemoryById(replacement.card.cardId)) ?? memory;
    const currentCard = projectSupportPassportCard(currentMemory);
    if (currentCard?.card.status !== "pending_review" && currentCard?.card.status !== "active") {
      return currentMemory;
    }
    const priorId = currentMemory.frontmatter.supersedes;
    if (!priorId) return currentMemory;
    const prior = await storage.getMemoryById(priorId);
    if (prior?.frontmatter.status !== "superseded" || prior.frontmatter.supersededBy !== replacement.card.cardId) {
      return currentMemory;
    }
    if (currentCard.card.status === "pending_review") {
      const recovered = await storage.writeMemoryFrontmatterIfUnchanged(
        currentMemory,
        { status: "active", updated: this.now().toISOString() },
        { actor: "support-passport.approve-recovery", reasonCode: "complete-replacement-approval" }
      );
      if (!recovered) return (await storage.getMemoryById(replacement.card.cardId)) ?? currentMemory;
    }
    await this.completePriorRetirement(storage, priorId, replacement.card.cardId);
    return (await storage.getMemoryById(replacement.card.cardId)) ?? currentMemory;
  }

  private async completePriorRetirement(
    storage: StorageManager,
    priorId: string,
    replacementId: string
  ): Promise<void> {
    const prior = await storage.getMemoryById(priorId);
    if (prior?.frontmatter.status !== "superseded" || prior.frontmatter.supersededBy !== replacementId) return;
    const completed = await storage.supersedeMemory(
      priorId,
      replacementId,
      "support-passport-replacement",
      { supersessionCause: "direct" },
      { requireActive: true, acceptExactReplay: true, expectedSnapshot: prior }
    );
    if (!completed) log.warn("support passport could not complete replacement retirement side effects");
  }

  private async recoverReplacedDraft(storage: StorageManager, replacement: StoredSupportPassportCard): Promise<void> {
    if (!replacement.replacesDraftId) return;
    const replacedDraft = await storage.getMemoryById(replacement.replacesDraftId);
    const projectedDraft = replacedDraft ? projectSupportPassportCard(replacedDraft) : null;
    if (replacedDraft && projectedDraft?.card.status === "pending_review") {
      const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
        replacedDraft,
        { status: "rejected", updated: this.now().toISOString() },
        { actor: "support-passport.replace-draft-recovery", reasonCode: "complete-draft-replacement" }
      );
      if (rejected) return;
    }
    const currentDraft = await storage.getMemoryById(replacement.replacesDraftId);
    if (currentDraft?.frontmatter.status === "rejected") return;
    if (currentDraft?.frontmatter.status === "pending_review") {
      throw new SupportPassportError("storage_conflict", "The replaced draft changed during recovery.", 409);
    }
    await this.rejectOrphanedReplacement(storage, replacement.card.cardId);
  }

  private async rejectOrphanedReplacement(storage: StorageManager, replacementId: string): Promise<void> {
    const currentReplacement = await this.requireCard(storage, replacementId);
    if (currentReplacement.card.status === "rejected") return;
    this.requireStatus(currentReplacement, "pending_review");
    const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
      currentReplacement.memory,
      { status: "rejected", updated: this.now().toISOString() },
      { actor: "support-passport.replace-draft-recovery", reasonCode: "replaced-draft-approved" }
    );
    if (rejected) return;
    const latest = await storage.getMemoryById(replacementId);
    if (latest?.frontmatter.status !== "rejected") {
      throw new SupportPassportError("storage_conflict", "The orphaned replacement could not be rejected.", 409);
    }
  }

  private async withOwnerLock<T>(storage: StorageManager, task: () => Promise<T>): Promise<T> {
    const lockPath = path.join(storage.dir, "state", "support-passport-cards.lock");
    return await serializeMutations(lockPath, () =>
      withHeldFileLock(
        lockPath,
        { staleMs: CARD_MUTATION_LOCK_STALE_MS, maxWaitMs: CARD_MUTATION_LOCK_MAX_WAIT_MS },
        async (acquired) => {
          if (!acquired) {
            throw new SupportPassportError("storage_conflict", "The support passport is busy. Try again.", 409);
          }
          return await task();
        }
      )
    );
  }

  private async restorePriorAfterApprovalFailure(
    storage: StorageManager,
    priorId: string,
    replacementId: string
  ): Promise<void> {
    try {
      const replacement = await storage.getMemoryById(replacementId);
      if (replacement?.frontmatter.status === "active") return;
      const prior = await storage.getMemoryById(priorId);
      if (prior?.frontmatter.status !== "superseded" || prior.frontmatter.supersededBy !== replacementId) return;
      const restored = await storage.writeMemoryFrontmatterIfUnchanged(
        prior,
        {
          status: "active",
          supersededBy: undefined,
          supersededAt: undefined,
          supersessionCause: undefined,
          invalidatedBy: undefined,
          updated: this.now().toISOString(),
        },
        { actor: "support-passport.approve-rollback", reasonCode: "replacement-activation-failed" }
      );
      if (!restored) log.warn("support passport could not restore a prior card after replacement approval failed");
    } catch (error) {
      log.warn(
        `support passport could not restore a prior card after replacement approval failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
