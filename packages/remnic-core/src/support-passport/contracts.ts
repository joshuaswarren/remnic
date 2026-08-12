import { createHash } from "node:crypto";
import { z } from "zod";

import { parseIsoOffsetTimestamp } from "../utils/iso-timestamp.js";

export const SUPPORT_PASSPORT_CARD_CATEGORIES = [
  "communication",
  "environment",
  "transitions",
  "sensory",
  "regulation",
  "interests",
  "other",
] as const;

export const SUPPORT_PASSPORT_CARD_STATUSES = [
  "pending_review",
  "active",
  "rejected",
  "superseded",
  "archived",
] as const;

export const SupportPassportCardCategorySchema = z.enum(SUPPORT_PASSPORT_CARD_CATEGORIES);
export const SupportPassportCardStatusSchema = z.enum(SUPPORT_PASSPORT_CARD_STATUSES);
export const SupportPassportCardTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((title) => !title.includes("]") && !title.includes("\n") && !title.includes("\r"), {
    message: "card titles cannot contain closing brackets or line breaks",
  });

const IsoTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => parseIsoOffsetTimestamp(value) !== null, {
    message: "timestamps must be valid ISO 8601 values",
  });
export const SupportPassportNamespaceSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((namespace) => namespace === namespace.trim(), {
    message: "namespaces must be canonical",
  });
export const SupportPassportMemoryIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const SupportPassportCardSchema = z
  .object({
    cardId: SupportPassportMemoryIdSchema,
    title: SupportPassportCardTitleSchema,
    statement: z.string().trim().min(1).max(500),
    category: SupportPassportCardCategorySchema,
    status: SupportPassportCardStatusSchema,
    updatedAt: IsoTimestampSchema,
    reviewBy: IsoTimestampSchema,
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const SupportPassportCardListSchema = z
  .array(SupportPassportCardSchema)
  .max(100)
  .superRefine((cards, ctx) => {
    const seen = new Set<string>();
    for (const [index, card] of cards.entries()) {
      if (seen.has(card.cardId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "card IDs must be unique",
          path: [index, "cardId"],
        });
      }
      seen.add(card.cardId);
    }
  });

export const SupportPassportListCardsInputSchema = z
  .object({
    principal: z.string().trim().min(1).max(512),
  })
  .strict();

export const SupportPassportManualDraftInputSchema = z
  .object({
    principal: z.string().trim().min(1).max(512),
    title: SupportPassportCardTitleSchema,
    statement: z.string().trim().min(1).max(500),
    category: SupportPassportCardCategorySchema,
    reviewBy: IsoTimestampSchema,
  })
  .strict();

export const SupportPassportCardMutationInputSchema = z
  .object({
    principal: z.string().trim().min(1).max(512),
    cardId: SupportPassportMemoryIdSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const SupportPassportReplaceCardInputSchema = SupportPassportCardMutationInputSchema.extend({
  title: SupportPassportCardTitleSchema,
  statement: z.string().trim().min(1).max(500),
  category: SupportPassportCardCategorySchema,
  reviewBy: IsoTimestampSchema,
}).strict();

export type SupportPassportCard = z.infer<typeof SupportPassportCardSchema>;
export type SupportPassportCardCategory = z.infer<typeof SupportPassportCardCategorySchema>;
export type SupportPassportCardStatus = z.infer<typeof SupportPassportCardStatusSchema>;
export type SupportPassportManualDraftInput = z.input<typeof SupportPassportManualDraftInputSchema>;
export type SupportPassportCardMutationInput = z.input<typeof SupportPassportCardMutationInputSchema>;
export type SupportPassportReplaceCardInput = z.input<typeof SupportPassportReplaceCardInputSchema>;

type RevisionFields = Omit<SupportPassportCard, "revision">;

export function computeSupportPassportCardRevision(fields: RevisionFields): string {
  const canonicalFields = {
    cardId: fields.cardId,
    category: fields.category,
    reviewBy: fields.reviewBy,
    statement: fields.statement,
    status: fields.status,
    title: fields.title,
    updatedAt: fields.updatedAt,
  };
  return createHash("sha256").update(JSON.stringify(canonicalFields)).digest("hex");
}
