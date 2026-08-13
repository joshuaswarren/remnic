import type { StorageManager } from "../index.js";
import type { MemoryFile } from "../types.js";
import {
  SUPPORT_PASSPORT_ATTRIBUTE_KEYS,
  type StoredSupportPassportCard,
  activeSupportPassportReplacementPredecessorIds,
  computeSupportPassportOwnerKey,
  decodeSupportPassportNamespaceAttributes,
  projectSupportPassportCard,
} from "./card-projection.js";
import { type SupportPassportCard, computeSupportPassportCardRevision } from "./contracts.js";
import { SupportPassportListCardsInputSchema, SupportPassportNamespaceSchema } from "./contracts.js";
import { SupportPassportError } from "./errors.js";

export interface SupportPassportOwnerScope {
  principal: string;
  namespace: string;
  storage: StorageManager;
}

export interface SupportPassportCardServiceDependencies {
  resolveOwner(principal: string): Promise<SupportPassportOwnerScope>;
  now?: () => Date;
}

export function invalidInput(): SupportPassportError {
  return new SupportPassportError("invalid_input", "The support card request is invalid.", 400);
}

export function isStorageConflict(error: unknown): error is SupportPassportError {
  return error instanceof SupportPassportError && error.code === "storage_conflict";
}

export function once(callback: (() => void) | undefined): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback?.();
  };
}

export function validateOwnerScope(owner: SupportPassportOwnerScope, principal: string): SupportPassportOwnerScope {
  const requestedPrincipal = SupportPassportListCardsInputSchema.safeParse({ principal });
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

export const MAX_OWNER_VISIBLE_CARDS = 100;

const OWNER_VISIBLE_STATUSES = new Set(["pending_review", "active"]);

export function revisionFor(
  card: SupportPassportCard,
  status: SupportPassportCard["status"],
  updatedAt: string
): string {
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

export function projectRequiredCard(
  memory: MemoryFile,
  namespace: string,
  principal: string
): StoredSupportPassportCard {
  const card = projectSupportPassportCard(memory);
  if (!card) throw new SupportPassportError("card_data_invalid", "The support card data is invalid.", 500);
  if (card.namespace !== namespace || card.owner !== computeSupportPassportOwnerKey(principal)) {
    throw new SupportPassportError("card_not_found", "The support card was not found.", 404);
  }
  return card;
}

export function projectOwnedCard(
  memory: MemoryFile,
  namespace: string,
  principal: string
): StoredSupportPassportCard | null {
  const card = projectSupportPassportCard(memory);
  return card?.namespace === namespace && card.owner === computeSupportPassportOwnerKey(principal) ? card : null;
}

export function ownsMemory(memory: MemoryFile, namespace: string, principal: string): boolean {
  const attributes = memory.frontmatter.structuredAttributes;
  return (
    attributes !== undefined &&
    decodeSupportPassportNamespaceAttributes(attributes) === namespace &&
    attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.owner] === computeSupportPassportOwnerKey(principal)
  );
}

export function requireRevision(card: StoredSupportPassportCard, expectedRevision: string): void {
  if (card.card.revision !== expectedRevision) {
    throw new SupportPassportError("revision_conflict", "The support card changed after it was loaded.", 409);
  }
}

export function requireStatus(card: StoredSupportPassportCard, status: SupportPassportCard["status"]): void {
  if (card.card.status !== status) {
    throw new SupportPassportError("invalid_card_status", `The support card must have status ${status}.`, 409);
  }
}

export function ownerVisibleCards(storedCards: StoredSupportPassportCard[]): StoredSupportPassportCard[] {
  const visibleCards = storedCards.filter(
    (item) => OWNER_VISIBLE_STATUSES.has(item.card.status) && !item.draftReplacementPrepared
  );
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

export function ownerListCards(storedCards: StoredSupportPassportCard[]): StoredSupportPassportCard[] {
  const visibleCards = ownerVisibleCards(storedCards);
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
