import path from "node:path";

import { z } from "zod";

import type { StorageManager } from "../index.js";
import type { MemoryFile } from "../types.js";
import {
  type StoredSupportPassportCard,
  computeSupportPassportOwnerKey,
  projectSupportPassportCard,
} from "./card-projection.js";
import { SupportPassportNamespaceSchema } from "./contracts.js";
import { SupportPassportError } from "./errors.js";
import {
  ensurePrivateDirectoryNoFollow,
  ensurePrivateDirectoryTreeNoFollow,
  readPrivateFileNoFollow,
  removePrivateFilesNoFollow,
  writePrivateFileAtomicallyNoFollow,
} from "./private-file.js";

const BatchIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const GeneratedBatchMarkerSchema = z
  .object({
    schemaVersion: z.literal(1),
    batchId: BatchIdSchema,
    size: z.number().int().min(1).max(8),
    namespace: SupportPassportNamespaceSchema,
    owner: z.string().regex(/^[a-f0-9]{64}$/),
    complete: z.boolean(),
  })
  .strict();

export type GeneratedBatchMarker = z.infer<typeof GeneratedBatchMarkerSchema>;

export interface GeneratedBatchContext {
  storage: StorageManager;
  principal: string;
  namespace: string;
  now: () => Date;
  requireOwnerLock: () => Promise<void>;
  onCommitted?: () => void;
}

type GeneratedBatchMarkerWriter = (storage: StorageManager, marker: GeneratedBatchMarker) => Promise<void>;

const BATCH_ERROR = "The generated draft batch state is not safe.";

function batchDirectory(storage: StorageManager): string {
  return path.join(storage.dir, "state", "support-passport", "generated-batches");
}

function batchFileName(batchId: string): string {
  return `${BatchIdSchema.parse(batchId)}.json`;
}

function batchPath(storage: StorageManager, batchId: string): string {
  return path.join(batchDirectory(storage), batchFileName(batchId));
}

function markerFor(context: GeneratedBatchContext, batchId: string, size: number, complete: boolean) {
  return GeneratedBatchMarkerSchema.parse({
    schemaVersion: 1,
    batchId,
    size,
    namespace: context.namespace,
    owner: computeSupportPassportOwnerKey(context.principal),
    complete,
  });
}

function sameOwner(marker: GeneratedBatchMarker, context: GeneratedBatchContext): boolean {
  return marker.namespace === context.namespace && marker.owner === computeSupportPassportOwnerKey(context.principal);
}

async function ensureBatchDirectory(storage: StorageManager): Promise<void> {
  const directory = batchDirectory(storage);
  await ensurePrivateDirectoryTreeNoFollow(directory, BATCH_ERROR);
  await ensurePrivateDirectoryNoFollow(storage.dir, directory, BATCH_ERROR);
}

export async function readSupportPassportGeneratedBatchMarker(
  storage: StorageManager,
  batchId: string
): Promise<GeneratedBatchMarker | null> {
  const directory = batchDirectory(storage);
  try {
    const content = await readPrivateFileNoFollow(directory, batchPath(storage, batchId), BATCH_ERROR, storage.dir);
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new SupportPassportError("card_data_invalid", "The generated draft batch state is invalid.", 500);
    }
    const parsed = GeneratedBatchMarkerSchema.safeParse(value);
    if (!parsed.success || parsed.data.batchId !== BatchIdSchema.parse(batchId)) {
      throw new SupportPassportError("card_data_invalid", "The generated draft batch state is invalid.", 500);
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function isSupportPassportGeneratedBatchCommitted(
  context: GeneratedBatchContext,
  marker: GeneratedBatchMarker
): Promise<boolean> {
  const current = await readSupportPassportGeneratedBatchMarker(context.storage, marker.batchId);
  return Boolean(current?.complete && sameOwner(current, context) && current.size === marker.size);
}

async function writeBatchMarker(storage: StorageManager, marker: GeneratedBatchMarker): Promise<void> {
  const directory = batchDirectory(storage);
  await writePrivateFileAtomicallyNoFollow(
    directory,
    batchPath(storage, marker.batchId),
    `${JSON.stringify(marker)}\n`,
    BATCH_ERROR,
    storage.dir
  );
}

async function removeBatchMarker(storage: StorageManager, batchId: string): Promise<void> {
  await removePrivateFilesNoFollow(batchDirectory(storage), [batchFileName(batchId)], BATCH_ERROR, storage.dir);
}

function projectOwnedCard(memory: MemoryFile, namespace: string, principal: string): StoredSupportPassportCard | null {
  const card = projectSupportPassportCard(memory);
  return card?.namespace === namespace && card.owner === computeSupportPassportOwnerKey(principal) ? card : null;
}

export async function persistSupportPassportGeneratedBatchMarker(
  context: GeneratedBatchContext,
  batchId: string,
  size: number,
  writeMarker: GeneratedBatchMarkerWriter = writeBatchMarker
): Promise<GeneratedBatchMarker> {
  const marker = markerFor(context, batchId, size, false);
  await context.requireOwnerLock();
  await ensureBatchDirectory(context.storage);
  await writeMarker(context.storage, marker);
  context.onCommitted?.();
  return marker;
}

export async function commitSupportPassportGeneratedBatch(
  context: GeneratedBatchContext,
  marker: GeneratedBatchMarker,
  cards: readonly StoredSupportPassportCard[],
  writeMarker: GeneratedBatchMarkerWriter = writeBatchMarker
): Promise<void> {
  const cardIds = cards.map((card) => card.card.cardId);
  if (!sameOwner(marker, context) || cards.length !== marker.size || new Set(cardIds).size !== cards.length) {
    throw new SupportPassportError("storage_conflict", "The generated draft batch is incomplete.", 409);
  }
  for (const card of cards) {
    if (
      card.namespace !== context.namespace ||
      card.owner !== computeSupportPassportOwnerKey(context.principal) ||
      card.card.status !== "pending_review" ||
      card.generatedBatchId !== marker.batchId ||
      card.generatedBatchSize !== marker.size
    ) {
      throw new SupportPassportError("storage_conflict", "The generated draft batch is incomplete.", 409);
    }
  }
  await context.requireOwnerLock();
  const committed = { ...marker, complete: true };
  try {
    await writeMarker(context.storage, committed);
  } catch (error) {
    if (!(await isSupportPassportGeneratedBatchCommitted(context, marker))) throw error;
  }
  context.onCommitted?.();
}

async function rejectGeneratedDraft(context: GeneratedBatchContext, cardId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const memory = await context.storage.getMemoryById(cardId);
    if (!memory) return true;
    const stored = projectOwnedCard(memory, context.namespace, context.principal);
    if (!stored) return false;
    if (stored.card.status === "rejected") return true;
    if (stored.card.status !== "pending_review") return false;
    await context.requireOwnerLock();
    if (
      await context.storage.writeMemoryFrontmatterIfUnchanged(
        memory,
        { status: "rejected", updated: context.now().toISOString() },
        { actor: context.principal, reasonCode: "draft-batch-failed" }
      )
    ) {
      context.onCommitted?.();
      return true;
    }
  }
  return false;
}

export async function rollbackSupportPassportGeneratedBatch(
  context: GeneratedBatchContext,
  batchId: string,
  knownCardIds: readonly string[]
): Promise<boolean> {
  const marker = await readSupportPassportGeneratedBatchMarker(context.storage, batchId);
  if (marker && !sameOwner(marker, context)) return false;
  if (marker?.complete) return false;
  const cardIds = new Set(knownCardIds);
  let scanComplete = true;
  try {
    for (const memory of await context.storage.readAllMemories()) {
      const card = projectOwnedCard(memory, context.namespace, context.principal);
      if (card?.generatedBatchId === batchId) cardIds.add(card.card.cardId);
    }
  } catch {
    scanComplete = false;
  }
  let complete = scanComplete;
  for (const cardId of cardIds) {
    try {
      if (!(await rejectGeneratedDraft(context, cardId))) complete = false;
    } catch {
      complete = false;
    }
  }
  if (!complete) return false;
  try {
    await removeBatchMarker(context.storage, batchId);
    context.onCommitted?.();
  } catch {
    complete = false;
  }
  return complete;
}

export async function isCommittedGeneratedCard(
  storage: StorageManager,
  card: StoredSupportPassportCard,
  markerCache?: Map<string, GeneratedBatchMarker | null>
): Promise<boolean> {
  if (!card.generatedBatchId) return true;
  let marker = markerCache?.get(card.generatedBatchId);
  if (!markerCache?.has(card.generatedBatchId)) {
    marker = await readSupportPassportGeneratedBatchMarker(storage, card.generatedBatchId);
    markerCache?.set(card.generatedBatchId, marker);
  }
  return Boolean(
    marker?.complete &&
      marker.size === card.generatedBatchSize &&
      marker.namespace === card.namespace &&
      marker.owner === card.owner
  );
}

export async function projectCommittedSupportPassportCards(
  storage: StorageManager,
  memories: readonly MemoryFile[],
  namespace: string,
  principal: string
): Promise<StoredSupportPassportCard[]> {
  const projected = memories
    .map(projectSupportPassportCard)
    .filter(
      (card): card is StoredSupportPassportCard =>
        card?.namespace === namespace && card.owner === computeSupportPassportOwnerKey(principal)
    );
  const markers = new Map<string, GeneratedBatchMarker | null>();
  const committed: StoredSupportPassportCard[] = [];
  for (const card of projected) {
    if (await isCommittedGeneratedCard(storage, card, markers)) committed.push(card);
  }
  const ids = new Set<string>();
  for (const card of committed) {
    if (ids.has(card.card.cardId)) {
      throw new SupportPassportError("card_data_invalid", "Support card IDs must be unique.", 500);
    }
    ids.add(card.card.cardId);
  }
  return committed;
}

export async function readCommittedSupportPassportCards(
  storage: StorageManager,
  namespace: string,
  principal: string
): Promise<StoredSupportPassportCard[]> {
  return await projectCommittedSupportPassportCards(
    storage,
    await storage.readAllMemories(),
    namespace,
    principal
  );
}

export async function recoverSupportPassportGeneratedBatches(
  context: GeneratedBatchContext,
  memories: readonly MemoryFile[]
): Promise<void> {
  const cardsByBatch = new Map<string, StoredSupportPassportCard[]>();
  for (const memory of memories) {
    const card = projectOwnedCard(memory, context.namespace, context.principal);
    if (!card?.generatedBatchId) continue;
    const cards = cardsByBatch.get(card.generatedBatchId) ?? [];
    cards.push(card);
    cardsByBatch.set(card.generatedBatchId, cards);
  }
  for (const [batchId, cards] of cardsByBatch) {
    const marker = await readSupportPassportGeneratedBatchMarker(context.storage, batchId);
    if (marker?.complete === true && sameOwner(marker, context)) continue;
    if (!marker) {
      let recovered = true;
      for (const card of cards) {
        if (card.card.status !== "pending_review") continue;
        try {
          if (!(await rejectGeneratedDraft(context, card.card.cardId))) recovered = false;
        } catch {
          recovered = false;
        }
      }
      if (recovered) continue;
      throw new SupportPassportError("storage_conflict", "An incomplete generated draft batch could not recover.", 500);
    }
    if (
      !(await rollbackSupportPassportGeneratedBatch(
        context,
        batchId,
        cards.map((card) => card.card.cardId)
      ))
    ) {
      throw new SupportPassportError("storage_conflict", "An incomplete generated draft batch could not recover.", 500);
    }
  }
}
