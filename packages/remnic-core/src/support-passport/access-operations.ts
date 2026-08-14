import { z } from "zod";

import { defineOperation } from "../access-boundary.js";
import {
  SupportPassportCardCategorySchema,
  SupportPassportMemoryIdSchema,
  SupportPassportSourceMemoryIdSchema,
} from "./contracts.js";
import { SupportPassportCreateGrantRequestSchema } from "./grant-contracts.js";

const IsoTimestampSchema = z.string().datetime({ offset: true });
const RevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ReasonCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/);
const GrantIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const EmptySchema = z.object({}).strict();

const ManualDraftSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    statement: z.string().trim().min(1).max(500),
    category: SupportPassportCardCategorySchema,
    reviewBy: IsoTimestampSchema,
  })
  .strict();

const GenerateDraftsSchema = z
  .object({
    sourceMemoryIds: z.array(SupportPassportSourceMemoryIdSchema).min(1).max(20),
    sourceMemoryRevisions: z
      .array(z.object({ memoryId: SupportPassportSourceMemoryIdSchema, revision: RevisionSchema }).strict())
      .min(1)
      .max(20),
    consent: z.literal(true),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (new Set(input.sourceMemoryIds).size !== input.sourceMemoryIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source memory IDs must be unique",
        path: ["sourceMemoryIds"],
      });
    }
    const revisionIds = input.sourceMemoryRevisions.map((source) => source.memoryId);
    if (
      new Set(revisionIds).size !== revisionIds.length ||
      revisionIds.length !== input.sourceMemoryIds.length ||
      input.sourceMemoryIds.some((memoryId) => !revisionIds.includes(memoryId))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source memory revisions must match the selected memory IDs",
        path: ["sourceMemoryRevisions"],
      });
    }
  });

const ReplaceCardSchema = ManualDraftSchema.extend({
  cardId: SupportPassportMemoryIdSchema,
  expectedRevision: RevisionSchema,
}).strict();

const CardMutationSchema = z
  .object({
    cardId: SupportPassportMemoryIdSchema,
    expectedRevision: RevisionSchema,
    reasonCode: ReasonCodeSchema,
  })
  .strict();

const RevokeGrantSchema = z
  .object({
    grantId: GrantIdSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

const PublicGrantSchema = z
  .object({
    grantId: GrantIdSchema,
    secret: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  })
  .strict();

const AskGrantSchema = PublicGrantSchema.extend({
  question: z.string().trim().min(1).max(500),
}).strict();

function principal(value: string | undefined): string {
  return value ?? "";
}

export const supportPassportMemoryPreviewOperation = defineOperation({
  name: "support_passport_memory_preview",
  description: "Preview one owner memory and bind it to a support-card consent revision.",
  schema: z.object({ memoryId: SupportPassportSourceMemoryIdSchema }).strict(),
  handler: async (input, ctx) => ({
    result: await ctx.service.supportPassportPreviewMemory(principal(ctx.authenticatedPrincipal), input.memoryId),
  }),
});

export const supportPassportCardsListOperation = defineOperation({
  name: "support_passport_cards_list",
  description: "List the authenticated owner's support cards.",
  schema: EmptySchema,
  handler: async (_input, ctx) => ({
    result: { cards: await ctx.service.supportPassportListCards(principal(ctx.authenticatedPrincipal)) },
  }),
});

export const supportPassportDraftCreateOperation = defineOperation({
  name: "support_passport_draft_create",
  description: "Create one support card draft for the authenticated owner.",
  schema: ManualDraftSchema,
  handler: async (input, ctx) => ({
    result: {
      card: await ctx.service.supportPassportCreateManualDraft(
        principal(ctx.authenticatedPrincipal),
        input,
        {
          ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
          ...(ctx.hooks?.recordWriteCommit ? { onCommitted: ctx.hooks.recordWriteCommit } : {}),
        }
      ),
    },
  }),
});

export const supportPassportDraftsGenerateOperation = defineOperation({
  name: "support_passport_drafts_generate",
  description: "Draft support cards from selected owner memories after explicit consent.",
  schema: GenerateDraftsSchema,
  handler: async (input, ctx) => ({
    result: {
      cards: await ctx.service.supportPassportGenerateDrafts(principal(ctx.authenticatedPrincipal), {
        ...input,
        signal: ctx.abortSignal,
        ...(ctx.hooks?.recordWriteCommit ? { onCommitted: ctx.hooks.recordWriteCommit } : {}),
      }),
    },
  }),
});

export const supportPassportCardReplaceOperation = defineOperation({
  name: "support_passport_card_replace",
  description: "Replace one support card with a new owner-reviewed draft.",
  schema: ReplaceCardSchema,
  handler: async ({ cardId, ...input }, ctx) => ({
    result: {
      card: await ctx.service.supportPassportReplaceCard(
        principal(ctx.authenticatedPrincipal),
        cardId,
        input,
        {
          ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
          ...(ctx.hooks?.recordWriteCommit ? { onCommitted: ctx.hooks.recordWriteCommit } : {}),
        }
      ),
    },
  }),
});

function defineCardMutation(
  name: "support_passport_card_approve" | "support_passport_card_reject" | "support_passport_card_withdraw",
  description: string,
  run: "supportPassportApproveCard" | "supportPassportRejectCard" | "supportPassportWithdrawCard"
) {
  return defineOperation({
    name,
    description,
    schema: CardMutationSchema,
    handler: async ({ cardId, ...input }, ctx) => ({
      result: {
        card: await ctx.service[run](
          principal(ctx.authenticatedPrincipal),
          cardId,
          input,
          {
            ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
            ...(ctx.hooks?.recordWriteCommit ? { onCommitted: ctx.hooks.recordWriteCommit } : {}),
          }
        ),
      },
    }),
  });
}

export const supportPassportCardApproveOperation = defineCardMutation(
  "support_passport_card_approve",
  "Approve one pending support card as its authenticated owner.",
  "supportPassportApproveCard"
);
export const supportPassportCardRejectOperation = defineCardMutation(
  "support_passport_card_reject",
  "Reject one pending support card as its authenticated owner.",
  "supportPassportRejectCard"
);
export const supportPassportCardWithdrawOperation = defineCardMutation(
  "support_passport_card_withdraw",
  "Withdraw one approved support card as its authenticated owner.",
  "supportPassportWithdrawCard"
);

export const supportPassportGrantCreateOperation = defineOperation({
  name: "support_passport_grant_create",
  description: "Create one timed share link for exact approved support card versions.",
  schema: SupportPassportCreateGrantRequestSchema,
  handler: async (input, ctx) => ({
    result: await ctx.service.supportPassportCreateGrant(
      principal(ctx.authenticatedPrincipal),
      input,
      {
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        ...(ctx.hooks?.recordWriteCommit ? { onCommitted: ctx.hooks.recordWriteCommit } : {}),
      }
    ),
  }),
});

export const supportPassportGrantsListOperation = defineOperation({
  name: "support_passport_grants_list",
  description: "List the authenticated owner's support passport share links without secrets.",
  schema: EmptySchema,
  handler: async (_input, ctx) => ({
    result: { grants: await ctx.service.supportPassportListGrants(principal(ctx.authenticatedPrincipal)) },
  }),
});

export const supportPassportGrantRevokeOperation = defineOperation({
  name: "support_passport_grant_revoke",
  description: "Stop one support passport share link as its authenticated owner.",
  schema: RevokeGrantSchema,
  handler: async ({ grantId, ...input }, ctx) => ({
    result: await ctx.service.supportPassportRevokeGrant(
      principal(ctx.authenticatedPrincipal),
      grantId,
      input,
      {
        ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        ...(ctx.hooks?.recordWriteCommit ? { onCommitted: ctx.hooks.recordWriteCommit } : {}),
      }
    ),
  }),
});

export const supportPassportGrantReadOperation = defineOperation({
  name: "support_passport_grant_read",
  description: "Read one active support passport share link.",
  schema: PublicGrantSchema,
  handler: async ({ grantId, secret }, ctx) => ({
    result: await ctx.service.supportPassportReadGrant(grantId, secret),
  }),
});

export const supportPassportGrantAskOperation = defineOperation({
  name: "support_passport_grant_ask",
  description: "Answer one helper question from an active support passport share link.",
  schema: AskGrantSchema,
  handler: async ({ grantId, secret, question }, ctx) => ({
    result: await ctx.service.supportPassportAskGrant(grantId, secret, question, ctx.abortSignal),
  }),
});
