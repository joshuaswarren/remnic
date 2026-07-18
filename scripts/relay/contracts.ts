import { z } from "zod";

export const RELAY_MODEL = "gpt-5.6-terra" as const;
export const RELAY_REASONING_EFFORT = "medium" as const;
export const RELAY_MAX_LIVE_CALLS = 4 as const;
export const RELAY_ACCOUNT_CREDIT_CAP_UNITS = 2_473 as const;
export const RELAY_CREDIT_BUDGET_UNITS = 2_473 as const;
export const RELAY_CREDIT_RESERVE_UNITS = 473 as const;
export const RELAY_PLANNED_SPEND_CEILING_UNITS = 2_000 as const;
export const RELAY_MAX_UNITS_PER_CALL = 300 as const;
export const RELAY_QUARANTINED_ATTEMPT_UNITS = 300 as const;
export const RELAY_MISSION_ID = "checkout-token-recovery" as const;
export const RELAY_NAMESPACE = "relay-build-week" as const;
export const RELAY_OPERATOR_PRINCIPAL = "relay-build-week-operator" as const;
export const RELAY_AGENT_PRINCIPAL = "relay-codex-agent" as const;
export const RELAY_STALE_DECISION_ID = "decision-new-token-every-request" as const;
export const RELAY_REPLACEMENT_DECISION_ID = "decision-refresh-after-expiry" as const;
export const RELAY_CORRECTION_ID = "correction-token-refresh" as const;
export const RELAY_CONFLICT_ID = "conflict-token-lifecycle" as const;
export const RELAY_QUERY = "checkout token retry policy decision" as const;

export const RelayRoleSchema = z.enum(["scout", "stale-builder", "resolver", "cold-builder"]);
export type RelayRole = z.infer<typeof RelayRoleSchema>;

const boundedText = z.string().trim().min(1).max(2_000);
const sourceLocators = z.array(z.string().trim().min(1).max(300)).min(1).max(32);

export const RelayScoutOutputSchema = z
  .object({
    decision: boundedText,
    rationale: boundedText,
    source_locators: sourceLocators,
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();
export type RelayScoutOutput = z.infer<typeof RelayScoutOutputSchema>;

export const RelayResolverOutputSchema = z
  .object({
    replacement_decision: boundedText,
    rationale: boundedText,
    source_locators: sourceLocators,
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();
export type RelayResolverOutput = z.infer<typeof RelayResolverOutputSchema>;

export const RelayBuilderModelOutputSchema = z
  .object({
    summary: boundedText,
    decision_applied: boundedText,
    files_changed: z.array(z.string().trim().min(1).max(300)).min(1).max(16),
    tests_run: z.array(z.string().trim().min(1).max(500)).min(1).max(16),
  })
  .strict();
export type RelayBuilderModelOutput = z.infer<typeof RelayBuilderModelOutputSchema>;

export const RelayBuilderOutputSchema = RelayBuilderModelOutputSchema.extend({
  recall_memory_id: z.string().trim().min(1).max(256),
  recall_provenance: z.string().trim().min(1).max(1_000),
}).strict();
export type RelayBuilderOutput = z.infer<typeof RelayBuilderOutputSchema>;

export const RelayRecallReceiptSchema = z
  .object({
    query: z.literal(RELAY_QUERY),
    namespace: z.literal(RELAY_NAMESPACE),
    memoryIds: z.tuple([z.string().trim().min(1).max(256)]),
  })
  .strict();
export type RelayRecallReceipt = z.infer<typeof RelayRecallReceiptSchema>;

export const RelayNativeUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
  })
  .strict()
  .refine((usage) => usage.cachedInputTokens <= usage.inputTokens, {
    message: "cached input tokens cannot exceed input tokens",
    path: ["cachedInputTokens"],
  });
export type RelayNativeUsage = z.infer<typeof RelayNativeUsageSchema>;

export const RelayCodexCallSummarySchema = z
  .object({
    role: RelayRoleSchema,
    model: z.literal(RELAY_MODEL),
    reasoningEffort: z.literal(RELAY_REASONING_EFFORT),
    threadId: z.string().uuid(),
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
    outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    exitCode: z.number().int(),
    durationMs: z.number().int().nonnegative(),
    usage: RelayNativeUsageSchema,
    recallToolCalls: z.number().int().nonnegative(),
    recallReceipt: RelayRecallReceiptSchema.nullable(),
    status: z.enum(["completed", "failed"]),
  })
  .strict();
export type RelayCodexCallSummary = z.infer<typeof RelayCodexCallSummarySchema>;

export interface RelayCodexCallResult<T> {
  summary: RelayCodexCallSummary;
  output: T;
  stdout: string;
  stderr: string;
}

export const RelayTestResultSchema = z
  .object({
    phase: z.enum(["before-correction", "after-correction"]),
    status: z.enum(["passed", "failed", "error"]),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    command: z.string().min(1).max(500),
    summary: z.string().min(1).max(2_000),
    outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type RelayTestResult = z.infer<typeof RelayTestResultSchema>;

export const RelayPreflightReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    checkedAt: z.string().datetime({ offset: true }),
    status: z.literal("passed"),
    model: z.literal(RELAY_MODEL),
    reasoningEffort: z.literal(RELAY_REASONING_EFFORT),
    modelCatalogVerified: z.literal(true),
    maxLiveCalls: z.literal(RELAY_MAX_LIVE_CALLS),
    accountCreditCapUnits: z.literal(RELAY_ACCOUNT_CREDIT_CAP_UNITS),
    quarantinedUncertainUnits: z.number().int().min(0).max(RELAY_QUARANTINED_ATTEMPT_UNITS),
    quarantinedLedgerSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    budgetUnits: z.number().int().positive().max(RELAY_CREDIT_BUDGET_UNITS),
    reserveUnits: z.literal(RELAY_CREDIT_RESERVE_UNITS),
    plannedSpendCeilingUnits: z.number().int().positive().max(RELAY_PLANNED_SPEND_CEILING_UNITS),
    worstCasePlannedSpendUnits: z.literal(RELAY_MAX_LIVE_CALLS * RELAY_MAX_UNITS_PER_CALL),
    ledgerSpentUnits: z.number().finite().nonnegative(),
    ledgerRemainingPlannedUnits: z.number().finite().nonnegative(),
    codexVersion: z.string().regex(/^codex-cli \d+\.\d+\.\d+$/),
    authMethod: z.literal("ChatGPT"),
    codexToolSurface: z
      .object({
        accountLinkedAppsDisabled: z.literal(true),
        mcpServers: z.tuple([z.literal("relay")]),
        mcpTools: z.tuple([z.literal("relay.remnic.recall")]),
      })
      .strict(),
    fixtureManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    isolation: z
      .object({
        userNamespace: z.literal(true),
        mountNamespace: z.literal(true),
        networkNamespace: z.literal(true),
        chroot: z.literal(true),
        egressPolicy: z.literal("openai-and-relay-only"),
      })
      .strict(),
    remnic: z
      .object({
        loopbackOnly: z.literal(true),
        namespace: z.literal(RELAY_NAMESPACE),
        advertisedTools: z.tuple([z.literal("remnic.recall")]),
        isolatedMemoryDir: z.literal(true),
      })
      .strict(),
    productionDataRead: z.literal(false),
    solAllowed: z.literal(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.accountCreditCapUnits - value.quarantinedUncertainUnits !== value.budgetUnits) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "effective budget must subtract quarantined uncertainty from the account cap",
        path: ["budgetUnits"],
      });
    }
    if (value.budgetUnits - value.reserveUnits !== value.plannedSpendCeilingUnits) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "planned spend ceiling must preserve the fixed reserve",
        path: ["plannedSpendCeilingUnits"],
      });
    }
    if ((value.quarantinedUncertainUnits === 0) !== (value.quarantinedLedgerSha256 === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "quarantined uncertainty and ledger evidence must be present together",
        path: ["quarantinedLedgerSha256"],
      });
    }
  });
export type RelayPreflightReceipt = z.infer<typeof RelayPreflightReceiptSchema>;

export function schemaForRole(role: RelayRole) {
  if (role === "scout") return RelayScoutOutputSchema;
  if (role === "resolver") return RelayResolverOutputSchema;
  return RelayBuilderModelOutputSchema;
}

export function schemaFilenameForRole(role: RelayRole): string {
  if (role === "scout") return "scout.json";
  if (role === "resolver") return "resolver.json";
  return "builder.json";
}

export function promptFilenameForRole(role: RelayRole): string {
  if (role === "scout") return "scout.md";
  if (role === "resolver") return "resolver.md";
  return "builder.md";
}
