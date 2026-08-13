import type { StorageManager } from "../index.js";
import { log } from "../logger.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import {
  SUPPORT_PASSPORT_ATTRIBUTE_KEYS,
  type StoredSupportPassportCard,
  computeSupportPassportOwnerKey,
  encodeSupportPassportNamespaceAttributes,
  projectSupportPassportCard,
} from "./card-projection.js";
import { ownsMemory } from "./card-state.js";
import { SupportPassportError } from "./errors.js";

export async function validateSupportPassportReplacementPrior(
  storage: StorageManager,
  replacement: StoredSupportPassportCard,
  namespace: string,
  principal: string
): Promise<void> {
  const priorId = replacement.memory.frontmatter.supersedes;
  if (!priorId) return;
  const priorMemory = await storage.getMemoryById(priorId);
  const priorIsOwned = priorMemory ? ownsMemory(priorMemory, namespace, principal) : false;
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

export async function prepareSupportPassportReplacementPrior(input: {
  storage: StorageManager;
  replacement: StoredSupportPassportCard;
  principal: string;
  namespace: string;
  now: () => Date;
  requireOwnerLock: () => Promise<void>;
  onCommitted?: () => void;
}): Promise<string | null> {
  const { storage, replacement, principal, namespace } = input;
  const priorId = replacement.memory.frontmatter.supersedes;
  if (!priorId) return null;
  const priorMemory = await storage.getMemoryById(priorId);
  const priorIsOwned = priorMemory ? ownsMemory(priorMemory, namespace, principal) : false;
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
  const retiredAt = input.now().toISOString();
  await input.requireOwnerLock();
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
  input.onCommitted?.();
  return priorId;
}

export async function completeSupportPassportReplacementPrior(input: {
  storage: StorageManager;
  priorId: string;
  replacement: StoredSupportPassportCard;
  principal: string;
  namespace: string;
  requireOwnerLock: () => Promise<void>;
}): Promise<boolean> {
  const { storage, priorId, replacement, principal, namespace } = input;
  const replacementId = replacement.card.cardId;
  const prior = await storage.getMemoryById(priorId);
  if (
    !prior ||
    !ownsMemory(prior, namespace, principal) ||
    prior.frontmatter.status !== "superseded" ||
    prior.frontmatter.supersededBy !== replacementId
  ) {
    return false;
  }
  await input.requireOwnerLock();
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
          ...encodeSupportPassportNamespaceAttributes(namespace),
          [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.owner]: computeSupportPassportOwnerKey(principal),
        },
        source: "support-passport",
      },
    }
  );
  if (!completed) log.warn("support passport could not complete replacement retirement side effects");
  return completed;
}
