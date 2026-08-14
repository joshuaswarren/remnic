import { z } from "zod";

import {
  SupportPassportCardCategorySchema,
  SupportPassportCardTitleSchema,
  SupportPassportMemoryIdSchema,
  SupportPassportSourceMemoryIdSchema,
} from "./contracts.js";
import { SupportPassportPublicGuideSchema } from "./grant-contracts.js";

export const SUPPORT_PASSPORT_NOT_IN_GUIDE_ANSWER = "That is not covered in this person's support guide.";
export const SUPPORT_PASSPORT_DRAFT_MAX_MEMORIES = 20;
export const SUPPORT_PASSPORT_DRAFT_MAX_CONTENT_CHARACTERS = 100_000;

export const SupportPassportDraftCardSchema = z
  .object({
    title: SupportPassportCardTitleSchema,
    statement: z.string().trim().min(1).max(500),
    category: SupportPassportCardCategorySchema,
    sourceMemoryIds: z.array(SupportPassportSourceMemoryIdSchema).min(1).max(5),
  })
  .strict()
  .superRefine((card, ctx) => {
    if (new Set(card.sourceMemoryIds).size !== card.sourceMemoryIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source memory IDs must be unique",
        path: ["sourceMemoryIds"],
      });
    }
  });

export const SupportPassportDraftOutputSchema = z
  .object({
    cards: z.array(SupportPassportDraftCardSchema).min(1).max(8),
  })
  .strict();

export const SupportPassportDraftModelInputSchema = z
  .object({
    consent: z.literal(true),
    memories: z
      .array(
        z
          .object({
            memoryId: SupportPassportSourceMemoryIdSchema,
            content: z.string().trim().min(1).max(20_000),
          })
          .strict()
      )
      .min(1)
      .max(SUPPORT_PASSPORT_DRAFT_MAX_MEMORIES),
  })
  .strict()
  .superRefine((input, ctx) => {
    const ids = new Set<string>();
    let totalCharacters = 0;
    for (const [index, memory] of input.memories.entries()) {
      totalCharacters += memory.content.length;
      if (ids.has(memory.memoryId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "memory IDs must be unique",
          path: ["memories", index, "memoryId"],
        });
      }
      ids.add(memory.memoryId);
    }
    if (totalCharacters > SUPPORT_PASSPORT_DRAFT_MAX_CONTENT_CHARACTERS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selected memory content is too large",
        path: ["memories"],
      });
    }
  });

export const SupportPassportAnswerOutputSchema = z
  .object({
    answer: z.string().trim().min(1).max(800),
    citedCardIds: z.array(SupportPassportMemoryIdSchema).max(8),
    coverage: z.enum(["grounded", "not_in_guide"]),
  })
  .strict()
  .superRefine((output, ctx) => {
    if (new Set(output.citedCardIds).size !== output.citedCardIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cited card IDs must be unique", path: ["citedCardIds"] });
    }
    if (output.coverage === "grounded" && output.citedCardIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "grounded answers require a citation",
        path: ["citedCardIds"],
      });
    }
    if (output.coverage === "not_in_guide" && output.citedCardIds.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "uncovered answers cannot cite cards",
        path: ["citedCardIds"],
      });
    }
    if (output.coverage === "not_in_guide" && output.answer !== SUPPORT_PASSPORT_NOT_IN_GUIDE_ANSWER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "uncovered answers must use the fixed fallback",
        path: ["answer"],
      });
    }
  });

export const SupportPassportAnswerModelInputSchema = z
  .object({
    guide: SupportPassportPublicGuideSchema,
    question: z.string().trim().min(1).max(500),
  })
  .strict();

export type SupportPassportDraftCard = z.infer<typeof SupportPassportDraftCardSchema>;
export type SupportPassportDraftModelInput = Omit<z.input<typeof SupportPassportDraftModelInputSchema>, "consent"> & {
  consent: boolean;
};
export type SupportPassportAnswerOutput = z.infer<typeof SupportPassportAnswerOutputSchema>;
export type SupportPassportAnswerModelInput = z.input<typeof SupportPassportAnswerModelInputSchema>;
