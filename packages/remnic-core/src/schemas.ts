import { z } from "zod";

export const MemoryActionTypeSchema = z.enum([
  "store_episode",
  "store_note",
  "update_note",
  "create_artifact",
  "summarize_node",
  "discard",
  "link_graph",
]);

export const MemoryActionEligibilityContextSchema = z
  .object({
    confidence: z.number().min(0).max(1),
    lifecycleState: z.enum(["active", "validated", "candidate", "stale", "archived"]),
    importance: z.number().min(0).max(1),
    source: z.enum(["extraction", "consolidation", "replay", "manual", "unknown"]),
  })
  .strict();

export function parseMemoryActionType(value: unknown): z.infer<typeof MemoryActionTypeSchema> {
  const parsed = MemoryActionTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : "discard";
}

export function parseMemoryActionEligibilityContext(
  value: unknown,
): z.infer<typeof MemoryActionEligibilityContextSchema> {
  const parsed = MemoryActionEligibilityContextSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return {
    confidence: 0,
    lifecycleState: "candidate",
    importance: 0,
    source: "unknown",
  };
}

export const ProcedureStepExtractSchema = z.object({
  order: z.number(),
  intent: z.string(),
  toolCall: z
    .object({
      kind: z.string(),
      signature: z.string(),
    })
    .optional()
    .nullable(),
  expectedOutcome: z.string().optional().nullable(),
  optional: z.boolean().optional().nullable(),
});

export const ExtractedFactSchema = z.object({
  category: z.enum([
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
  ]),
  content: z
    .string()
    .describe("The memory content — a clear, standalone statement"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident are you this is correct (0-1)"),
  tags: z.array(z.string()).describe("Relevant tags for categorization"),
  entityRef: z
    .string()
    .optional()
    .nullable()
    .describe("If about an entity, its normalized name (e.g. person-jane-doe)"),
  promptedByQuestion: z
    .string()
    .optional()
    .nullable()
    .describe("Optional proactive follow-up question that surfaced this fact."),
  scope: z
    .enum(["project", "global"])
    .optional()
    .nullable()
    .describe(
      'Scope classification: "global" for cross-project knowledge (framework bugs, library behavior, API patterns, user preferences, tool configs, general coding patterns); "project" for project-specific knowledge (file paths, env configs, deployment details, project workarounds). Defaults to "project" when a coding context is active.',
    ),
  structuredAttributes: z
    .record(z.string(), z.string())
    .optional()
    .nullable()
    .describe("Structured key-value attributes when the fact contains measurable or categorical data (e.g., {\"price\": \"29.99\", \"color\": \"blue\", \"date\": \"2024-03-15\"})."),
  procedureSteps: z
    .array(ProcedureStepExtractSchema)
    .optional()
    .nullable()
    .describe(
      'For category "procedure" only: ordered steps (intent per step). At least two steps; include explicit trigger phrasing in content (e.g. "When you deploy…").',
    ),
  reasoningTrace: z
    .object({
      steps: z
        .array(
          z.object({
            order: z.number(),
            description: z.string(),
          }),
        )
        // Prompts and normalizer require >=2 ordered steps; enforce it at
        // the schema layer so gateway-path parsing rejects malformed traces
        // rather than persisting them (local/direct-client normalization
        // already enforces this, keeping the two paths symmetric).
        .min(2)
        .describe("Ordered reasoning steps the user walked through (require >=2)."),
      // Accept snake_case aliases so a loose gateway model using
      // `final_answer` / `observed_outcome` does not fail schema parsing
      // and drop the entire extraction result. Local/direct-client
      // normalization already tolerates these keys; the gateway path must
      // too. Zod's `union` keeps the parse successful either way.
      finalAnswer: z
        .string()
        .optional()
        .nullable()
        .describe("The conclusion, decision, or answer the chain arrived at."),
      final_answer: z
        .string()
        .optional()
        .nullable()
        .describe("Alias for finalAnswer (snake_case). Gateway-tolerance shim."),
      observedOutcome: z
        .string()
        .optional()
        .nullable()
        .describe("Optional note about how the answer actually played out."),
      observed_outcome: z
        .string()
        .optional()
        .nullable()
        .describe("Alias for observedOutcome (snake_case). Gateway-tolerance shim."),
    })
    // Either finalAnswer OR final_answer must be present — enforce here so
    // the rest of the pipeline can assume a usable string downstream.
    .refine(
      (v) =>
        (typeof v.finalAnswer === "string" && v.finalAnswer.trim().length > 0) ||
        (typeof v.final_answer === "string" && v.final_answer.trim().length > 0),
      { message: "reasoningTrace requires finalAnswer (or final_answer)" },
    )
    .optional()
    .nullable()
    .describe(
      'For category "reasoning_trace" only: a stored solution chain with ordered steps, a final answer, and an optional observed outcome. Require at least two steps.',
    ),
}).superRefine((value, ctx) => {
  if (value.category === "procedure" && (!Array.isArray(value.procedureSteps) || value.procedureSteps.length < 2)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["procedureSteps"],
      message: "procedure facts require at least two procedureSteps",
    });
  }

  if (value.category === "reasoning_trace" && value.reasoningTrace == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reasoningTrace"],
      message: "reasoning_trace facts require reasoningTrace",
    });
  }
});

export const EntityMentionSchema = z.object({
  name: z
    .string()
    .describe("Normalized entity name (e.g. jane-doe, acme-corp, my-project)"),
  type: z.enum(["person", "project", "tool", "company", "place", "other"]),
  facts: z
    .array(z.string())
    .describe("New facts learned about this entity in this conversation"),
  promptedByQuestion: z
    .string()
    .optional()
    .nullable()
    .describe("Optional proactive follow-up question that surfaced this entity."),
  structuredSections: z
    .array(z.object({
      key: z.string(),
      title: z.string(),
      facts: z.array(z.string()),
    }))
    .optional()
    .nullable()
    .describe("Optional named sections for entity-specific facts. Use when facts clearly belong under a durable heading such as Beliefs or Building / Working On."),
});

export const ExtractedQuestionSchema = z.object({
  question: z.string().describe("A genuine question the AI is curious about based on this conversation"),
  context: z.string().describe("Why this question matters or what prompted it"),
  priority: z.number().min(0).max(1).describe("How important/urgent this question is (0-1)"),
});

export const ProactiveQuestionsResultSchema = z.object({
  questions: z
    .array(ExtractedQuestionSchema)
    .describe("Additional follow-up questions discovered in a proactive second-pass extraction."),
});

export const ExtractedRelationshipSchema = z.object({
  source: z.string().describe("Source entity name (normalized, e.g. person-jane-doe)"),
  target: z.string().describe("Target entity name (normalized, e.g. company-acme-corp)"),
  label: z.string().describe("Relationship label (e.g. 'works at', 'created', 'manages')"),
  promptedByQuestion: z
    .string()
    .optional()
    .nullable()
    .describe("Optional proactive follow-up question that surfaced this relationship."),
});

export const ProactiveExtractionResultSchema = z.object({
  facts: z
    .array(ExtractedFactSchema)
    .describe(
      "Additional high-confidence memories recovered only after answering proactive follow-up questions from the same buffered conversation.",
    ),
  profileUpdates: z
    .array(z.string())
    .describe(
      "Additional profile updates directly supported by the buffered conversation. Omit anything speculative.",
    ),
  entities: z
    .array(EntityMentionSchema)
    .describe(
      "Additional entities or entity facts surfaced by the proactive follow-up pass.",
    ),
  relationships: z
    .array(ExtractedRelationshipSchema)
    .optional()
    .nullable()
    .describe(
      "Additional relationships surfaced by the proactive follow-up pass.",
    ),
});

export const ExtractionResultSchema = z.object({
  facts: z
    .array(ExtractedFactSchema)
    .describe(
      "Extracted memories from the conversation. Include facts, preferences, corrections, and decisions. Only extract genuinely new, durable information — skip transient task state.",
    ),
  profileUpdates: z
    .array(z.string())
    .describe(
      "Updates to the user's behavioral profile. Each string is a standalone statement about the user's preferences, habits, or personality. Only include genuinely new insights.",
    ),
  entities: z
    .array(EntityMentionSchema)
    .describe(
      "Entities mentioned in the conversation with new facts about them.",
    ),
  questions: z
    .array(ExtractedQuestionSchema)
    .describe(
      "1-3 genuine questions you're curious about from this conversation. These should be things you'd actually want to know the answer to in future sessions.",
    ),
  identityReflection: z
    .string()
    .optional()
    .nullable()
    .describe(
      "A brief reflection on what you learned about yourself as an agent in this interaction — patterns in your behavior, growth, things you did well or could improve.",
    ),
  relationships: z
    .array(ExtractedRelationshipSchema)
    .optional()
    .nullable()
    .describe(
      "Relationships between entities discovered in this conversation. Max 5 per extraction. Format: {source, target, label}.",
    ),
});

export const ConsolidationItemSchema = z.object({
  existingId: z
    .string()
    .describe("The ID of the existing memory being evaluated"),
  action: z.enum(["ADD", "MERGE", "UPDATE", "INVALIDATE", "SKIP"]),
  mergeWith: z
    .string()
    .optional()
    .nullable()
    .describe("If MERGE, the ID of the memory to merge with"),
  updatedContent: z
    .string()
    .optional()
    .nullable()
    .describe("If UPDATE or MERGE, the new content"),
  reason: z.string().describe("Brief reason for this decision"),
});

export const ConsolidationResultSchema = z.object({
  items: z
    .array(ConsolidationItemSchema)
    .describe(
      "Decisions for each existing memory: ADD (keep as-is), MERGE (combine with another), UPDATE (revise content), INVALIDATE (mark as outdated/wrong), SKIP (no action needed)",
    ),
  profileUpdates: z
    .array(z.string())
    .describe("New profile statements to add or update"),
  entityUpdates: z
    .array(EntityMentionSchema)
    .describe("Entity updates from consolidation analysis"),
});

export function buildProfileConsolidationResultSchema(targetLines: number) {
  return z.object({
    consolidatedProfile: z
      .string()
      .describe(
        `The full consolidated profile as markdown. Preserve all ## section headers. Merge duplicate or near-duplicate bullets into single clear statements. Remove stale or superseded information. Keep the most important and durable observations. Target roughly ${targetLines} lines.`,
      ),
    removedCount: z
      .number()
      .describe("Number of bullets removed or merged during consolidation"),
    summary: z
      .string()
      .describe("Brief summary of what was consolidated"),
  });
}

export const ProfileConsolidationResultSchema = buildProfileConsolidationResultSchema(50);

export const IdentityConsolidationResultSchema = z.object({
  learnedPatterns: z
    .array(z.string())
    .describe(
      "Consolidated behavioral patterns and lessons learned, each a concise standalone statement",
    ),
  summary: z
    .string()
    .describe(
      "A brief paragraph summarizing the agent's core identity insights",
    ),
});

export type IdentityConsolidationResultParsed = z.infer<
  typeof IdentityConsolidationResultSchema
>;

// Contradiction Verification (Phase 2B)
export const ContradictionVerificationSchema = z.object({
  isContradiction: z
    .boolean()
    .describe("Whether the two memories truly contradict each other"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident are you in this assessment (0-1)"),
  reasoning: z
    .string()
    .describe("Explanation of why these are or are not contradictory"),
  whichIsNewer: z
    .enum(["first", "second", "unclear"])
    .describe("Which memory represents the more recent/current state"),
});

export type ContradictionVerificationResult = z.infer<
  typeof ContradictionVerificationSchema
>;

// Memory Linking (Phase 3A)
export const MemoryLinkSchema = z.object({
  targetId: z
    .string()
    .describe("The ID of the memory this links to"),
  linkType: z
    .enum(["follows", "references", "contradicts", "supports", "related"])
    .describe("The type of relationship"),
  strength: z
    .number()
    .min(0)
    .max(1)
    .describe("How strong is this relationship (0-1)"),
  reason: z
    .string()
    .optional()
    .nullable()
    .describe("Why this link exists"),
});

export const SuggestedLinksSchema = z.object({
  links: z
    .array(MemoryLinkSchema)
    .describe("Suggested links between memories based on semantic analysis"),
});

export type MemoryLink = z.infer<typeof MemoryLinkSchema>;
export type SuggestedLinks = z.infer<typeof SuggestedLinksSchema>;

// Memory Summarization (Phase 4A)
export const MemorySummarySchema = z.object({
  summaryText: z
    .string()
    .describe("A concise summary of the batch of memories"),
  keyFacts: z
    .array(z.string())
    .describe("The most important facts extracted from these memories"),
  keyEntities: z
    .array(z.string())
    .describe("Key entities mentioned across these memories"),
});

export type MemorySummaryResult = z.infer<typeof MemorySummarySchema>;

export const DaySummaryResultSchema = z.object({
  summary: z.string().min(1).describe("A concise end-of-day summary paragraph."),
  bullets: z.array(z.string()).default([]).describe("The most important moments from the day."),
  next_actions: z.array(z.string()).default([]).describe("Concrete next actions for tomorrow."),
  risks_or_open_loops: z.array(z.string()).default([]).describe("Open loops, blockers, or fragile assumptions still needing attention."),
});

// v8.15 behavior-loop auto-tuning state contracts
export const BehaviorLoopAdjustmentSchema = z.object({
  parameter: z.string().min(1),
  previousValue: z.number(),
  nextValue: z.number(),
  delta: z.number(),
  evidenceCount: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  appliedAt: z.string(),
});

export const BehaviorLoopPolicyStateSchema = z.object({
  version: z.number().int().min(0),
  windowDays: z.number().int().min(0),
  minSignalCount: z.number().int().min(0),
  maxDeltaPerCycle: z.number().min(0).max(1),
  protectedParams: z.array(z.string()),
  adjustments: z.array(BehaviorLoopAdjustmentSchema),
  updatedAt: z.string(),
});

export type BehaviorLoopAdjustmentParsed = z.infer<typeof BehaviorLoopAdjustmentSchema>;
export type BehaviorLoopPolicyStateParsed = z.infer<typeof BehaviorLoopPolicyStateSchema>;

export type MemoryActionTypeParsed = z.infer<typeof MemoryActionTypeSchema>;
export type MemoryActionEligibilityContextParsed = z.infer<typeof MemoryActionEligibilityContextSchema>;
export type ExtractedFactParsed = z.infer<typeof ExtractedFactSchema>;
export type EntityMentionParsed = z.infer<typeof EntityMentionSchema>;
export type ExtractedQuestionParsed = z.infer<typeof ExtractedQuestionSchema>;
export type ProactiveQuestionsResultParsed = z.infer<typeof ProactiveQuestionsResultSchema>;
export type ExtractionResultParsed = z.infer<typeof ExtractionResultSchema>;
export type ConsolidationItemParsed = z.infer<typeof ConsolidationItemSchema>;
export type ConsolidationResultParsed = z.infer<
  typeof ConsolidationResultSchema
>;
