import { createHash } from "node:crypto";
import { z } from "zod";

export const RECEIPT_SCHEMA_VERSION = 1;
export const PROOF_RESPONSE_ORDER = ["draft", "approve", "grant", "helperRead", "helperAsk", "revoke", "deniedRead"];
export const ALL_RESPONSE_ORDER = ["draft", "edit", ...PROOF_RESPONSE_ORDER.slice(1)];
export const EXPECTED_STATUS_SEQUENCE = [200, 200, 200, 200, 200, 200, 410];

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CommitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const IsoTimestampSchema = z.string().datetime({ offset: true });
const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const NullableCountSchema = z.number().int().nonnegative().nullable();
const SupportCardCategorySchema = z.enum([
  "communication",
  "environment",
  "transitions",
  "sensory",
  "regulation",
  "interests",
  "other",
]);

export const SourceMemoriesFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    memories: z
      .array(
        z
          .object({
            fixtureId: IdentifierSchema,
            content: z.string().trim().min(1).max(500),
            category: z.literal("preference"),
            tags: z.array(z.string().trim().min(1).max(64)).min(1).max(5),
          })
          .strict()
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine((fixture, context) => {
    const ids = fixture.memories.map((memory) => memory.fixtureId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "fixture IDs must be unique" });
    }
  });

export const ExpectedPublicCardsFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    cards: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(80),
            statement: z.string().trim().min(1).max(500),
            category: SupportCardCategorySchema,
          })
          .strict()
      )
      .length(1),
    question: z.string().trim().min(1).max(500),
    expectedCoverage: z.literal("grounded"),
  })
  .strict();

const ModelUsageSchema = z
  .object({
    inputTokens: NullableCountSchema,
    outputTokens: NullableCountSchema,
    totalTokens: NullableCountSchema,
  })
  .strict()
  .superRefine((usage, context) => {
    if (
      usage.inputTokens !== null &&
      usage.outputTokens !== null &&
      usage.totalTokens !== null &&
      usage.inputTokens + usage.outputTokens !== usage.totalTokens
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "totalTokens must equal the input and output sum" });
    }
  });

const ModelCallSchema = z
  .object({
    route: z.enum(["local", "direct", "gateway"]),
    transport: z.enum(["local-compatible", "openai-responses", "openai-compatible", "gateway-model-chain"]),
    outputSchemaVersion: z.literal(1),
    occurredAt: IsoTimestampSchema,
    latencyMs: z.number().int().nonnegative(),
    usage: ModelUsageSchema,
  })
  .strict();

const HashedResponseSchema = (status) =>
  z
    .object({
      status: z.literal(status),
      bodySha256: Sha256Schema,
    })
    .strict();

const CardVersionSchema = z
  .object({
    cardId: IdentifierSchema,
    revision: Sha256Schema,
  })
  .strict();

export const SupportPassportReceiptSchema = z
  .object({
    schemaVersion: z.literal(RECEIPT_SCHEMA_VERSION),
    validationScope: z.literal("self_consistency_only"),
    fixtureHash: Sha256Schema,
    commitSha: CommitShaSchema,
    generatedAt: IsoTimestampSchema,
    cardRevisions: z
      .object({
        drafted: z.array(Sha256Schema).min(1).max(8),
        edited: CardVersionSchema,
        approved: z.array(CardVersionSchema).length(1),
      })
      .strict(),
    grant: z
      .object({
        grantId: IdentifierSchema,
        expiresAt: IsoTimestampSchema,
      })
      .strict(),
    modelCalls: z
      .object({
        draft: ModelCallSchema,
        answer: ModelCallSchema,
      })
      .strict(),
    revokedAt: IsoTimestampSchema,
    httpStatusSequence: z.tuple([
      z.literal(200),
      z.literal(200),
      z.literal(200),
      z.literal(200),
      z.literal(200),
      z.literal(200),
      z.literal(410),
    ]),
    responses: z
      .object({
        draft: HashedResponseSchema(200),
        edit: HashedResponseSchema(200),
        approve: HashedResponseSchema(200),
        grant: HashedResponseSchema(200),
        helperRead: HashedResponseSchema(200),
        helperAsk: HashedResponseSchema(200),
        revoke: HashedResponseSchema(200),
        deniedRead: HashedResponseSchema(410),
      })
      .strict(),
    responseHashChain: Sha256Schema,
    finalResult: z.literal("passed"),
  })
  .strict()
  .superRefine((receipt, context) => {
    const edited = receipt.cardRevisions.edited;
    const approved = receipt.cardRevisions.approved[0];
    if (approved && edited.cardId !== approved.cardId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "the edited and approved card IDs must match" });
    }
    if (approved && edited.revision === approved.revision) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "approval must create a new active revision" });
    }
    if (Date.parse(receipt.revokedAt) > Date.parse(receipt.grant.expiresAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "revoke time must not follow grant expiry" });
    }
  });

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function computeFixtureHash(sourceMemories, expectedPublicCards) {
  return sha256(
    canonicalJson({
      expectedPublicCards,
      sourceMemories,
    })
  );
}

export function computeResponseHashChain(responses) {
  return sha256(canonicalJson(ALL_RESPONSE_ORDER.map((name) => [name, responses[name]])));
}

export function receiptStatusSequence(responses) {
  return PROOF_RESPONSE_ORDER.map((name) => responses[name].status);
}
