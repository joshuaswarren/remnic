import type { StorageManager } from "../index.js";
import { log } from "../logger.js";
import type { MemoryFile } from "../types.js";
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
  }

  async createManualDraft(input: SupportPassportManualDraftInput): Promise<SupportPassportCard> {
    const parsed = SupportPassportManualDraftInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { storage } = await this.resolveOwner(parsed.data.principal);
    return await this.createDraft(storage, {
      title: parsed.data.title,
      statement: parsed.data.statement,
      category: parsed.data.category,
      reviewBy: parsed.data.reviewBy,
      sourceMemoryIds: [],
    });
  }

  async replaceCard(input: SupportPassportReplaceCardInput): Promise<SupportPassportCard> {
    const parsed = SupportPassportReplaceCardInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { storage } = await this.resolveOwner(parsed.data.principal);
    const prior = await this.requireCard(storage, parsed.data.cardId);
    this.requireRevision(prior, parsed.data.expectedRevision);
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
      supersedes: prior.card.status === "active" ? prior.card.cardId : undefined,
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

    await this.rejectCreatedDraft(storage, replacement.cardId, "draft-replacement-failed");
    throw new SupportPassportError("storage_conflict", "The support card changed before it was edited.", 409);
  }

  async approveCard(input: SupportPassportCardMutationInput): Promise<SupportPassportCard> {
    const { storage, card } = await this.resolveMutation(input, false);
    this.requireStatus(card, "pending_review");
    const retiredPriorId = await this.retirePriorForReplacement(storage, card);
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
        await this.restorePriorAfterApprovalFailure(storage, retiredPriorId, card.card.cardId);
      }
      throw error;
    }
    if (!approved) {
      const current = await storage.getMemoryById(card.card.cardId);
      const currentCard = current ? projectSupportPassportCard(current) : null;
      if (currentCard?.card.status === "active") return currentCard.card;
      if (retiredPriorId) {
        await this.restorePriorAfterApprovalFailure(storage, retiredPriorId, card.card.cardId);
      }
      throw new SupportPassportError("storage_conflict", "The support card changed before approval.", 409);
    }
    return (await this.requireCard(storage, card.card.cardId)).card;
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
      order?: number;
    }
  ): Promise<SupportPassportCard> {
    const now = this.now();
    const reviewBy = input.reviewBy ?? now.toISOString();
    const storedCards = await this.readStoredCards(storage);
    if (storedCards.filter((item) => OWNER_VISIBLE_STATUSES.has(item.card.status)).length >= MAX_OWNER_VISIBLE_CARDS) {
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
    const { storage, card } = await this.resolveMutation(input);
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
      throw new SupportPassportError("storage_conflict", "The support card changed before the request completed.", 409);
    return {
      ...card.card,
      status: nextStatus,
      updatedAt,
      revision: this.revisionFor(card.card, nextStatus, updatedAt),
    };
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
    const current = await this.requireCard(storage, cardId);
    const rejected = await storage.writeMemoryFrontmatterIfUnchanged(
      current.memory,
      { status: "rejected", updated: this.now().toISOString() },
      { actor: "support-passport.replace-draft-rollback", reasonCode }
    );
    if (!rejected) {
      throw new SupportPassportError("storage_conflict", "The replacement support card could not be rolled back.", 500);
    }
  }

  private async resolveMutation(input: SupportPassportCardMutationInput, recover = true) {
    const parsed = SupportPassportCardMutationInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { storage } = await this.resolveOwner(parsed.data.principal);
    const card = await this.requireCard(storage, parsed.data.cardId, recover);
    this.requireRevision(card, parsed.data.expectedRevision);
    return { storage, card };
  }

  private async requireCard(
    storage: StorageManager,
    cardId: string,
    recover = true
  ): Promise<StoredSupportPassportCard> {
    const stored = await storage.getMemoryById(cardId);
    const memory = stored && recover ? await this.recoverReplacementApproval(storage, stored) : stored;
    const card = memory ? projectSupportPassportCard(memory) : null;
    if (!card) throw new SupportPassportError("card_not_found", "The support card was not found.", 404);
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
    const memories: MemoryFile[] = [];
    for (const memory of await storage.readAllMemories()) {
      memories.push(await this.recoverReplacementApproval(storage, memory));
    }
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

  private async retirePriorForReplacement(
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
    if (!priorMemory || (!alreadyRetired && prior?.card.status !== "active")) {
      throw new SupportPassportError("storage_conflict", "The prior support card changed before replacement.", 409);
    }
    const retired = await storage.supersedeMemory(
      priorId,
      replacement.card.cardId,
      "support-passport-replacement",
      { supersessionCause: "direct" },
      {
        requireActive: true,
        acceptExactReplay: true,
        expectedSnapshot: priorMemory,
      }
    );
    if (!retired) {
      throw new SupportPassportError("storage_conflict", "The prior support card changed before replacement.", 409);
    }
    return priorId;
  }

  private async recoverReplacementApproval(storage: StorageManager, memory: MemoryFile): Promise<MemoryFile> {
    const replacement = projectSupportPassportCard(memory);
    const priorId = memory.frontmatter.supersedes;
    if (replacement?.card.status !== "pending_review" || !priorId) return memory;
    const prior = await storage.getMemoryById(priorId);
    if (prior?.frontmatter.status !== "superseded" || prior.frontmatter.supersededBy !== replacement.card.cardId) {
      return memory;
    }
    const recovered = await storage.writeMemoryFrontmatterIfUnchanged(
      memory,
      { status: "active", updated: this.now().toISOString() },
      { actor: "support-passport.approve-recovery", reasonCode: "complete-replacement-approval" }
    );
    if (!recovered) return (await storage.getMemoryById(replacement.card.cardId)) ?? memory;
    return (await storage.getMemoryById(replacement.card.cardId)) ?? memory;
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
