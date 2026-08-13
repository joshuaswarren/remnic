import path from "node:path";
import { readdir } from "node:fs/promises";

import { z } from "zod";

import type { StorageManager } from "../index.js";
import type { MemoryFile } from "../types.js";
import {
  ensurePrivateDirectoryTreeNoFollow,
  readPrivateFileNoFollow,
  removePrivateFilesNoFollow,
  withPrivateDirectoryNoFollow,
  writePrivateFileAtomicallyNoFollow,
} from "./private-file.js";
import {
  type StoredSupportPassportCard,
  computeSupportPassportOwnerKey,
  projectSupportPassportCard,
} from "./card-projection.js";
import { SupportPassportNamespaceSchema } from "./contracts.js";
import { SupportPassportError } from "./errors.js";

const BatchIdSchema = z.string().uuid().transform((value) => value.toLowerCase());
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
}

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
  return (
    marker.namespace === context.namespace &&
    marker.owner === computeSupportPassportOwnerKey(context.principal)
  );
}

async function ensureBatchDirectory(storage: StorageManager): Promise<void> {
  await ensurePrivateDirectoryTreeNoFollow(batchDirectory(storage), BATCH_ERROR);
}

async function readBatchMarker(storage: StorageManager, batchId: string): Promise<GeneratedBatchMarker | null> {
  const directory = batchDirectory(storage);
  try {
    const content = await readPrivateFileNoFollow(
      directory,
      batchPath(storage, batchId),
      BATCH_ERROR,
      storage.dir
    );
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

async function listBatchMarkers(storage: StorageManager): Promise<GeneratedBatchMarker[]> {
  const directory = batchDirectory(storage);
  let fileNames: string[];
  try {
    fileNames = await withPrivateDirectoryNoFollow(
      storage.dir,
      directory,
      BATCH_ERROR,
      async (pinnedDirectory) => await readdir(pinnedDirectory)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const markers: GeneratedBatchMarker[] = [];
  for (const fileName of fileNames) {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/.exec(
      fileName
    );
    if (!match?.[1]) continue;
    const marker = await readBatchMarker(storage, match[1]);
    if (marker) markers.push(marker);
  }
  return markers;
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
  await removePrivateFilesNoFollow(
    batchDirectory(storage),
    [batchFileName(batchId)],
    BATCH_ERROR,
    storage.dir
  );
}

function projectOwnedCard(
  memory: MemoryFile,
  namespace: string,
  principal: string
): StoredSupportPassportCard | null {
  const card = projectSupportPassportCard(memory);
  return card?.namespace === namespace && card.owner === computeSupportPassportOwnerKey(principal) ? card : null;
}

export async function persistSupportPassportGeneratedBatchMarker(
  context: GeneratedBatchContext,
  batchId: string,
  size: number
): Promise<GeneratedBatchMarker> {
  const marker = markerFor(context, batchId, size, false);
  await context.requireOwnerLock();
  await ensureBatchDirectory(context.storage);
  try {
    await writeBatchMarker(context.storage, marker);
  } catch (error) {
    const current = await readBatchMarker(context.storage, batchId).catch(() => null);
    if (!current || current.complete || current.size !== size || !sameOwner(current, context)) throw error;
  }
  return marker;
}

export async function commitSupportPassportGeneratedBatch(
  context: GeneratedBatchContext,
  marker: GeneratedBatchMarker,
  cards: readonly StoredSupportPassportCard[]
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
    await writeBatchMarker(context.storage, committed);
  } catch (error) {
    const current = await readBatchMarker(context.storage, marker.batchId).catch(() => null);
    if (current?.complete && sameOwner(current, context) && current.size === marker.size) return;
    throw error;
  }
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
  const marker = await readBatchMarker(context.storage, batchId).catch(() => null);
  if (marker && !sameOwner(marker, context)) return false;
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
  } catch {
    complete = false;
  }
  return complete;
}

export async function isCommittedGeneratedCard(
  storage: StorageManager,
  card: StoredSupportPassportCard,
  markerCache?: Map<string, GeneratedBatchMarker | null>,
): Promise<boolean> {
  if (!card.generatedBatchId) return true;
  let marker = markerCache?.get(card.generatedBatchId);
  if (!markerCache?.has(card.generatedBatchId)) {
    marker = await readBatchMarker(storage, card.generatedBatchId);
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
  return committed;
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
  for (const marker of await listBatchMarkers(context.storage)) {
    if (sameOwner(marker, context) && !cardsByBatch.has(marker.batchId)) {
      cardsByBatch.set(marker.batchId, []);
    }
  }
  for (const [batchId, cards] of cardsByBatch) {
    const marker = await readBatchMarker(context.storage, batchId);
    if (marker?.complete === true && sameOwner(marker, context)) continue;
    if (!marker && cards.length > 0 && cards.every((card) => card.card.status === "rejected")) continue;
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
