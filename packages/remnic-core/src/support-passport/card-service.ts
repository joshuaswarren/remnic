import type { StorageManager } from "../storage.js";
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
const DEFAULT_REVIEW_INTERVAL_MS = 180 * 24 * 60 * 60 * 1_000;

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
    return SupportPassportCardListSchema.parse(cards);
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
    this.requireStatus(prior, "active");
    return await this.createDraft(storage, {
      title: parsed.data.title,
      statement: parsed.data.statement,
      category: parsed.data.category,
      reviewBy: parsed.data.reviewBy,
      sourceMemoryIds: prior.sourceMemoryIds,
      supersedes: prior.card.cardId,
      order: prior.order,
    });
  }

  async approveCard(input: SupportPassportCardMutationInput): Promise<SupportPassportCard> {
    const { storage, card } = await this.resolveMutation(input);
    this.requireStatus(card, "pending_review");
    const updatedAt = this.now().toISOString();
    const approved = await storage.writeMemoryFrontmatterIfUnchanged(
      card.memory,
      { status: "active", updated: updatedAt },
      { actor: "support-passport.approve", reasonCode: "owner-approved" }
    );
    if (!approved) throw new SupportPassportError("storage_conflict", "The support card changed before approval.", 409);

    if (card.memory.frontmatter.supersedes) {
      const prior = await this.requireCard(storage, card.memory.frontmatter.supersedes);
      const retired = await storage.supersedeMemory(
        prior.card.cardId,
        card.card.cardId,
        "support-passport-replacement",
        { supersessionCause: "direct" },
        { requireActive: true, expectedSnapshot: prior.memory }
      );
      if (!retired) {
        await this.rollbackApproval(storage, card.card.cardId);
        throw new SupportPassportError("storage_conflict", "The prior support card changed before replacement.", 409);
      }
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
    const reviewBy = input.reviewBy ?? new Date(now.getTime() + DEFAULT_REVIEW_INTERVAL_MS).toISOString();
    if (Date.parse(reviewBy) <= now.getTime()) throw invalidInput();
    const order = input.order ?? (await this.nextOrder(storage));
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

  private async rollbackApproval(storage: StorageManager, cardId: string): Promise<void> {
    const current = await this.requireCard(storage, cardId);
    const rolledBack = await storage.writeMemoryFrontmatterIfUnchanged(
      current.memory,
      { status: "pending_review", updated: this.now().toISOString() },
      { actor: "support-passport.approve-rollback", reasonCode: "replacement-retirement-failed" }
    );
    if (!rolledBack) {
      throw new SupportPassportError("storage_conflict", "The replacement support card could not be rolled back.", 500);
    }
  }

  private async resolveMutation(input: SupportPassportCardMutationInput) {
    const parsed = SupportPassportCardMutationInputSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const { storage } = await this.resolveOwner(parsed.data.principal);
    const card = await this.requireCard(storage, parsed.data.cardId);
    this.requireRevision(card, parsed.data.expectedRevision);
    return { storage, card };
  }

  private async requireCard(storage: StorageManager, cardId: string): Promise<StoredSupportPassportCard> {
    const memory = await storage.getMemoryById(cardId);
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

  private async nextOrder(storage: StorageManager): Promise<number> {
    const cards = await this.readStoredCards(storage);
    return cards.reduce((maximum, card) => Math.max(maximum, card.order), -1) + 1;
  }
}
