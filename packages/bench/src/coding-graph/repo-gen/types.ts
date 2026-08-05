import { z } from "zod";

export const H6_TRAP_IDS = [
  "flaky-looking-test",
  "misleading-error-message",
  "wrong-layer-fix",
  "hidden-invariant",
  "stale-cache-illusion",
  "config-shadowing",
] as const;

export type H6TrapId = (typeof H6_TRAP_IDS)[number];

export const GATE_STATUSES = ["NO_MATCH", "MATCH_WARN", "ERROR_FAIL_OPEN"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export const STATE_CLASSIFICATIONS = ["UNFIXED", "TRAPPED", "FIXED", "no-trap"] as const;
export type StateClassification = (typeof STATE_CLASSIFICATIONS)[number];

export const DATASET_SPLITS = ["dev", "pilot", "main"] as const;
export type DatasetSplit = (typeof DATASET_SPLITS)[number];

export const H6_FROZEN_SEED = 81;
export const H6_FROZEN_INVENTORY_HASH =
  "687615b5f7ff46977d268a03e30018070f7d0bec9d01e04da2d0c723e59a5b27";
export const H6_FROZEN_SPLITS = Object.freeze({
  dev: Object.freeze([]),
  pilot: Object.freeze([
    "h6-task-01", "h6-task-02",
    "h6-task-06", "h6-task-07",
    "h6-task-11", "h6-task-12",
    "h6-task-16", "h6-task-17",
    "h6-task-21", "h6-task-22",
    "h6-task-26", "h6-task-27",
  ]),
  main: Object.freeze([
    "h6-task-03", "h6-task-04", "h6-task-05",
    "h6-task-08", "h6-task-09", "h6-task-10",
    "h6-task-13", "h6-task-14", "h6-task-15",
    "h6-task-18", "h6-task-19", "h6-task-20",
    "h6-task-23", "h6-task-24", "h6-task-25",
    "h6-task-28", "h6-task-29", "h6-task-30",
  ]),
} satisfies Readonly<Record<DatasetSplit, readonly string[]>>);

export const TrapFingerprintV1Schema = z.object({
  version: z.literal(1),
  trapId: z.enum(H6_TRAP_IDS),
  symbol: z.string().min(1),
  file: z.string().min(1),
  pattern: z.string().min(1),
  strategyId: z.string().min(1),
});

export type TrapFingerprintV1 = z.infer<typeof TrapFingerprintV1Schema>;

export const ActionIntentV1Schema = z.object({
  version: z.literal(1),
  actionType: z.string().min(1),
  targetSymbol: z.string().min(1),
  filePath: z.string().min(1),
  contextHash: z.string().min(1),
});

export type ActionIntentV1 = z.infer<typeof ActionIntentV1Schema>;

export const SyntheticFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  isExecutable: z.boolean().optional(),
});

export type SyntheticFile = z.infer<typeof SyntheticFileSchema>;

export const StrategyPatchSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  files: z.array(SyntheticFileSchema),
});

export type StrategyPatch = z.infer<typeof StrategyPatchSchema>;

export const TaskVariantSchema = z.object({
  variantId: z.string().min(1),
  baseTaskId: z.string().min(1),
  variantIndex: z.number().int().min(1).max(3),
  distance: z.number().int().min(1).max(3),
  domain: z.string().min(1),
  files: z.array(SyntheticFileSchema),
  strategyCandidates: z.tuple([StrategyPatchSchema, StrategyPatchSchema]),
  badStrategyPatch: StrategyPatchSchema,
  goodStrategyPatch: StrategyPatchSchema,
  noTrapControlFiles: z.array(SyntheticFileSchema),
  cleanRevisionSha: z.string().length(40),
  trapRevisionSha: z.string().length(40),
  rightRevisionSha: z.string().length(40),
  noTrapRevisionSha: z.string().length(40),
});

export type TaskVariant = z.infer<typeof TaskVariantSchema>;

export const BaseTaskSchema = z.object({
  id: z.string().min(1),
  trapId: z.enum(H6_TRAP_IDS),
  domain: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  canonicalBaseFiles: z.array(SyntheticFileSchema).min(1),
  checkCommand: z.string().min(1),
  fileCount: z.number().int().min(8).max(15),
  lineCount: z.number().int().min(300).max(600),
  fingerprint: TrapFingerprintV1Schema,
  normalizedActionIntent: ActionIntentV1Schema,
  offlineCheckMark: z.string().min(1),
  offlineFailureMark: z.string().min(1),
  maxTokenCap: z.number().int().positive(),
  maxAttemptCap: z.number().int().positive(),
  split: z.enum(DATASET_SPLITS),
  variants: z.array(TaskVariantSchema).length(3),
});

export type BaseTask = z.infer<typeof BaseTaskSchema>;

export const TrapTaxonomyItemSchema = z.object({
  trapId: z.enum(H6_TRAP_IDS),
  name: z.string().min(1),
  description: z.string(),
  trapMechanism: z.string().min(1),
  correctFix: z.string().min(1),
  inspiredBy: z.string().min(1),
});

export type TrapTaxonomyItem = z.infer<typeof TrapTaxonomyItemSchema>;

export const H6BenchmarkDatasetSchema = z.object({
  version: z.literal(1),
  seed: z.number().int(),
  createdAt: z.string(),
  inventoryHash: z.string().length(64),
  supportArtifactHashes: z.object({
    "trap-taxonomy.json": z.string().length(64),
    "arms/arms.json": z.string().length(64),
    "schema/action-intent.schema.json": z.string().length(64),
    "schema/dataset.schema.json": z.string().length(64),
    "schema/task.schema.json": z.string().length(64),
    "schema/trap-fingerprint.schema.json": z.string().length(64),
  }),
  taxonomy: z.array(TrapTaxonomyItemSchema).length(6),
  tasks: z.array(BaseTaskSchema).length(30),
  splits: z.object({
    dev: z.array(z.string()).length(0),
    pilot: z.array(z.string()).length(12),
    main: z.array(z.string()).length(18),
  }),
});

export type H6BenchmarkDataset = z.infer<typeof H6BenchmarkDatasetSchema>;

export interface StateEvaluationResult {
  state: StateClassification;
  gateStatus: GateStatus;
  fingerprintMatched: boolean;
  testPassed: boolean;
  exitCode: number;
  reason: string;
}
export interface EvaluateTaskStateOptions {
  isNoTrapControl?: boolean;
}
