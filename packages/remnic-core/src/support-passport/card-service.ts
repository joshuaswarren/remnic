import { randomUUID } from "node:crypto";

import type { StorageManager } from "../index.js";
import { log } from "../logger.js";
import type { MemoryFile } from "../types.js";
import type { HeldFileLockController } from "../utils/serialize-mutations.js";
import { composeMemoryEnvelope } from "../write-envelope.js";
import {
  SUPPORT_PASSPORT_ATTRIBUTE_KEYS,
  SUPPORT_PASSPORT_CARD_TAG,
  type StoredSupportPassportCard,
  computeSupportPassportOwnerKey,
  encodeSupportPassportNamespaceAttributes,
} from "./card-projection.js";
import {
  completeSupportPassportReplacementPrior,
  prepareSupportPassportReplacementPrior,
  validateSupportPassportReplacementPrior,
} from "./card-replacement.js";
import {
  MAX_OWNER_VISIBLE_CARDS,
  type SupportPassportCardServiceDependencies,
  type SupportPassportOwnerScope,
  invalidInput,
  isStorageConflict,
  once,
  ownerListCards,
  ownerVisibleCards,
  ownsMemory,
  projectOwnedCard,
  projectRequiredCard,
  requireRevision,
  requireStatus,
  revisionFor,
  validateOwnerScope,
} from "./card-state.js";
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
} from "./contracts.js";
import { SupportPassportError } from "./errors.js";
import {
  type GeneratedBatchMarker,
  commitSupportPassportGeneratedBatch,
  isCommittedGeneratedCard,
  persistSupportPassportGeneratedBatchMarker,
  projectCommittedSupportPassportCards,
  readCommittedSupportPassportCards,
  recoverSupportPassportGeneratedBatches,
  rollbackSupportPassportGeneratedBatch,
} from "./generated-batch.js";
import { type SupportPassportDraftCard, SupportPassportDraftOutputSchema } from "./model-contracts.js";
import { withSupportPassportOwnerLock } from "./owner-lock.js";
export type { SupportPassportCardServiceDependencies, SupportPassportOwnerScope } from "./card-state.js";
export class SupportPassportCardService {
  private readonly resolveOwner: SupportPassportCardServiceDependencies["resolveOwner"];
  private readonly now: () => Date;
  constructor(dependencies: SupportPassportCardServiceDependencies) {
    this.resolveOwner = dependencies.resolveOwner;
    this.now = dependencies.now ?? (() => new Date());
  }

  async listCards(input: {
    principal: string;
  }): Promise<SupportPassportCard[]> {
    const parsed = SupportPassportListCardsInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { principal, namespace, storage } = await this.resolveOwnerScope(parsed.data.principal);
    return await withSupportPassportOwnerLock(storage, { namespace, principal }, async () => {
      const memories = await storage.readAllMemories();
      const stored = await projectCommittedSupportPassportCards(storage, memories, namespace, principal);
      const cards = ownerListCards(stored)
        .sort((a, b) => a.order - b.order || a.card.cardId.localeCompare(b.card.cardId))
        .map((item) => item.card);
      const output = SupportPassportCardListSchema.safeParse(cards);
      if (!output.success) {
        throw new SupportPassportError("card_data_invalid", "The support card data is invalid.", 500);
      }
      return output.data;
    });
  }

  async createManualDraft(
    input: SupportPassportManualDraftInput,
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    const parsed = SupportPassportManualDraftInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { principal, namespace, storage } = await this.resolveOwnerScope(parsed.data.principal);
    const onCommitted = once(options.onCommitted);
    return await withSupportPassportOwnerLock(storage, { namespace, principal }, async (lock) => {
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
        principal,
        namespace
      );
      if (!options.signal?.aborted) return created;
      if (!(await this.rejectGeneratedDraft(storage, created.cardId, lock, principal, namespace))) {
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
    const principal = SupportPassportListCardsInputSchema.safeParse({
      principal: input.principal,
    });
    if (!principal.success) throw invalidInput();
    const owner = await this.resolveOwnerScope(principal.data.principal);
    return await this.createGeneratedDraftsForOwner({
      authenticatedPrincipal: principal.data.principal,
      owner,
      cards: input.cards,
    });
  }

  async createGeneratedDraftsForOwner(input: {
    authenticatedPrincipal: string;
    owner: SupportPassportOwnerScope;
    cards: SupportPassportDraftCard[];
    signal?: AbortSignal;
    onCommitted?: () => void;
    commitWithValidatedSources?: (commit: () => Promise<void>) => Promise<void>;
  }): Promise<SupportPassportCard[]> {
    const output = SupportPassportDraftOutputSchema.safeParse({
      cards: input.cards,
    });
    if (!output.success) throw invalidInput();
    const owner = validateOwnerScope(input.owner, input.authenticatedPrincipal);
    const { principal, namespace, storage } = owner;
    const onCommitted = once(input.onCommitted);
    return await withSupportPassportOwnerLock(storage, { namespace, principal }, async (lock) => {
      const batchContext = this.generatedBatchContext(storage, lock, principal, namespace, onCommitted);
      const batchId = randomUUID();
      const created: SupportPassportCard[] = [];
      const createdIds: string[] = [];
      const createdRecords: StoredSupportPassportCard[] = [];
      let marker: GeneratedBatchMarker | null = null;
      try {
        input.signal?.throwIfAborted();
        input.signal?.throwIfAborted();
        const storedCards = await this.readStoredCards(storage, lock, principal, namespace, onCommitted);
        if (ownerVisibleCards(storedCards).length + output.data.cards.length > MAX_OWNER_VISIBLE_CARDS) {
          throw new SupportPassportError(
            "invalid_input",
            "A support passport can contain at most 100 visible cards.",
            400
          );
        }
        let nextOrder = storedCards.reduce((maximum, card) => Math.max(maximum, card.order), -1) + 1;
        marker = await persistSupportPassportGeneratedBatchMarker(batchContext, batchId, output.data.cards.length);
        for (const card of output.data.cards) {
          input.signal?.throwIfAborted();
          created.push(
            await this.persistDraft(
              storage,
              {
                title: card.title,
                statement: card.statement,
                category: card.category,
                sourceMemoryIds: card.sourceMemoryIds,
                order: nextOrder,
                generatedBatch: { batchId, size: output.data.cards.length },
                onPersisted: (record) => {
                  createdIds.push(record.card.cardId);
                  createdRecords.push(record);
                  onCommitted();
                },
              },
              lock,
              principal,
              namespace
            )
          );
          nextOrder += 1;
        }
        input.signal?.throwIfAborted();
        const commit = async () =>
          await commitSupportPassportGeneratedBatch(batchContext, marker!, createdRecords);
        if (input.commitWithValidatedSources) await input.commitWithValidatedSources(commit);
        else await commit();
        return created;
      } catch (error) {
        if (!marker) throw error;
        if (
          !(await rollbackSupportPassportGeneratedBatch(batchContext, batchId, createdIds))
        ) {
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
    const { principal, namespace, storage } = await this.resolveOwnerScope(parsed.data.principal);
    const onCommitted = once(options.onCommitted);
    return await withSupportPassportOwnerLock(storage, { namespace, principal }, async (lock) => {
      options.signal?.throwIfAborted();
      const loadedPrior = await this.requireCard(storage, parsed.data.cardId, namespace, principal);
      const storedCards = await readCommittedSupportPassportCards(storage, namespace, principal);
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
          namespace,
          {},
          onCommitted
        );
        return projectRequiredCard(recovered, namespace, principal).card;
      }
      requireRevision(loadedPrior, parsed.data.expectedRevision);
      await this.readStoredCards(storage, lock, principal, namespace, onCommitted);
      const refreshedPrior = await this.requireCard(storage, parsed.data.cardId, namespace, principal);
      requireRevision(refreshedPrior, parsed.data.expectedRevision);
      const recoveredMemory = await this.recoverReplacementTransition(
        storage,
        refreshedPrior.memory,
        lock,
        principal,
        namespace,
        {},
        onCommitted
      );
      const prior = projectRequiredCard(recoveredMemory, namespace, principal);
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
          onCommitted,
        },
        lock,
        principal,
        namespace
      );
      if (options.signal?.aborted) {
        if (!(await this.rejectGeneratedDraft(storage, replacement.cardId, lock, principal, namespace))) {
          throw new SupportPassportError(
            "storage_conflict",
            "A cancelled support card edit could not be rolled back.",
            500
          );
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
        return await this.finishPreparedDraftReplacement(
          storage,
          replacement.cardId,
          lock,
          principal,
          namespace,
          onCommitted
        );
      }
      const currentPrior = await storage.getMemoryById(prior.card.cardId);
      const currentPriorCard = currentPrior ? projectOwnedCard(currentPrior, namespace, principal) : null;
      if (currentPriorCard?.card.status === "rejected") {
        return await this.finishPreparedDraftReplacement(
          storage,
          replacement.cardId,
          lock,
          principal,
          namespace,
          onCommitted
        );
      }

      await this.rejectCreatedDraft(
        storage,
        replacement.cardId,
        "draft-replacement-failed",
        lock,
        principal,
        namespace,
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
    const { principal, namespace, storage } = await this.resolveOwnerScope(parsed.data.principal);
    const onCommitted = once(options.onCommitted);
    return await withSupportPassportOwnerLock(storage, { namespace, principal }, async (lock) => {
      options.signal?.throwIfAborted();
      const loadedCard = await this.requireCard(storage, parsed.data.cardId, namespace, principal);
      requireRevision(loadedCard, parsed.data.expectedRevision);
      requireStatus(loadedCard, "pending_review");
      const recoveredMemory = await this.recoverReplacementTransition(
        storage,
        loadedCard.memory,
        lock,
        principal,
        namespace,
        {},
        onCommitted
      );
      const card = projectRequiredCard(recoveredMemory, namespace, principal);
      if (card.card.status === "active") return card.card;
      if (card.card.status === "rejected") {
        throw new SupportPassportError(
          "storage_conflict",
          "The support card was rejected while its replacement state was recovered.",
          409
        );
      }
      requireStatus(card, "pending_review");
      await validateSupportPassportReplacementPrior(storage, card, namespace, principal);
      const updatedAt = this.now().toISOString();
      await this.requireOwnerLock(lock);
      let approved: boolean;
      try {
        approved = await storage.writeMemoryFrontmatterIfUnchanged(
          card.memory,
          { status: "active", updated: updatedAt },
          {
            actor: principal,
            reasonCode: parsed.data.reasonCode ?? "owner-approved",
          }
        );
      } catch (error) {
        const current = await storage.getMemoryById(card.card.cardId);
        const currentCard = current ? projectOwnedCard(current, namespace, principal) : null;
        if (currentCard?.card.status === "active") {
          onCommitted();
          return await this.finishCommittedApproval(storage, currentCard, lock, principal, namespace, onCommitted);
        }
        throw error;
      }
      if (!approved) {
        const current = await storage.getMemoryById(card.card.cardId);
        const currentCard = current ? projectOwnedCard(current, namespace, principal) : null;
        if (currentCard?.card.status === "active") {
          onCommitted();
          return await this.finishCommittedApproval(storage, currentCard, lock, principal, namespace, onCommitted);
        }
        throw new SupportPassportError("storage_conflict", "The support card changed before approval.", 409);
      }
      const committedCard: SupportPassportCard = {
        ...card.card,
        status: "active",
        updatedAt,
        revision: revisionFor(card.card, "active", updatedAt),
      };
      onCommitted();
      try {
        const current = await this.requireCard(storage, card.card.cardId, namespace, principal);
        return await this.finishCommittedApproval(storage, current, lock, principal, namespace, onCommitted);
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
      replacedRevision?: string;
      order?: number;
      draftReplacementPrepared?: boolean;
      generatedBatch?: { batchId: string; size: number };
      onPersisted?: (card: StoredSupportPassportCard) => void;
      onCommitted?: () => void;
    },
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<SupportPassportCard> {
    const now = this.now();
    const reviewBy = input.reviewBy ?? now.toISOString();
    const storedCards = await this.readStoredCards(storage, lock, principal, namespace, input.onCommitted);
    const visibleCards = ownerListCards(storedCards);
    const replacesVisibleCard = visibleCards.some(
      (item) =>
        (input.replacesDraftId === item.card.cardId && item.card.status === "pending_review") ||
        (input.supersedes === item.card.cardId && item.card.status === "active")
    );
    if (visibleCards.length - (replacesVisibleCard ? 1 : 0) >= MAX_OWNER_VISIBLE_CARDS) {
      throw new SupportPassportError("invalid_input", "A support passport can contain at most 100 visible cards.", 400);
    }
    const order = input.order ?? storedCards.reduce((maximum, card) => Math.max(maximum, card.order), -1) + 1;
    return await this.persistDraft(storage, { ...input, order }, lock, principal, namespace);
  }

  private async persistDraft(
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
      order: number;
      draftReplacementPrepared?: boolean;
      generatedBatch?: { batchId: string; size: number };
      onPersisted?: (card: StoredSupportPassportCard) => void;
      onCommitted?: () => void;
    },
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<SupportPassportCard> {
    const now = this.now();
    const reviewBy = input.reviewBy ?? now.toISOString();
    const order = input.order;
    if (!Number.isSafeInteger(order)) {
      throw new SupportPassportError("storage_conflict", "The support card order range is exhausted.", 409);
    }
    const envelope = composeMemoryEnvelope(
      {
        content: input.statement,
        category: "preference",
        tags: [SUPPORT_PASSPORT_CARD_TAG],
        structuredAttributes: {
          ...encodeSupportPassportNamespaceAttributes(namespace),
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.owner]: computeSupportPassportOwnerKey(principal),
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.title]: input.title,
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.category]: input.category,
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.order]: String(order),
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.reviewBy]: reviewBy,
          ...(input.replacesDraftId
            ? {
                [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.replacesDraftId]: input.replacesDraftId,
              }
            : {}),
          ...(input.replacedRevision
            ? {
                [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.replacedRevision]: input.replacedRevision,
              }
            : {}),
          ...(input.draftReplacementPrepared
            ? {
                [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.draftReplacementPrepared]: "true",
              }
            : {}),
          ...(input.generatedBatch
            ? {
                [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.generatedBatchId]: input.generatedBatch.batchId,
                [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.generatedBatchSize]: String(input.generatedBatch.size),
              }
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
    const stored = projectRequiredCard(written.memory, namespace, principal);
    input.onPersisted?.(stored);
    if (!input.generatedBatch) input.onCommitted?.();
    return stored.card;
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
    const { principal, namespace, storage } = await this.resolveOwnerScope(parsed.data.principal);
    const onCommitted = once(options.onCommitted);
    return await withSupportPassportOwnerLock(storage, { namespace, principal }, async (lock) => {
      options.signal?.throwIfAborted();
      let card = await this.requireCard(storage, parsed.data.cardId, namespace, principal);
      requireRevision(card, parsed.data.expectedRevision);
      requireStatus(card, expectedStatus);
      if (expectedStatus === "pending_review" && nextStatus === "rejected") {
        await this.rejectPendingReplacementForPredecessor(storage, card, lock, principal, namespace, onCommitted);
        card = await this.requireCard(storage, card.card.cardId, namespace, principal);
        requireRevision(card, parsed.data.expectedRevision);
        requireStatus(card, expectedStatus);
      }
      if (
        expectedStatus === "pending_review" ||
        (expectedStatus === "active" && (card.replacesDraftId || card.memory.frontmatter.supersedes))
      ) {
        card = projectRequiredCard(
          await this.recoverReplacementTransition(
            storage,
            card.memory,
            lock,
            principal,
            namespace,
            {
              rollbackConflictedApproval: expectedStatus !== "active",
            },
            onCommitted
          ),
          namespace,
          principal
        );
      }
      if (card.card.status === nextStatus) return card.card;
      requireStatus(card, expectedStatus);
      if (expectedStatus === "active" && nextStatus === "archived") {
        await this.rejectPendingReplacementForPredecessor(storage, card, lock, principal, namespace, onCommitted);
        card = await this.requireCard(storage, card.card.cardId, namespace, principal);
        requireRevision(card, parsed.data.expectedRevision);
        requireStatus(card, expectedStatus);
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
        {
          actor: principal,
          reasonCode: parsed.data.reasonCode ?? defaultReasonCode,
        }
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
        revision: revisionFor(card.card, nextStatus, updatedAt),
      };
    });
  }

  private async resolveOwnerScope(principal: string): Promise<SupportPassportOwnerScope> {
    const owner = await this.resolveOwner(principal);
    return validateOwnerScope(owner, principal);
  }

  private async rejectCreatedDraft(
    storage: StorageManager,
    cardId: string,
    reasonCode: string,
    lock: HeldFileLockController,
    principal: string,
    namespace: string,
    onCommitted?: () => void
  ): Promise<void> {
    try {
      const current = await this.requireCard(storage, cardId, namespace, principal);
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
    lock: HeldFileLockController,
    principal: string,
    namespace: string
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const memory = await storage.getMemoryById(cardId);
      if (!memory) return true;
      const stored = projectOwnedCard(memory, namespace, principal);
      if (!stored) return false;
      if (stored.card.status === "rejected") return true;
      if (stored.card.status !== "pending_review") return false;
      await this.requireOwnerLock(lock);
      const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
        memory,
        { status: "rejected", updated: this.now().toISOString() },
        { actor: principal, reasonCode: "draft-batch-failed" }
      );
      if (rejected) return true;
    }
    return false;
  }

  private async readStoredCards(
    storage: StorageManager,
    lock: HeldFileLockController,
    principal: string,
    namespace: string,
    onCommitted?: () => void
  ): Promise<StoredSupportPassportCard[]> {
    const initialVersion = storage.getCorpusScanVersion();
    const initial = await storage.readAllMemories();
    await recoverSupportPassportGeneratedBatches(
      this.generatedBatchContext(storage, lock, principal, namespace, onCommitted),
      initial
    );
    for (const memory of initial) {
      const card = projectOwnedCard(memory, namespace, principal);
      if (card) {
        await this.recoverReplacementTransition(storage, memory, lock, principal, namespace, {}, onCommitted);
      }
    }
    const memories: MemoryFile[] =
      storage.getCorpusScanVersion() === initialVersion ? initial : await storage.readAllMemories();
    return await projectCommittedSupportPassportCards(storage, memories, namespace, principal);
  }

  private generatedBatchContext(
    storage: StorageManager,
    lock: HeldFileLockController,
    principal: string,
    namespace: string,
    onCommitted?: () => void
  ) {
    return {
      storage,
      principal,
      namespace,
      now: this.now,
      requireOwnerLock: async () => await this.requireOwnerLock(lock),
      ...(onCommitted ? { onCommitted } : {}),
    };
  }

  private async rejectPendingReplacementForPredecessor(
    storage: StorageManager,
    predecessor: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    namespace: string,
    onCommitted?: () => void
  ): Promise<void> {
    const storedCards =
      predecessor.card.status === "active"
        ? await this.readStoredCards(storage, lock, principal, namespace, onCommitted)
        : await readCommittedSupportPassportCards(storage, namespace, principal);
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
    if (rejected) {
      onCommitted?.();
      return;
    }
    const current = await storage.getMemoryById(replacement.card.cardId);
    const currentCard = current ? projectOwnedCard(current, namespace, principal) : null;
    if (currentCard?.card.status !== "rejected") {
      throw new SupportPassportError("storage_conflict", "The pending support card edit could not be cancelled.", 409);
    }
  }

  private async recoverReplacementTransition(
    storage: StorageManager,
    memory: MemoryFile,
    lock: HeldFileLockController,
    principal: string,
    namespace: string,
    options: { rollbackConflictedApproval?: boolean } = {},
    onCommitted?: () => void
  ): Promise<MemoryFile> {
    const replacement = projectOwnedCard(memory, namespace, principal);
    if (replacement?.card.status !== "pending_review" && replacement?.card.status !== "active") return memory;
    if (!replacement.replacesDraftId && !memory.frontmatter.supersedes) return memory;
    if (
      replacement.card.status === "active" &&
      memory.frontmatter.structuredAttributes?.[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.replacementComplete] === "true"
    ) {
      return memory;
    }
    await this.recoverReplacedDraft(storage, replacement, lock, principal, namespace, onCommitted);
    const currentMemory = (await storage.getMemoryById(replacement.card.cardId)) ?? memory;
    const currentCard = projectOwnedCard(currentMemory, namespace, principal);
    if (currentCard?.card.status !== "pending_review" && currentCard?.card.status !== "active") {
      return currentMemory;
    }
    if (currentCard.card.status === "pending_review") {
      const priorId = currentMemory.frontmatter.supersedes;
      if (!priorId) return currentMemory;
      const prior = await storage.getMemoryByIdIncludingArchived(priorId);
      if (
        prior &&
        ownsMemory(prior, namespace, principal) &&
        prior.frontmatter.status === "superseded" &&
        prior.frontmatter.supersededBy === replacement.card.cardId
      ) {
        await this.restorePriorAfterApprovalFailure(
          storage,
          priorId,
          replacement.card.cardId,
          lock,
          principal,
          namespace,
          onCommitted
        );
      }
      return (await storage.getMemoryById(replacement.card.cardId)) ?? currentMemory;
    }
    try {
      await this.completeReplacementAfterActivation(storage, currentCard, lock, principal, namespace, onCommitted);
    } catch (error) {
      if (!isStorageConflict(error)) throw error;
      if (options.rollbackConflictedApproval === false) throw error;
      await this.rollbackConflictedApproval(storage, currentCard.card.cardId, lock, principal, namespace, onCommitted);
    }
    return (await storage.getMemoryById(replacement.card.cardId)) ?? currentMemory;
  }

  private async completeReplacementAfterActivation(
    storage: StorageManager,
    replacement: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    namespace: string,
    onCommitted?: () => void
  ): Promise<void> {
    const priorId = await prepareSupportPassportReplacementPrior({
      storage,
      replacement,
      principal,
      namespace,
      now: this.now,
      requireOwnerLock: () => this.requireOwnerLock(lock),
      onCommitted,
    });
    if (
      priorId &&
      !(await completeSupportPassportReplacementPrior({
        storage,
        priorId,
        replacement,
        principal,
        namespace,
        requireOwnerLock: () => this.requireOwnerLock(lock),
      }))
    ) {
      throw new SupportPassportError("storage_conflict", "The prior support card changed before replacement.", 409);
    }
    if (priorId) onCommitted?.();
    await this.markReplacementComplete(storage, replacement.card.cardId, lock, principal, namespace, onCommitted);
  }

  private async finishCommittedApproval(
    storage: StorageManager,
    replacement: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    namespace: string,
    onCommitted?: () => void
  ): Promise<SupportPassportCard> {
    try {
      if (replacement.replacesDraftId || replacement.memory.frontmatter.supersedes) {
        await this.completeReplacementAfterActivation(storage, replacement, lock, principal, namespace, onCommitted);
      }
    } catch (error) {
      if (isStorageConflict(error)) {
        await this.rollbackConflictedApproval(
          storage,
          replacement.card.cardId,
          lock,
          principal,
          namespace,
          onCommitted
        );
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
    namespace: string,
    onCommitted?: () => void
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
    onCommitted?.();
    const priorId = replacement.memory.frontmatter.supersedes;
    if (priorId) {
      await this.restorePriorAfterApprovalFailure(
        storage,
        priorId,
        replacementId,
        lock,
        principal,
        namespace,
        onCommitted
      );
    }
  }

  private async recoverReplacedDraft(
    storage: StorageManager,
    replacement: StoredSupportPassportCard,
    lock: HeldFileLockController,
    principal: string,
    namespace: string,
    onCommitted?: () => void
  ): Promise<void> {
    if (!replacement.replacesDraftId) return;
    // Tier-independent: an interrupted edit's rejected predecessor can be
    // demoted to the cold tier before recovery runs; a hot-only lookup would
    // mistake it for deleted and orphan the valid replacement (#2387).
    const replacedDraft = await storage.getMemoryByIdIncludingArchived(replacement.replacesDraftId);
    const projectedDraft = replacedDraft ? projectOwnedCard(replacedDraft, namespace, principal) : null;
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
        onCommitted?.();
        await this.finishPreparedDraftReplacement(
          storage,
          replacement.card.cardId,
          lock,
          principal,
          namespace,
          onCommitted
        );
        return;
      }
    }
    const currentDraft = await storage.getMemoryByIdIncludingArchived(replacement.replacesDraftId);
    if (
      currentDraft &&
      ownsMemory(currentDraft, namespace, principal) &&
      currentDraft.frontmatter.status === "rejected"
    ) {
      await this.finishPreparedDraftReplacement(
        storage,
        replacement.card.cardId,
        lock,
        principal,
        namespace,
        onCommitted
      );
      return;
    }
    if (
      currentDraft &&
      ownsMemory(currentDraft, namespace, principal) &&
      currentDraft.frontmatter.status === "pending_review"
    ) {
      throw new SupportPassportError("storage_conflict", "The replaced draft changed during recovery.", 409);
    }
    await this.rejectOrphanedReplacement(storage, replacement.card.cardId, lock, principal, namespace, onCommitted);
  }

  private async finishPreparedDraftReplacement(
    storage: StorageManager,
    replacementId: string,
    lock: HeldFileLockController,
    principal: string,
    namespace: string,
    onCommitted?: () => void
  ): Promise<SupportPassportCard> {
    const replacement = await this.requireCard(storage, replacementId, namespace, principal);
    if (!replacement.draftReplacementPrepared) return replacement.card;
    const structuredAttributes = {
      ...replacement.memory.frontmatter.structuredAttributes,
    };
    delete structuredAttributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.draftReplacementPrepared];
    await this.requireOwnerLock(lock);
    const finished = await storage.writeMemoryFrontmatterIfUnchanged(
      replacement.memory,
      { structuredAttributes },
      { actor: principal, reasonCode: "draft-replacement-complete" }
    );
    if (finished) {
      onCommitted?.();
      return projectRequiredCard(
        {
          ...replacement.memory,
          frontmatter: {
            ...replacement.memory.frontmatter,
            structuredAttributes,
          },
        },
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
    namespace: string,
    onCommitted?: () => void
  ): Promise<void> {
    const currentReplacement = await this.requireCard(storage, replacementId, namespace, principal);
    if (currentReplacement.card.status === "rejected") return;
    requireStatus(currentReplacement, "pending_review");
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

  private async restorePriorAfterApprovalFailure(
    storage: StorageManager,
    priorId: string,
    replacementId: string,
    lock: HeldFileLockController,
    principal: string,
    namespace: string,
    onCommitted?: () => void
  ): Promise<void> {
    const replacement = await storage.getMemoryById(replacementId);
    if (replacement && !ownsMemory(replacement, namespace, principal)) {
      throw new SupportPassportError("storage_conflict", "The replacement support card changed ownership.", 409);
    }
    if (replacement?.frontmatter.status === "active") return;
    const prior = await storage.getMemoryById(priorId);
    if (prior && !ownsMemory(prior, namespace, principal)) {
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
    namespace: string,
    onCommitted?: () => void
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
    if (marked) onCommitted?.();
    else log.warn("support passport could not mark replacement side effects complete");
  }

  private async requireOwnerLock(lock: HeldFileLockController): Promise<void> {
    if (await lock.refresh()) return;
    throw new SupportPassportError("storage_conflict", "The support passport lock changed. Try again.", 409);
  }

  private async requireCard(
    storage: StorageManager,
    cardId: string,
    namespace: string,
    principal: string
  ): Promise<StoredSupportPassportCard> {
    const memory = await storage.getMemoryById(cardId);
    const card = memory ? projectOwnedCard(memory, namespace, principal) : null;
    if (card && (await isCommittedGeneratedCard(storage, card))) return card;
    throw new SupportPassportError("card_not_found", "The support card was not found.", 404);
  }
}
