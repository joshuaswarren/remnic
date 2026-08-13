import type { StorageManager } from "../index.js";
import { log } from "../logger.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import type { MemoryFile } from "../types.js";
import type { HeldFileLockController } from "../utils/serialize-mutations.js";
import { composeMemoryEnvelope } from "../write-envelope.js";
import {
  SUPPORT_PASSPORT_ATTRIBUTE_KEYS,
  SUPPORT_PASSPORT_CARD_TAG,
  type StoredSupportPassportCard,
  computeSupportPassportOwnerKey,
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
  SupportPassportNamespaceSchema,
  type SupportPassportReplaceCardInput,
  SupportPassportReplaceCardInputSchema,
  computeSupportPassportCardRevision,
} from "./contracts.js";
import { SupportPassportError } from "./errors.js";
import { withSupportPassportOwnerLock } from "./owner-lock.js";

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
    const { principal, namespace, storage } = await this.resolveOwnerScope(parsed.data.principal);
    return await withSupportPassportOwnerLock(storage, { namespace, principal }, async (lock) => {
      const stored = await this.readStoredCards(storage, lock, principal, namespace);
      const cards = this.ownerVisibleCards(stored)
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
    const { principal, namespace, storage } = await this.resolveOwnerScope(parsed.data.principal);
    return await withSupportPassportOwnerLock(storage, { namespace, principal }, (lock) =>
      this.createDraft(
        storage,
        {
          title: parsed.data.title,
          statement: parsed.data.statement,
          category: parsed.data.category,
          reviewBy: parsed.data.reviewBy,
          sourceMemoryIds: [],
        },
        lock,
        principal,
        namespace
      )
    );
  }

  async replaceCard(input: SupportPassportReplaceCardInput): Promise<SupportPassportCard> {
    const parsed = SupportPassportReplaceCardInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { principal, namespace, storage } = await this.resolveOwnerScope(parsed.data.principal);
    return await withSupportPassportOwnerLock(storage, { namespace, principal }, async (lock) => {
      const loadedPrior = await this.requireCard(storage, parsed.data.cardId, namespace, principal);
      const storedCards = await this.readProjectedCards(storage, namespace, principal);
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
        if (interruptedReplacement.replacedRevision !== parsed.data.expectedRevision) {
          throw new SupportPassportError("revision_conflict", "The support card changed after it was loaded.", 409);
        }
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
        if (!interruptedReplacement.draftReplacementPrepared) return interruptedReplacement.card;
        const recovered = await this.recoverReplacementTransition(
          storage,
          interruptedReplacement.memory,
          lock,
          principal,
          namespace
        );
        return this.projectRequiredCard(recovered, namespace, principal).card;
      }
      this.requireRevision(loadedPrior, parsed.data.expectedRevision);
      await this.readStoredCards(storage, lock, principal, namespace);
      const refreshedPrior = await this.requireCard(storage, parsed.data.cardId, namespace, principal);
      this.requireRevision(refreshedPrior, parsed.data.expectedRevision);
      const recoveredMemory = await this.recoverReplacementTransition(
        storage,
        refreshedPrior.memory,
        lock,
        principal,
        namespace
      );
      const prior = this.projectRequiredCard(recoveredMemory, namespace, principal);
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
          replacedRevision: prior.card.revision,
          order: prior.order,
          draftReplacementPrepared: prior.card.status === "pending_review",
        },
        lock,
        principal,
        namespace
      );
      if (prior.card.status === "active") return replacement;

      const replacedAt = this.now().toISOString();
      await this.requireOwnerLock(lock);
      const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
        prior.memory,
        { status: "rejected", updated: replacedAt },
        { actor: principal, reasonCode: "owner-replaced-draft" }
      );
      if (rejected) {
        return await this.finishPreparedDraftReplacement(storage, replacement.cardId, lock, principal, namespace);
      }
      const currentPrior = await storage.getMemoryById(prior.card.cardId);
      const currentPriorCard = currentPrior ? this.projectOwnedCard(currentPrior, namespace, principal) : null;
      if (currentPriorCard?.card.status === "rejected") {
        return await this.finishPreparedDraftReplacement(storage, replacement.cardId, lock, principal, namespace);
      }

      await this.rejectCreatedDraft(
        storage,
        replacement.cardId,
        "draft-replacement-failed",
        lock,
        principal,
        namespace
      );
      throw new SupportPassportError("storage_conflict", "The support card changed before it was edited.", 409);
    });
  }

  async approveCard(input: SupportPassportCardMutationInput): Promise<SupportPassportCard> {
    const parsed = SupportPassportCardMutationInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { principal, namespace, storage } = await this.resolveOwnerScope(parsed.data.principal);
    return await withSupportPassportOwnerLock(storage, { namespace, principal }, async (lock) => {
      const loadedCard = await this.requireCard(storage, parsed.data.cardId, namespace, principal);
      this.requireRevision(loadedCard, parsed.data.expectedRevision);
      this.requireStatus(loadedCard, "pending_review");
      const recoveredMemory = await this.recoverReplacementTransition(
        storage,
        loadedCard.memory,
        lock,
        principal,
        namespace
      );
      const card = this.projectRequiredCard(recoveredMemory, namespace, principal);
      if (card.card.status === "active") return card.card;
      if (card.card.status === "rejected") {
        throw new SupportPassportError(
          "storage_conflict",
          "The support card was rejected while its replacement state was recovered.",
          409
        );
      }
      this.requireStatus(card, "pending_review");
      await this.validatePriorForReplacement(storage, card, namespace, principal);
      const updatedAt = this.now().toISOString();
      await this.requireOwnerLock(lock);
      let approved: boolean;
      try {
        approved = await storage.writeMemoryFrontmatterIfUnchanged(
          card.memory,
          { status: "active", updated: updatedAt },
          { actor: principal, reasonCode: "owner-approved" }
        );
      } catch (error) {
        const current = await storage.getMemoryById(card.card.cardId);
        const currentCard = current ? this.projectOwnedCard(current, namespace, principal) : null;
        if (currentCard?.card.status === "active") {
          return await this.finishCommittedApproval(storage, currentCard, lock, principal, namespace);
        }
        throw error;
      }
      if (!approved) {
        const current = await storage.getMemoryById(card.card.cardId);
        const currentCard = current ? this.projectOwnedCard(current, namespace, principal) : null;
        if (currentCard?.card.status === "active") {
          return await this.finishCommittedApproval(storage, currentCard, lock, principal, namespace);
        }
        throw new SupportPassportError("storage_conflict", "The support card changed before approval.", 409);
      }
      const committedCard: SupportPassportCard = {
        ...card.card,
        status: "active",
        updatedAt,
        revision: this.revisionFor(card.card, "active", updatedAt),
      };
      try {
        const current = await this.requireCard(storage, card.card.cardId, namespace, principal);
        return await this.finishCommittedApproval(storage, current, lock, principal, namespace);
      } catch (error) {
        if (isStorageConflict(error)) throw error;
        log.warn(
          `support passport could not finish replacement approval side effects: ${error instanceof Error ? error.message : String(error)}`
        );
        return committedCard;
      }
    });
  }

  async rejectCard(input: SupportPassportCardMutationInput): Promise<SupportPassportCard> {
    return await this.changeStatus(input, "pending_review", "rejected");
  }

  async withdrawCard(input: SupportPassportCardMutationInput): Promise<SupportPassportCard> {
    return await this.changeStatus(input, "active", "archived");
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
      replacedRevision?: string;
      order?: number;
      draftReplacementPrepared?: boolean;
    },
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<SupportPassportCard> {
    const now = this.now();
    const reviewBy = input.reviewBy ?? now.toISOString();
    const storedCards = await this.readStoredCards(storage, lock, principal, namespace);
    const visibleCards = this.ownerVisibleCards(storedCards);
    const replacesVisibleCard = visibleCards.some(
      (item) =>
        (input.replacesDraftId === item.card.cardId && item.card.status === "pending_review") ||
        (input.supersedes === item.card.cardId && item.card.status === "active")
    );
    if (visibleCards.length - (replacesVisibleCard ? 1 : 0) >= MAX_OWNER_VISIBLE_CARDS) {
      throw new SupportPassportError("invalid_input", "A support passport can contain at most 100 visible cards.", 400);
    }
    const maximumOrder = storedCards.reduce((maximum, card) => Math.max(maximum, card.order), -1);
    const order = input.order ?? maximumOrder + 1;
    if (!Number.isSafeInteger(order)) {
      throw new SupportPassportError("storage_conflict", "The support card order range is exhausted.", 409);
    }
    const envelope = composeMemoryEnvelope(
      {
        content: input.statement,
        category: "preference",
        tags: [SUPPORT_PASSPORT_CARD_TAG],
        structuredAttributes: {
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.namespace]: namespace,
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.owner]: computeSupportPassportOwnerKey(principal),
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.title]: input.title,
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.category]: input.category,
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.order]: String(order),
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.reviewBy]: reviewBy,
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.sourceMemoryIds]: input.sourceMemoryIds.join(","),
          ...(input.replacesDraftId
            ? { [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.replacesDraftId]: input.replacesDraftId }
            : {}),
          ...(input.replacedRevision
            ? { [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.replacedRevision]: input.replacedRevision }
            : {}),
          ...(input.draftReplacementPrepared
            ? { [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.draftReplacementPrepared]: "true" }
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
    return this.projectRequiredCard(written.memory, namespace, principal).card;
  }

  private async changeStatus(
    input: SupportPassportCardMutationInput,
    expectedStatus: "pending_review" | "active",
    nextStatus: "rejected" | "archived"
  ): Promise<SupportPassportCard> {
    const parsed = SupportPassportCardMutationInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { principal, namespace, storage } = await this.resolveOwnerScope(parsed.data.principal);
    return await withSupportPassportOwnerLock(storage, { namespace, principal }, async (lock) => {
      let card = await this.requireCard(storage, parsed.data.cardId, namespace, principal);
      this.requireRevision(card, parsed.data.expectedRevision);
      this.requireStatus(card, expectedStatus);
      if (expectedStatus === "pending_review" && nextStatus === "rejected") {
        await this.rejectPendingReplacementForPredecessor(storage, card, lock, principal, namespace);
        card = await this.requireCard(storage, card.card.cardId, namespace, principal);
        this.requireRevision(card, parsed.data.expectedRevision);
        this.requireStatus(card, expectedStatus);
      }
      if (
        expectedStatus === "pending_review" ||
        (expectedStatus === "active" && (card.replacesDraftId || card.memory.frontmatter.supersedes))
      ) {
        card = this.projectRequiredCard(
          await this.recoverReplacementTransition(storage, card.memory, lock, principal, namespace, {
            rollbackConflictedApproval: expectedStatus !== "active",
          }),
          namespace,
          principal
        );
      }
      if (card.card.status === nextStatus) return card.card;
      this.requireStatus(card, expectedStatus);
      if (expectedStatus === "active" && nextStatus === "archived") {
        await this.rejectPendingReplacementForPredecessor(storage, card, lock, principal, namespace);
        card = await this.requireCard(storage, card.card.cardId, namespace, principal);
        this.requireRevision(card, parsed.data.expectedRevision);
        this.requireStatus(card, expectedStatus);
      }
      const updatedAt = this.now().toISOString();
      await this.requireOwnerLock(lock);
      const changed = await storage.writeMemoryFrontmatterIfUnchanged(
        card.memory,
        {
          status: nextStatus,
          updated: updatedAt,
          ...(nextStatus === "archived" ? { archivedAt: updatedAt } : {}),
        },
        { actor: principal, reasonCode: nextStatus === "archived" ? "owner-withdrew" : "owner-rejected" }
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

  private async resolveOwnerScope(principal: string): Promise<SupportPassportOwnerScope> {
    const requestedPrincipal = SupportPassportListCardsInputSchema.safeParse({ principal });
    const owner = await this.resolveOwner(principal);
    const namespace = SupportPassportNamespaceSchema.safeParse(owner.namespace);
    const ownerPrincipal = SupportPassportListCardsInputSchema.safeParse({ principal: owner.principal });
    if (
      !requestedPrincipal.success ||
      !namespace.success ||
      !ownerPrincipal.success ||
      ownerPrincipal.data.principal !== requestedPrincipal.data.principal
    ) {
      throw new SupportPassportError("card_data_invalid", "The support passport owner scope is invalid.", 500);
    }
    return { ...owner, principal: ownerPrincipal.data.principal, namespace: namespace.data };
  }

  private async rejectCreatedDraft(
    storage: StorageManager,
    cardId: string,
    reasonCode: string,
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<void> {
    try {
      const current = await this.requireCard(storage, cardId, namespace, principal);
      await this.requireOwnerLock(lock);
      const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
        current.memory,
        { status: "rejected", updated: this.now().toISOString() },
        { actor: principal, reasonCode }
      );
      if (!rejected) log.warn("support passport could not roll back a replacement draft");
    } catch (error) {
      log.warn(
        `support passport could not roll back a replacement draft: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async requireCard(
    storage: StorageManager,
    cardId: string,
    namespace: string,
    principal: string
  ): Promise<StoredSupportPassportCard> {
    const stored = await storage.getMemoryById(cardId);
    const card = stored ? this.projectOwnedCard(stored, namespace, principal) : null;
    if (!card) throw new SupportPassportError("card_not_found", "The support card was not found.", 404);
    return card;
  }

  private projectRequiredCard(memory: MemoryFile, namespace: string, principal: string): StoredSupportPassportCard {
    const card = projectSupportPassportCard(memory);
    if (!card) throw new SupportPassportError("card_data_invalid", "The support card data is invalid.", 500);
    if (card.namespace !== namespace || card.owner !== computeSupportPassportOwnerKey(principal)) {
      throw new SupportPassportError("card_not_found", "The support card was not found.", 404);
    }
    return card;
  }

  private projectOwnedCard(memory: MemoryFile, namespace: string, principal: string): StoredSupportPassportCard | null {
    const card = projectSupportPassportCard(memory);
    return card?.namespace === namespace && card.owner === computeSupportPassportOwnerKey(principal) ? card : null;
  }

  private ownsMemory(memory: MemoryFile, namespace: string, principal: string): boolean {
    const attributes = memory.frontmatter.structuredAttributes;
    return (
      attributes?.[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.namespace] === namespace &&
      attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.owner] === computeSupportPassportOwnerKey(principal)
    );
  }

  private async readProjectedCards(
    storage: StorageManager,
    namespace: string,
    principal: string
  ): Promise<StoredSupportPassportCard[]> {
    const owner = computeSupportPassportOwnerKey(principal);
    const projected = (await storage.readAllMemories())
      .map(projectSupportPassportCard)
      .filter((card): card is StoredSupportPassportCard => card?.namespace === namespace && card.owner === owner);
    const ids = new Set<string>();
    for (const item of projected) {
      if (ids.has(item.card.cardId)) {
        throw new SupportPassportError("card_data_invalid", "Support card IDs must be unique.", 500);
      }
      ids.add(item.card.cardId);
    }
    return projected;
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

  private async readStoredCards(
    storage: StorageManager,
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<StoredSupportPassportCard[]> {
    const initialVersion = storage.getCorpusScanVersion();
    const initial = await storage.readAllMemories();
    for (const memory of initial) {
      const card = this.projectOwnedCard(memory, namespace, principal);
      if (card) await this.recoverReplacementTransition(storage, memory, lock, principal, namespace);
    }
    const memories: MemoryFile[] =
      storage.getCorpusScanVersion() === initialVersion ? initial : await storage.readAllMemories();
    const owner = computeSupportPassportOwnerKey(principal);
    const projected = memories
      .map(projectSupportPassportCard)
      .filter((card): card is StoredSupportPassportCard => card?.namespace === namespace && card.owner === owner);
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
    const visibleCards = storedCards.filter(
      (item) => OWNER_VISIBLE_STATUSES.has(item.card.status) && !item.draftReplacementPrepared
    );
    if (visibleCards.length <= MAX_OWNER_VISIBLE_CARDS) return visibleCards;
    const activeCardsWithPendingReplacements = new Set(
      visibleCards
        .filter((item) => item.card.status === "pending_review")
        .map((item) => item.memory.frontmatter.supersedes)
        .filter((cardId): cardId is string => typeof cardId === "string")
    );
    return visibleCards.filter(
      (item) => item.card.status !== "active" || !activeCardsWithPendingReplacements.has(item.card.cardId)
    );
  }

  private async preparePriorForReplacement(
    storage: StorageManager,
    replacement: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<string | null> {
    const priorId = replacement.memory.frontmatter.supersedes;
    if (!priorId) return null;
    const priorMemory = await storage.getMemoryById(priorId);
    const priorIsOwned = priorMemory ? this.ownsMemory(priorMemory, namespace, principal) : false;
    const alreadyRetired =
      priorIsOwned &&
      priorMemory?.frontmatter.status === "superseded" &&
      priorMemory.frontmatter.supersededBy === replacement.card.cardId;
    const prior = priorMemory && priorIsOwned && !alreadyRetired ? projectSupportPassportCard(priorMemory) : null;
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
    return priorId;
  }

  private async rejectPendingReplacementForPredecessor(
    storage: StorageManager,
    predecessor: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<void> {
    const storedCards =
      predecessor.card.status === "active"
        ? await this.readStoredCards(storage, lock, principal, namespace)
        : await this.readProjectedCards(storage, namespace, principal);
    const replacements = storedCards.filter((item) => {
      if (item.card.status !== "pending_review") return false;
      return predecessor.card.status === "pending_review"
        ? item.replacesDraftId === predecessor.card.cardId
        : item.memory.frontmatter.supersedes === predecessor.card.cardId;
    });
    if (replacements.length > 1) {
      throw new SupportPassportError(
        "storage_conflict",
        "Multiple support card edits target the card being withdrawn.",
        409
      );
    }
    const [replacement] = replacements;
    if (!replacement) return;
    await this.requireOwnerLock(lock);
    const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
      replacement.memory,
      { status: "rejected", updated: this.now().toISOString() },
      {
        actor: principal,
        reasonCode: predecessor.card.status === "pending_review" ? "source-draft-rejected" : "predecessor-withdrawn",
      }
    );
    if (rejected) return;
    const current = await storage.getMemoryById(replacement.card.cardId);
    const currentCard = current ? this.projectOwnedCard(current, namespace, principal) : null;
    if (currentCard?.card.status !== "rejected") {
      throw new SupportPassportError("storage_conflict", "The pending support card edit could not be cancelled.", 409);
    }
  }

  private async validatePriorForReplacement(
    storage: StorageManager,
    replacement: StoredSupportPassportCard,
    namespace: string,
    principal: string
  ): Promise<void> {
    const priorId = replacement.memory.frontmatter.supersedes;
    if (!priorId) return;
    const priorMemory = await storage.getMemoryById(priorId);
    const priorIsOwned = priorMemory ? this.ownsMemory(priorMemory, namespace, principal) : false;
    const alreadyRetired =
      priorIsOwned &&
      priorMemory?.frontmatter.status === "superseded" &&
      priorMemory.frontmatter.supersededBy === replacement.card.cardId;
    const prior = priorMemory && priorIsOwned && !alreadyRetired ? projectSupportPassportCard(priorMemory) : null;
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
    namespace: string,
    options: { rollbackConflictedApproval?: boolean } = {}
  ): Promise<MemoryFile> {
    const replacement = this.projectOwnedCard(memory, namespace, principal);
    if (replacement?.card.status !== "pending_review" && replacement?.card.status !== "active") return memory;
    if (!replacement.replacesDraftId && !memory.frontmatter.supersedes) return memory;
    if (
      replacement.card.status === "active" &&
      memory.frontmatter.structuredAttributes?.[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.replacementComplete] === "true"
    ) {
      return memory;
    }
    await this.recoverReplacedDraft(storage, replacement, lock, principal, namespace);
    const currentMemory = (await storage.getMemoryById(replacement.card.cardId)) ?? memory;
    const currentCard = this.projectOwnedCard(currentMemory, namespace, principal);
    if (currentCard?.card.status !== "pending_review" && currentCard?.card.status !== "active") {
      return currentMemory;
    }
    if (currentCard.card.status === "pending_review") {
      const priorId = currentMemory.frontmatter.supersedes;
      if (!priorId) return currentMemory;
      const prior = await storage.getMemoryById(priorId);
      if (
        prior &&
        this.ownsMemory(prior, namespace, principal) &&
        prior.frontmatter.status === "superseded" &&
        prior.frontmatter.supersededBy === replacement.card.cardId
      ) {
        await this.restorePriorAfterApprovalFailure(
          storage,
          priorId,
          replacement.card.cardId,
          lock,
          principal,
          namespace
        );
      }
      return (await storage.getMemoryById(replacement.card.cardId)) ?? currentMemory;
    }
    try {
      await this.completeReplacementAfterActivation(storage, currentCard, lock, principal, namespace);
    } catch (error) {
      if (!isStorageConflict(error)) throw error;
      if (options.rollbackConflictedApproval === false) throw error;
      await this.rollbackConflictedApproval(storage, currentCard.card.cardId, lock, principal, namespace);
    }
    return (await storage.getMemoryById(replacement.card.cardId)) ?? currentMemory;
  }

  private async completeReplacementAfterActivation(
    storage: StorageManager,
    replacement: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<void> {
    const priorId = await this.preparePriorForReplacement(storage, replacement, lock, principal, namespace);
    if (priorId && !(await this.completePriorRetirement(storage, priorId, replacement, lock, principal, namespace))) {
      throw new SupportPassportError("storage_conflict", "The prior support card changed before replacement.", 409);
    }
    await this.markReplacementComplete(storage, replacement.card.cardId, lock, principal, namespace);
  }

  private async finishCommittedApproval(
    storage: StorageManager,
    replacement: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<SupportPassportCard> {
    try {
      if (replacement.replacesDraftId || replacement.memory.frontmatter.supersedes) {
        await this.completeReplacementAfterActivation(storage, replacement, lock, principal, namespace);
      }
    } catch (error) {
      if (isStorageConflict(error)) {
        await this.rollbackConflictedApproval(storage, replacement.card.cardId, lock, principal, namespace);
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
    namespace: string
  ): Promise<void> {
    const replacement = await this.requireCard(storage, replacementId, namespace, principal);
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
    const priorId = replacement.memory.frontmatter.supersedes;
    if (priorId) {
      await this.restorePriorAfterApprovalFailure(storage, priorId, replacementId, lock, principal, namespace);
    }
  }

  private async completePriorRetirement(
    storage: StorageManager,
    priorId: string,
    replacement: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<boolean> {
    const replacementId = replacement.card.cardId;
    const prior = await storage.getMemoryById(priorId);
    if (
      !prior ||
      !this.ownsMemory(prior, namespace, principal) ||
      prior.frontmatter.status !== "superseded" ||
      prior.frontmatter.supersededBy !== replacementId
    ) {
      return false;
    }
    await this.requireOwnerLock(lock);
    const completed = await storage.supersedeMemory(
      priorId,
      replacementId,
      "support-passport-replacement",
      { supersessionCause: "direct" },
      {
        actor: principal,
        requireActive: true,
        acceptExactReplay: true,
        expectedSnapshot: prior,
        audit: {
          content: stripAttributesSuffix(prior.content),
          tags: ["supersession", "auto-resolved", "support-passport-audit"],
          structuredAttributes: {
            [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.namespace]: namespace,
            [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.owner]: computeSupportPassportOwnerKey(principal),
          },
          source: "support-passport",
        },
      }
    );
    if (!completed) log.warn("support passport could not complete replacement retirement side effects");
    return completed;
  }

  private async recoverReplacedDraft(
    storage: StorageManager,
    replacement: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<void> {
    if (!replacement.replacesDraftId) return;
    const replacedDraft = await storage.getMemoryById(replacement.replacesDraftId);
    const projectedDraft = replacedDraft ? this.projectOwnedCard(replacedDraft, namespace, principal) : null;
    if (
      replacedDraft &&
      projectedDraft?.card.status === "pending_review" &&
      projectedDraft.card.revision === replacement.replacedRevision
    ) {
      await this.requireOwnerLock(lock);
      const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
        replacedDraft,
        { status: "rejected", updated: this.now().toISOString() },
        { actor: principal, reasonCode: "complete-draft-replacement" }
      );
      if (rejected) {
        await this.finishPreparedDraftReplacement(storage, replacement.card.cardId, lock, principal, namespace);
        return;
      }
    }
    const currentDraft = await storage.getMemoryById(replacement.replacesDraftId);
    if (
      currentDraft &&
      this.ownsMemory(currentDraft, namespace, principal) &&
      currentDraft.frontmatter.status === "rejected"
    ) {
      await this.finishPreparedDraftReplacement(storage, replacement.card.cardId, lock, principal, namespace);
      return;
    }
    if (
      currentDraft &&
      this.ownsMemory(currentDraft, namespace, principal) &&
      currentDraft.frontmatter.status === "pending_review"
    ) {
      throw new SupportPassportError("storage_conflict", "The replaced draft changed during recovery.", 409);
    }
    await this.rejectOrphanedReplacement(storage, replacement.card.cardId, lock, principal, namespace);
  }

  private async finishPreparedDraftReplacement(
    storage: StorageManager,
    replacementId: string,
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<SupportPassportCard> {
    const replacement = await this.requireCard(storage, replacementId, namespace, principal);
    if (!replacement.draftReplacementPrepared) return replacement.card;
    const structuredAttributes = { ...replacement.memory.frontmatter.structuredAttributes };
    delete structuredAttributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.draftReplacementPrepared];
    await this.requireOwnerLock(lock);
    const finished = await storage.writeMemoryFrontmatterIfUnchanged(
      replacement.memory,
      { structuredAttributes },
      { actor: principal, reasonCode: "draft-replacement-complete" }
    );
    if (finished) {
      return this.projectRequiredCard(
        { ...replacement.memory, frontmatter: { ...replacement.memory.frontmatter, structuredAttributes } },
        namespace,
        principal
      ).card;
    }
    const current = await this.requireCard(storage, replacementId, namespace, principal);
    if (!current.draftReplacementPrepared) return current.card;
    throw new SupportPassportError("storage_conflict", "The support card edit could not be completed.", 409);
  }

  private async rejectOrphanedReplacement(
    storage: StorageManager,
    replacementId: string,
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<void> {
    const currentReplacement = await this.requireCard(storage, replacementId, namespace, principal);
    if (currentReplacement.card.status === "rejected") return;
    this.requireStatus(currentReplacement, "pending_review");
    await this.requireOwnerLock(lock);
    const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
      currentReplacement.memory,
      { status: "rejected", updated: this.now().toISOString() },
      { actor: principal, reasonCode: "replaced-draft-approved" }
    );
    if (rejected) return;
    const latest = await storage.getMemoryById(replacementId);
    if (latest?.frontmatter.status !== "rejected") {
      throw new SupportPassportError("storage_conflict", "The orphaned replacement could not be rejected.", 409);
    }
  }

  private async restorePriorAfterApprovalFailure(
    storage: StorageManager,
    priorId: string,
    replacementId: string,
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<void> {
    const replacement = await storage.getMemoryById(replacementId);
    if (replacement && !this.ownsMemory(replacement, namespace, principal)) {
      throw new SupportPassportError("storage_conflict", "The replacement support card changed ownership.", 409);
    }
    if (replacement?.frontmatter.status === "active") return;
    const prior = await storage.getMemoryById(priorId);
    if (prior && !this.ownsMemory(prior, namespace, principal)) {
      throw new SupportPassportError("storage_conflict", "The prior support card changed ownership.", 409);
    }
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
    if (restored) return;
    const currentPrior = await storage.getMemoryById(priorId);
    if (currentPrior?.frontmatter.status === "active" && currentPrior.frontmatter.supersededBy === undefined) return;
    throw new SupportPassportError("storage_conflict", "The prior support card could not be restored.", 409);
  }

  private async markReplacementComplete(
    storage: StorageManager,
    replacementId: string,
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<void> {
    const replacement = await this.requireCard(storage, replacementId, namespace, principal);
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
    if (!marked) log.warn("support passport could not mark replacement side effects complete");
  }

  private async requireOwnerLock(lock: HeldFileLockController): Promise<void> {
    if (await lock.refresh()) return;
    throw new SupportPassportError("storage_conflict", "The support passport lock changed. Try again.", 409);
  }
}
