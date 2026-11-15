import { receiptDigest } from "./extraction-receipt-runtime.js";
/** Exact piece admission happens before the first extraction can be queued. */
import { ExtractionReceiptStore, type Receipt } from "./extraction-receipts.js";
import type { ReplayTurn } from "./replay/types.js";
export interface ReceiptChunk {
  sourceDigest: string;
  chunkStart: number;
  chunkEnd: number;
  chunkVersion: string;
}
export async function admitExtractionReceipt(options: {
  memoryDir: string;
  chunk: ReceiptChunk;
  principal?: string;
  namespace: string;
  sessionKey: string;
  scope: unknown;
  messages: unknown;
  turns: ReplayTurn[];
  maxChars: number;
}): Promise<{ receipt: Receipt; turns: ReplayTurn[] }> {
  if (!options.principal?.trim()) throw new Error("Extraction receipts require an authenticated principal");
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1)
    throw new Error("Invalid extraction piece limit");
  const pieces = options.turns.flatMap((turn, messageIndex) => {
    const out: { memberId: string; turn: ReplayTurn }[] = [];
    // Whitespace-only input still has a member; it cannot silently disappear
    // into complete coverage when extraction normalization removes it.
    for (let offset = 0; offset < Math.max(1, turn.content.length); offset += options.maxChars) {
      const content = turn.content.slice(offset, offset + options.maxChars);
      out.push({ memberId: receiptDigest({ messageIndex, offset, content }), turn: { ...turn, content } });
    }
    return out;
  });
  const receipt = await new ExtractionReceiptStore(options.memoryDir).admit(
    {
      ...options.chunk,
      principal: options.principal,
      namespace: options.namespace,
      sessionKey: options.sessionKey,
      scopeHash: receiptDigest(options.scope),
      messagesHash: receiptDigest(options.messages),
    },
    pieces.map((p) => p.memberId)
  );
  const covered = new Set(
    receipt.members
      .filter((m) => m.status === "durable_extracted" || m.status === "empty_success")
      .map((m) => m.memberId)
  );
  return {
    receipt,
    turns: pieces
      .filter((p) => !covered.has(p.memberId))
      .map((p) => ({ ...p.turn, extractionReceiptMembers: [{ receiptId: receipt.receiptId, memberId: p.memberId }] })),
  };
}
