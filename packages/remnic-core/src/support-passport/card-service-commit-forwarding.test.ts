import assert from "node:assert/strict";
import test from "node:test";

import type { StorageManager } from "../index.js";
import type { MemoryFile } from "../types.js";
import type { HeldFileLockController } from "../utils/serialize-mutations.js";
import {
  SUPPORT_PASSPORT_ATTRIBUTE_KEYS,
  SUPPORT_PASSPORT_CARD_TAG,
  type StoredSupportPassportCard,
  computeSupportPassportOwnerKey,
  projectSupportPassportCard,
} from "./card-projection.js";
import type { SupportPassportCard } from "./contracts.js";
import { SupportPassportCardService } from "./card-service.js";

const PRINCIPAL = "owner:alice";
const NAMESPACE = "alice";

function memory(id: string, status: "pending_review" | "rejected", replacesDraftId?: string): MemoryFile {
  return {
    path: `/memory/preferences/${id}.md`,
    content: "Offer me a quiet place and time.",
    frontmatter: {
      id,
      category: "preference",
      source: "support-passport",
      confidence: 1,
      confidenceTier: "explicit",
      created: "2026-08-11T12:00:00.000Z",
      updated: "2026-08-11T12:00:00.000Z",
      status,
      tags: [SUPPORT_PASSPORT_CARD_TAG],
      structuredAttributes: {
        [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.namespace]: NAMESPACE,
        [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.owner]: computeSupportPassportOwnerKey(PRINCIPAL),
        [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.title]: "Quiet space",
        [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.category]: "environment",
        [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.order]: "0",
        [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.reviewBy]: "2026-09-01T12:00:00.000Z",
        [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.sourceMemoryIds]: "",
        ...(replacesDraftId
          ? {
              [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.replacesDraftId]: replacesDraftId,
              [SUPPORT_PASSPORT_ATTRIBUTE_KEYS.draftReplacementPrepared]: "true",
            }
          : {}),
      },
    },
  } as MemoryFile;
}

test("rejected-draft recovery forwards the commit notification", async () => {
  const replaced = memory("draft-one", "rejected");
  const replacement = projectSupportPassportCard(memory("draft-two", "pending_review", "draft-one"));
  assert.ok(replacement);
  const storage = {
    getMemoryById: async (id: string) => (id === "draft-one" ? replaced : null),
    getMemoryByIdIncludingArchived: async (id: string) => (id === "draft-one" ? replaced : null),
  } as unknown as StorageManager;
  const service = new SupportPassportCardService({
    resolveOwner: async () => ({ principal: PRINCIPAL, namespace: NAMESPACE, storage }),
  });
  let commitNotifications = 0;
  const inspected = service as unknown as {
    recoverReplacedDraft(
      target: StorageManager,
      card: StoredSupportPassportCard,
      lock: HeldFileLockController,
      principal: string,
      namespace: string,
      onCommitted?: () => void
    ): Promise<void>;
    finishPreparedDraftReplacement(
      target: StorageManager,
      replacementId: string,
      lock: HeldFileLockController,
      principal: string,
      namespace: string,
      onCommitted?: () => void
    ): Promise<SupportPassportCard>;
  };
  inspected.finishPreparedDraftReplacement = async (
    _target,
    _replacementId,
    _lock,
    _principal,
    _namespace,
    onCommitted
  ) => {
    onCommitted?.();
    return replacement.card;
  };

  await inspected.recoverReplacedDraft(
    storage,
    replacement,
    {} as HeldFileLockController,
    PRINCIPAL,
    NAMESPACE,
    () => {
      commitNotifications += 1;
    }
  );

  assert.equal(commitNotifications, 1);
});

test("pre-write card recovery forwards the commit notification", async () => {
  const replacementMemory = memory("draft-two", "pending_review", "draft-one");
  const storage = {
    getCorpusScanVersion: () => "1:0",
    readAllMemories: async () => [replacementMemory],
  } as unknown as StorageManager;
  const service = new SupportPassportCardService({
    resolveOwner: async () => ({ principal: PRINCIPAL, namespace: NAMESPACE, storage }),
  });
  let commitNotifications = 0;
  const inspected = service as unknown as {
    readStoredCards(
      target: StorageManager,
      lock: HeldFileLockController,
      principal: string,
      namespace: string,
      onCommitted?: () => void
    ): Promise<StoredSupportPassportCard[]>;
    recoverReplacementTransition(
      target: StorageManager,
      candidate: MemoryFile,
      lock: HeldFileLockController,
      principal: string,
      namespace: string,
      options?: { rollbackConflictedApproval?: boolean },
      onCommitted?: () => void
    ): Promise<MemoryFile>;
  };
  inspected.recoverReplacementTransition = async (
    _target,
    candidate,
    _lock,
    _principal,
    _namespace,
    _options,
    onCommitted
  ) => {
    onCommitted?.();
    return candidate;
  };

  await inspected.readStoredCards(
    storage,
    {} as HeldFileLockController,
    PRINCIPAL,
    NAMESPACE,
    () => {
      commitNotifications += 1;
    }
  );

  assert.equal(commitNotifications, 1);
});
