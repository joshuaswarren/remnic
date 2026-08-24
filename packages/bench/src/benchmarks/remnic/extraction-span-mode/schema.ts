/**
 * Bench-local extraction fact schemas for the span-mode Phase A experiment
 * (issue #2333). These are the bench harness's extraction configuration
 * variants — NOT the production `ExtractedFactSchema`, which Phase B touches
 * only if the Phase A gate clears.
 */

import { z } from "zod";

export const SpanRefSchema = z.object({
  sourceMessageIndex: z.number(),
  charStart: z.number(),
  charEnd: z.number(),
  frame: z.string(),
});

const CategorySchema = z.enum([
  "fact",
  "preference",
  "correction",
  "entity",
  "decision",
  "relationship",
  "principle",
  "commitment",
  "moment",
  "skill",
  "rule",
  "procedure",
  "reasoning_trace",
]);

export const SpanModeFactSchema = z
  .object({
    category: CategorySchema,
    content: z.string().optional().nullable(),
    confidence: z.number().min(0).max(1),
    tags: z.array(z.string()),
    span: SpanRefSchema.optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if ((value.span === undefined || value.span === null) && (value.content ?? "").trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fact needs either a span or non-blank generated content",
      });
    }
  });

export const CurrentModeFactSchema = z.object({
  category: CategorySchema,
  content: z.string(),
  /**
   * Production parity: current-mode extraction also emits the verbatim
   * grounding quote (ExtractedFactSchema.quote, issue #1575). Span mode
   * replaces BOTH content and quote with offsets + frame.
   */
  quote: z.string().optional().nullable(),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
  span: SpanRefSchema.optional().nullable(),
});

export type SpanModeFact = z.infer<typeof SpanModeFactSchema>;
export type CurrentModeFact = z.infer<typeof CurrentModeFactSchema>;
