/** Internal writer provenance. Identifiers and hashes only; never source text. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { MemoryFrontmatter } from "./types.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const receiptPlanSchema = z.object({
  version: z.literal(1),
  digest: hash,
  identityDigest: hash,
  members: z.array(z.object({ receiptId: z.string(), memberId: z.string() })).min(1),
  slots: z.array(hash),
});
export type ReceiptPlan = z.infer<typeof receiptPlanSchema>;
export const receiptEffectSchema = z.object({
  version: z.literal(1),
  planDigest: hash,
  identityDigest: hash,
  namespace: z.string(),
  members: z
    .array(z.object({ receiptId: z.string(), memberId: z.string(), generation: z.number().int().positive() }))
    .min(1),
  attemptId: z.string(),
  journalId: z.string(),
  slot: hash,
  effectDigest: hash.optional(),
});
export type ReceiptEffect = z.infer<typeof receiptEffectSchema>;
export const receiptEffectsSchema = z.array(receiptEffectSchema);
export interface ReceiptMemoryProvenance {
  extractionEffects?: ReceiptEffect[];
}
const writer = new AsyncLocalStorage<ReceiptEffect>();
export const withReceiptEffect = <T>(effect: ReceiptEffect, run: () => Promise<T>): Promise<T> =>
  writer.run(effect, run);
export function receiptWriteEffects(frontmatter: MemoryFrontmatter, content: string): ReceiptEffect[] | undefined {
  const effect = writer.getStore();
  return effect ? [{ ...structuredClone(effect), effectDigest: receiptMemoryDigest(frontmatter, content) }] : undefined;
}
export function receiptHash<T>(value: T): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        z.json().parse(JSON.parse(JSON.stringify(value) ?? "null")),
        (_key: string, candidate: z.infer<ReturnType<typeof z.json>> | undefined) => {
          const object = z.record(z.string(), z.json().optional()).safeParse(candidate);
          return object.success
            ? Object.fromEntries(Object.entries(object.data).sort(([a], [b]) => a.localeCompare(b)))
            : candidate;
        }
      ) ?? "undefined"
    )
    .digest("hex");
}
export function parseReceiptEffects(raw: string | undefined): ReceiptEffect[] | undefined {
  if (raw === undefined) return undefined;
  try {
    return receiptEffectsSchema.parse(JSON.parse(raw));
  } catch {
    return undefined; // Malformed/legacy metadata cannot establish recovery proof.
  }
}

export function receiptMemoryDigest(f: MemoryFrontmatter, content: string): string {
  return receiptHash({
    id: f.id,
    category: f.category,
    source: f.source,
    confidence: f.confidence,
    tags: f.tags,
    contentHash: f.contentHash,
    sourceConnector: f.sourceConnector,
    subject: f.subject ?? "user",
    toolScoped: f.toolScoped === true,
    status: f.status ?? "active",
    entityRef: f.entityRef,
    expiresAt: f.expiresAt,
    valid_at: f.valid_at,
    invalid_at: f.invalid_at,
    content,
  });
}
