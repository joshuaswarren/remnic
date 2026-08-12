import type { StorageManager } from "../index.js";
import { log } from "../logger.js";
import type { MemoryFile } from "../types.js";
import type { HeldFileLockController } from "../utils/serialize-mutations.js";
import { composeMemoryEnvelope } from "../write-envelope.js";
import {
  SUPPORT_PASSPORT_ATTRIBUTE_KEYS,
  SUPPORT_PASSPORT_CARD_TAG,
  type StoredSupportPassportCard,
  activeSupportPassportReplacementPredecessorIds,
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
import { withSupportPassportOwnerLock } from "./owner-lock.js";
import { type SupportPassportDraftCard, SupportPassportDraftOutputSchema } from "./model-contracts.js";

export interface SupportPassportOwnerScope {
  principal: string;
  namespace: string;
  storage: StorageManager;
}

export interface SupportPassportCardServiceDependencies {
  resolveOwner(principal: string): Promise<SupportPassportOwnerScope>;
  now?: () => Date;
}

const OWNER_VISIBLE_STATUSES = new Set(["pending_review", "active"]);
const MAX_OWNER_VISIBLE_CARDS = 100;

function invalidInput(): SupportPassportError {
  return new SupportPassportError("invalid_input", "The support card request is invalid.", 400);
}

function isStorageConflict(error: unknown): error is SupportPassportError {
  return error instanceof SupportPassportError && error.code === "storage_conflict";
}

function once(callback: (() => void) | undefined): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback?.();
  };
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
    const cards = this.ownerListCards(await this.readStoredCards(storage))
      .sort((a, b) => a.order - b.order || a.card.cardId.localeCompare(b.card.cardId))
      .map((item) => item.card);
    const output = SupportPassportCardListSchema.safeParse(cards);
    if (!output.success) {
      throw new SupportPassportError("card_data_invalid", "The support card data is invalid.", 500);
    }
    return output.data;
  }

  async createManualDraft(
    input: SupportPassportManualDraftInput,
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    const parsed = SupportPassportManualDraftInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { principal, storage } = await this.resolveOwner(parsed.data.principal);
    const onCommitted = once(options.onCommitted);
    return await this.withOwnerLock(storage, async (lock) => {
      options.signal?.throwIfAborted();
      const created = await this.createDraft(
        storage,
        {
          title: parsed.data.title,
          statement: parsed.data.statement,
          category: parsed.data.category,
          reviewBy: parsed.data.reviewBy,
          sourceMemoryIds: [],
          onCommitted,
        },
        lock,
        principal
      );
      if (!options.signal?.aborted) return created;
      if (!(await this.rejectGeneratedDraft(storage, created.cardId, lock))) {
        throw new SupportPassportError("storage_conflict", "A cancelled support card could not be rolled back.", 500);
      }
      options.signal.throwIfAborted();
      return created;
    });
  }

  async createGeneratedDrafts(input: {
    principal: string;
    cards: SupportPassportDraftCard[];
  }): Promise<SupportPassportCard[]> {
    const principal = SupportPassportListCardsInputSchema.safeParse({ principal: input.principal });
    if (!principal.success) throw invalidInput();
    const owner = await this.resolveOwner(principal.data.principal);
    return await this.createGeneratedDraftsForOwner({ owner, cards: input.cards });
  }

  async createGeneratedDraftsForOwner(input: {
    owner: SupportPassportOwnerScope;
    cards: SupportPassportDraftCard[];
    signal?: AbortSignal;
    onCommitted?: () => void;
    validateSources?: () => Promise<void>;
  }): Promise<SupportPassportCard[]> {
    const output = SupportPassportDraftOutputSchema.safeParse({ cards: input.cards });
    if (!output.success) throw invalidInput();
    const { storage } = input.owner;
    const onCommitted = once(input.onCommitted);
    return await this.withOwnerLock(storage, async (lock) => {
      const created: SupportPassportCard[] = [];
      const createdIds: string[] = [];
      try {
        input.signal?.throwIfAborted();
        await input.validateSources?.();
        input.signal?.throwIfAborted();
        for (const card of output.data.cards) {
          input.signal?.throwIfAborted();
          created.push(
            await this.createDraft(
              storage,
              {
                title: card.title,
                statement: card.statement,
                category: card.category,
                sourceMemoryIds: card.sourceMemoryIds,
                onPersisted: (cardId) => {
                  createdIds.push(cardId);
                },
                onCommitted,
              },
              lock,
              input.owner.principal
            )
          );
        }
        await input.validateSources?.();
        input.signal?.throwIfAborted();
        return created;
      } catch (error) {
        let rollbackIncomplete = false;
        for (const cardId of createdIds) {
          try {
            if (!(await this.rejectGeneratedDraft(storage, cardId, lock))) rollbackIncomplete = true;
          } catch {
            rollbackIncomplete = true;
          }
        }
        if (rollbackIncomplete) {
          throw new SupportPassportError("storage_conflict", "A generated draft batch could not be rolled back.", 500);
        }
        throw error;
      }
    });
  }

  async replaceCard(
    input: SupportPassportReplaceCardInput,
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    const parsed = SupportPassportReplaceCardInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { principal, storage } = await this.resolveOwner(parsed.data.principal);
    const onCommitted = once(options.onCommitted);
    return await this.withOwnerLock(storage, async (lock) => {
      options.signal?.throwIfAborted();
      const loadedPrior = await this.requireCard(storage, parsed.data.cardId);
      const storedCards = await this.readStoredCards(storage);
      const interruptedReplacements = storedCards.filter(
        (item) =>
          item.card.status === "pending_review" &&
          (item.replacesDraftId === loadedPrior.card.cardId ||
            item.memory.frontmatter.supersedes === loadedPrior.card.cardId)
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
        return this.projectRequiredCard(
          await this.recoverReplacementTransition(
            storage,
            interruptedReplacement.memory,
            lock,
            principal,
            {},
            onCommitted
          )
        ).card;
      }
      this.requireRevision(loadedPrior, parsed.data.expectedRevision);
      const refreshedPrior = await this.requireCard(storage, parsed.data.cardId);
      this.requireRevision(refreshedPrior, parsed.data.expectedRevision);
      const recoveredMemory = await this.recoverReplacementTransition(
        storage,
        refreshedPrior.memory,
        lock,
        principal,
        {},
        onCommitted
      );
      const prior = this.projectRequiredCard(recoveredMemory);
      if (prior.card.status !== "active" && prior.card.status !== "pending_review") {
        throw new SupportPassportError(
          "invalid_card_status",
          "Only a draft or approved support card can be edited.",
          409
        );
      }
      const replacement = await this.createDraft(
        storage,
        {
          title: parsed.data.title,
          statement: parsed.data.statement,
          category: parsed.data.category,
          reviewBy: parsed.data.reviewBy,
          sourceMemoryIds: prior.sourceMemoryIds,
          supersedes: prior.card.status === "active" ? prior.card.cardId : prior.memory.frontmatter.supersedes,
          replacesDraftId: prior.card.status === "pending_review" ? prior.card.cardId : undefined,
          order: prior.order,
          onCommitted,
        },
        lock,
        principal
      );
      if (options.signal?.aborted) {
        if (!(await this.rejectGeneratedDraft(storage, replacement.cardId, lock))) {
          throw new SupportPassportError("storage_conflict", "A cancelled support card edit could not be rolled back.", 500);
        }
        options.signal.throwIfAborted();
      }
      if (prior.card.status === "active") return replacement;

      const replacedAt = this.now().toISOString();
      await this.requireOwnerLock(lock);
      const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
        prior.memory,
        { status: "rejected", updated: replacedAt },
        { actor: principal, reasonCode: "owner-replaced-draft" }
      );
      if (rejected) {
        onCommitted();
        return replacement;
      }
      const currentPrior = await storage.getMemoryById(prior.card.cardId);
      if (currentPrior?.frontmatter.status === "rejected") return replacement;

      await this.rejectCreatedDraft(
        storage,
        replacement.cardId,
        "draft-replacement-failed",
        lock,
        principal,
        onCommitted
      );
      throw new SupportPassportError("storage_conflict", "The support card changed before it was edited.", 409);
    });
  }

  async approveCard(
    input: SupportPassportCardMutationInput,
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    const parsed = SupportPassportCardMutationInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { principal, storage } = await this.resolveOwner(parsed.data.principal);
    const onCommitted = once(options.onCommitted);
    return await this.withOwnerLock(storage, async (lock) => {
      options.signal?.throwIfAborted();
      const loadedCard = await this.requireCard(storage, parsed.data.cardId);
      this.requireRevision(loadedCard, parsed.data.expectedRevision);
      this.requireStatus(loadedCard, "pending_review");
      const recoveredMemory = await this.recoverReplacementTransition(
        storage,
        loadedCard.memory,
        lock,
        principal,
        {},
        onCommitted
      );
      const card = this.projectRequiredCard(recoveredMemory);
      if (card.card.status === "active") return card.card;
      this.requireStatus(card, "pending_review");
      await this.validatePriorForReplacement(storage, card);
      const updatedAt = this.now().toISOString();
      await this.requireOwnerLock(lock);
      let approved: boolean;
      try {
        approved = await storage.writeMemoryFrontmatterIfUnchanged(
          card.memory,
          { status: "active", updated: updatedAt },
          { actor: principal, reasonCode: parsed.data.reasonCode ?? "owner-approved" }
        );
      } catch (error) {
        const current = await storage.getMemoryById(card.card.cardId);
        const currentCard = current ? projectSupportPassportCard(current) : null;
        if (currentCard?.card.status === "active") {
          onCommitted();
          return await this.finishCommittedApproval(storage, currentCard, lock, principal, onCommitted);
        }
        throw error;
      }
      if (!approved) {
        const current = await storage.getMemoryById(card.card.cardId);
        const currentCard = current ? projectSupportPassportCard(current) : null;
        if (currentCard?.card.status === "active") {
          onCommitted();
          return await this.finishCommittedApproval(storage, currentCard, lock, principal, onCommitted);
        }
        throw new SupportPassportError("storage_conflict", "The support card changed before approval.", 409);
      }
      const committedCard: SupportPassportCard = {
        ...card.card,
        status: "active",
        updatedAt,
        revision: this.revisionFor(card.card, "active", updatedAt),
      };
      onCommitted();
      try {
        const current = await this.requireCard(storage, card.card.cardId);
        return await this.finishCommittedApproval(storage, current, lock, principal, onCommitted);
      } catch (error) {
        if (isStorageConflict(error)) throw error;
        log.warn(
          `support passport could not finish replacement approval side effects: ${error instanceof Error ? error.message : String(error)}`
        );
        return committedCard;
      }
    });
  }

  async rejectCard(
    input: SupportPassportCardMutationInput,
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    return await this.changeStatus(input, "pending_review", "rejected", "owner-rejected", options);
  }

  async withdrawCard(
    input: SupportPassportCardMutationInput,
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    return await this.changeStatus(input, "active", "archived", "owner-withdrew", options);
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
      onPersisted?: (cardId: string) => void;
      onCommitted?: () => void;
    },
    lock: HeldFileLockController,
    principal: string
  ): Promise<SupportPassportCard> {
    const now = this.now();
    const reviewBy = input.reviewBy ?? now.toISOString();
    const storedCards = await this.readStoredCards(storage);
    const visibleCards = this.ownerListCards(storedCards);
    const replacesVisibleCard = visibleCards.some(
      (item) =>
        (input.replacesDraftId === item.card.cardId && item.card.status === "pending_review") ||
        (input.supersedes === item.card.cardId && item.card.status === "active")
    );
    if (visibleCards.length - (replacesVisibleCard ? 1 : 0) >= MAX_OWNER_VISIBLE_CARDS) {
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
    await this.requireOwnerLock(lock);
    const written = await storage.writeSealedMemory(envelope, {
      actor: principal,
      status: "pending_review",
      lineage: input.sourceMemoryIds.length > 0 ? input.sourceMemoryIds : undefined,
      supersedes: input.supersedes,
    });
    if (written.tombstoneBlocked) {
      throw new SupportPassportError("storage_conflict", "The support card needs memory review before use.", 409);
    }
    input.onPersisted?.(written.id);
    input.onCommitted?.();
    return this.projectRequiredCard(written.memory).card;
  }

  private async changeStatus(
    input: SupportPassportCardMutationInput,
    expectedStatus: "pending_review" | "active",
    nextStatus: "rejected" | "archived",
    defaultReasonCode: string,
    options: { signal?: AbortSignal; onCommitted?: () => void }
  ): Promise<SupportPassportCard> {
    const parsed = SupportPassportCardMutationInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { principal, storage } = await this.resolveOwner(parsed.data.principal);
    const onCommitted = once(options.onCommitted);
    return await this.withOwnerLock(storage, async (lock) => {
      options.signal?.throwIfAborted();
      let card = await this.requireCard(storage, parsed.data.cardId);
      this.requireRevision(card, parsed.data.expectedRevision);
      this.requireStatus(card, expectedStatus);
      if (
        expectedStatus === "pending_review" ||
        (expectedStatus === "active" && (card.replacesDraftId || card.memory.frontmatter.supersedes))
      ) {
        card = this.projectRequiredCard(
          await this.recoverReplacementTransition(
            storage,
            card.memory,
            lock,
            principal,
            {
              rollbackConflictedApproval: expectedStatus !== "active",
            },
            onCommitted
          )
        );
      }
      this.requireStatus(card, expectedStatus);
      const updatedAt = this.now().toISOString();
      await this.requireOwnerLock(lock);
      const changed = await storage.writeMemoryFrontmatterIfUnchanged(
        card.memory,
        {
          status: nextStatus,
          updated: updatedAt,
          ...(nextStatus === "archived" ? { archivedAt: updatedAt } : {}),
        },
        { actor: principal, reasonCode: parsed.data.reasonCode ?? defaultReasonCode }
      );
      if (!changed)
        throw new SupportPassportError(
          "storage_conflict",
          "The support card changed before the request completed.",
          409
        );
      onCommitted();
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

  private async rejectCreatedDraft(
    storage: StorageManager,
    cardId: string,
    reasonCode: string,
    lock: HeldFileLockController,
    principal: string,
    onCommitted?: () => void
  ): Promise<void> {
    try {
      const current = await this.requireCard(storage, cardId);
      await this.requireOwnerLock(lock);
      const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
        current.memory,
        { status: "rejected", updated: this.now().toISOString() },
        { actor: principal, reasonCode }
      );
      if (rejected) onCommitted?.();
      else log.warn("support passport could not roll back a replacement draft");
    } catch (error) {
      log.warn(
        `support passport could not roll back a replacement draft: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async rejectGeneratedDraft(
    storage: StorageManager,
    cardId: string,
    lock: HeldFileLockController
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const memory = await storage.getMemoryById(cardId);
      if (!memory) return true;
      const stored = projectSupportPassportCard(memory);
      if (!stored || stored.card.status === "rejected") return true;
      if (stored.card.status !== "pending_review") return false;
      await this.requireOwnerLock(lock);
      const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
        memory,
        { status: "rejected", updated: this.now().toISOString() },
        { actor: "support-passport.draft-rollback", reasonCode: "draft-batch-failed" }
      );
      if (rejected) return true;
    }
    return false;
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
    const projected = (await storage.readAllMemories())
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

  private ownerVisibleCards(storedCards: StoredSupportPassportCard[]): StoredSupportPassportCard[] {
    const visibleCards = storedCards.filter((item) => OWNER_VISIBLE_STATUSES.has(item.card.status));
    if (visibleCards.length <= MAX_OWNER_VISIBLE_CARDS) return visibleCards;
    const cardsWithPendingReplacements = new Set(
      visibleCards
        .filter((item) => item.card.status === "pending_review")
        .map((item) => item.memory.frontmatter.supersedes)
        .filter((cardId): cardId is string => typeof cardId === "string")
    );
    return visibleCards.filter(
      (item) => item.card.status !== "active" || !cardsWithPendingReplacements.has(item.card.cardId)
    );
  }

  private ownerListCards(storedCards: StoredSupportPassportCard[]): StoredSupportPassportCard[] {
    const visibleCards = this.ownerVisibleCards(storedCards);
    const byId = new Map(storedCards.map((item) => [item.card.cardId, item]));
    const activeReplacementPredecessors = activeSupportPassportReplacementPredecessorIds(visibleCards);
    const replacedDraftIds = new Set(
      visibleCards
        .filter(
          (item) =>
            item.card.status === "pending_review" &&
            item.replacesDraftId !== undefined &&
            byId.get(item.replacesDraftId)?.card.status === "pending_review"
        )
        .map((item) => item.replacesDraftId as string)
    );
    return visibleCards.filter((item) => {
      if (activeReplacementPredecessors.has(item.card.cardId)) return false;
      if (replacedDraftIds.has(item.card.cardId)) return false;
      if (!item.replacesDraftId) return true;
      const replacedStatus = byId.get(item.replacesDraftId)?.card.status;
      return replacedStatus === "pending_review" || replacedStatus === "rejected";
    });
  }

  private async preparePriorForReplacement(
    storage: StorageManager,
    replacement: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    onCommitted?: () => void
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
    await this.requireOwnerLock(lock);
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
        actor: principal,
        reasonCode: "support-passport-replacement-pending",
        relatedMemoryIds: [replacement.card.cardId],
      }
    );
    if (!retired) {
      throw new SupportPassportError("storage_conflict", "The prior support card changed before replacement.", 409);
    }
    onCommitted?.();
    return priorId;
  }

  private async validatePriorForReplacement(
    storage: StorageManager,
    replacement: StoredSupportPassportCard
  ): Promise<void> {
    const priorId = replacement.memory.frontmatter.supersedes;
    if (!priorId) return;
    const priorMemory = await storage.getMemoryById(priorId);
    const alreadyRetired =
      priorMemory?.frontmatter.status === "superseded" &&
      priorMemory.frontmatter.supersededBy === replacement.card.cardId;
    const prior = priorMemory && !alreadyRetired ? projectSupportPassportCard(priorMemory) : null;
    if (prior?.card.status === "rejected" || alreadyRetired) return;
    if (!priorMemory || prior?.card.status !== "active") {
      throw new SupportPassportError("storage_conflict", "The prior support card changed before replacement.", 409);
    }
  }

  private async recoverReplacementTransition(
    storage: StorageManager,
    memory: MemoryFile,
    lock: HeldFileLockController,
    principal: string,
    options: { rollbackConflictedApproval?: boolean } = {},
    onCommitted?: () => void
  ): Promise<MemoryFile> {
    const replacement = projectSupportPassportCard(memory);
    if (replacement?.card.status !== "pending_review" && replacement?.card.status !== "active") return memory;
    if (!replacement.replacesDraftId && !memory.frontmatter.supersedes) return memory;
    if (
      replacement.card.status === "active" &&
      memory.frontmatter.structuredAttributes?.[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.replacementComplete] === "true"
    ) {
      return memory;
    }
    await this.recoverReplacedDraft(storage, replacement, lock, principal, onCommitted);
    const currentMemory = (await storage.getMemoryById(replacement.card.cardId)) ?? memory;
    const currentCard = projectSupportPassportCard(currentMemory);
    if (currentCard?.card.status !== "pending_review" && currentCard?.card.status !== "active") {
      return currentMemory;
    }
    if (currentCard.card.status === "pending_review") {
      const priorId = currentMemory.frontmatter.supersedes;
      if (!priorId) return currentMemory;
      const prior = await storage.getMemoryById(priorId);
      if (prior?.frontmatter.status === "superseded" && prior.frontmatter.supersededBy === replacement.card.cardId) {
        await this.restorePriorAfterApprovalFailure(
          storage,
          priorId,
          replacement.card.cardId,
          lock,
          principal,
          onCommitted
        );
      }
      return (await storage.getMemoryById(replacement.card.cardId)) ?? currentMemory;
    }
    try {
      await this.completeReplacementAfterActivation(storage, currentCard, lock, principal, onCommitted);
    } catch (error) {
      if (!isStorageConflict(error)) throw error;
      if (options.rollbackConflictedApproval === false) throw error;
      await this.rollbackConflictedApproval(storage, currentCard.card.cardId, lock, principal, onCommitted);
    }
    return (await storage.getMemoryById(replacement.card.cardId)) ?? currentMemory;
  }

  private async completeReplacementAfterActivation(
    storage: StorageManager,
    replacement: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    onCommitted?: () => void
  ): Promise<void> {
    const priorId = await this.preparePriorForReplacement(storage, replacement, lock, principal, onCommitted);
    if (priorId && !(await this.completePriorRetirement(storage, priorId, replacement, lock))) {
      throw new SupportPassportError("storage_conflict", "The prior support card changed before replacement.", 409);
    }
    if (priorId) onCommitted?.();
    await this.markReplacementComplete(storage, replacement.card.cardId, lock, principal, onCommitted);
  }

  private async finishCommittedApproval(
    storage: StorageManager,
    replacement: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    onCommitted?: () => void
  ): Promise<SupportPassportCard> {
    try {
      if (replacement.replacesDraftId || replacement.memory.frontmatter.supersedes) {
        await this.completeReplacementAfterActivation(storage, replacement, lock, principal, onCommitted);
      }
    } catch (error) {
      if (isStorageConflict(error)) {
        await this.rollbackConflictedApproval(storage, replacement.card.cardId, lock, principal, onCommitted);
        throw error;
      }
      log.warn(
        `support passport could not finish replacement approval side effects: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return replacement.card;
  }

  private async rollbackConflictedApproval(
    storage: StorageManager,
    replacementId: string,
    lock: HeldFileLockController,
    principal: string,
    onCommitted?: () => void
  ): Promise<void> {
    const replacement = await this.requireCard(storage, replacementId);
    if (replacement.card.status !== "active") return;
    await this.requireOwnerLock(lock);
    const rolledBack = await storage.writeMemoryFrontmatterIfUnchanged(
      replacement.memory,
      { status: "pending_review", updated: this.now().toISOString() },
      { actor: principal, reasonCode: "replacement-predecessor-conflict" }
    );
    if (!rolledBack) {
      throw new SupportPassportError(
        "storage_conflict",
        "The replacement changed while its approval was rolled back.",
        409
      );
    }
    onCommitted?.();
    const priorId = replacement.memory.frontmatter.supersedes;
    if (priorId) {
      await this.restorePriorAfterApprovalFailure(storage, priorId, replacementId, lock, principal, onCommitted);
    }
  }

  private async completePriorRetirement(
    storage: StorageManager,
    priorId: string,
    replacement: StoredSupportPassportCard,
    lock: HeldFileLockController
  ): Promise<boolean> {
    const replacementId = replacement.card.cardId;
    const prior = await storage.getMemoryById(priorId);
    if (prior?.frontmatter.status !== "superseded" || prior.frontmatter.supersededBy !== replacementId) return false;
    await this.requireOwnerLock(lock);
    const completed = await storage.supersedeMemory(
      priorId,
      replacementId,
      "support-passport-replacement",
      { supersessionCause: "direct" },
      { requireActive: true, acceptExactReplay: true, expectedSnapshot: prior }
    );
    if (!completed) log.warn("support passport could not complete replacement retirement side effects");
    return completed;
  }

  private async recoverReplacedDraft(
    storage: StorageManager,
    replacement: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    onCommitted?: () => void
  ): Promise<void> {
    if (!replacement.replacesDraftId) return;
    const replacedDraft = await storage.getMemoryById(replacement.replacesDraftId);
    const projectedDraft = replacedDraft ? projectSupportPassportCard(replacedDraft) : null;
    if (replacedDraft && projectedDraft?.card.status === "pending_review") {
      await this.requireOwnerLock(lock);
      const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
        replacedDraft,
        { status: "rejected", updated: this.now().toISOString() },
        { actor: principal, reasonCode: "complete-draft-replacement" }
      );
      if (rejected) {
        onCommitted?.();
        return;
      }
    }
    const currentDraft = await storage.getMemoryById(replacement.replacesDraftId);
    if (currentDraft?.frontmatter.status === "rejected") return;
    if (currentDraft?.frontmatter.status === "pending_review") {
      throw new SupportPassportError("storage_conflict", "The replaced draft changed during recovery.", 409);
    }
    await this.rejectOrphanedReplacement(storage, replacement.card.cardId, lock, principal, onCommitted);
  }

  private async rejectOrphanedReplacement(
    storage: StorageManager,
    replacementId: string,
    lock: HeldFileLockController,
    principal: string,
    onCommitted?: () => void
  ): Promise<void> {
    const currentReplacement = await this.requireCard(storage, replacementId);
    if (currentReplacement.card.status === "rejected") return;
    this.requireStatus(currentReplacement, "pending_review");
    await this.requireOwnerLock(lock);
    const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
      currentReplacement.memory,
      { status: "rejected", updated: this.now().toISOString() },
      { actor: principal, reasonCode: "replaced-draft-approved" }
    );
    if (rejected) {
      onCommitted?.();
      return;
    }
    const latest = await storage.getMemoryById(replacementId);
    if (latest?.frontmatter.status !== "rejected") {
      throw new SupportPassportError("storage_conflict", "The orphaned replacement could not be rejected.", 409);
    }
  }

  private async withOwnerLock<T>(
    storage: StorageManager,
    task: (lock: HeldFileLockController) => Promise<T>
  ): Promise<T> {
    return await withSupportPassportOwnerLock(storage, task);
  }

  private async restorePriorAfterApprovalFailure(
    storage: StorageManager,
    priorId: string,
    replacementId: string,
    lock: HeldFileLockController,
    principal: string,
    onCommitted?: () => void
  ): Promise<void> {
    const replacement = await storage.getMemoryById(replacementId);
    if (replacement?.frontmatter.status === "active") return;
    const prior = await storage.getMemoryById(priorId);
    if (prior?.frontmatter.status === "active" && prior.frontmatter.supersededBy === undefined) return;
    if (prior?.frontmatter.status !== "superseded" || prior.frontmatter.supersededBy !== replacementId) {
      throw new SupportPassportError("storage_conflict", "The prior support card could not be restored.", 409);
    }
    await this.requireOwnerLock(lock);
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
      { actor: principal, reasonCode: "replacement-activation-failed" }
    );
    if (restored) {
      onCommitted?.();
      return;
    }
    const currentPrior = await storage.getMemoryById(priorId);
    if (currentPrior?.frontmatter.status === "active" && currentPrior.frontmatter.supersededBy === undefined) return;
    throw new SupportPassportError("storage_conflict", "The prior support card could not be restored.", 409);
  }

  private async markReplacementComplete(
    storage: StorageManager,
    replacementId: string,
    lock: HeldFileLockController,
    principal: string,
    onCommitted?: () => void
  ): Promise<void> {
    const replacement = await this.requireCard(storage, replacementId);
    if (
      replacement.memory.frontmatter.structuredAttributes?.[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.replacementComplete] ===
      "true"
    ) {
      return;
    }
    await this.requireOwnerLock(lock);
    const marked = await storage.writeMemoryFrontmatterIfUnchanged(
      replacement.memory,
      {
        structuredAttributes: {
          ...replacement.memory.frontmatter.structuredAttributes,
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.replacementComplete]: "true",
        },
      },
      { actor: principal, reasonCode: "replacement-side-effects-complete" }
    );
    if (marked) onCommitted?.();
    else log.warn("support passport could not mark replacement side effects complete");
  }

  private async requireOwnerLock(lock: HeldFileLockController): Promise<void> {
    if (await lock.refresh()) return;
    throw new SupportPassportError("storage_conflict", "The support passport lock changed. Try again.", 409);
  }
}
