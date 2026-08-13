import { z } from "zod";

import { parseIsoOffsetTimestamp } from "../utils/iso-timestamp.js";
import {
  SupportPassportCardCategorySchema,
  SupportPassportMemoryIdSchema,
  SupportPassportNamespaceSchema,
} from "./contracts.js";

const IsoTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => parseIsoOffsetTimestamp(value) !== null, "timestamp must be a real date");
const RevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const GrantIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export const SupportPassportGrantCardRefSchema = z
  .object({
    cardId: SupportPassportMemoryIdSchema,
    revision: RevisionSchema,
  })
  .strict();

export const SupportPassportGrantStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    stateVersion: z.number().int().positive(),
    grantId: GrantIdSchema,
    namespace: SupportPassportNamespaceSchema,
    principalHash: RevisionSchema,
    ownerLockKey: RevisionSchema,
    secretHash: RevisionSchema,
    cards: z.array(SupportPassportGrantCardRefSchema).min(1).max(8),
    createdAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
    revokedAt: IsoTimestampSchema.optional(),
  })
  .strict()
  .superRefine((grant, ctx) => {
    const ids = new Set<string>();
    for (const [index, card] of grant.cards.entries()) {
      if (ids.has(card.cardId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "card IDs must be unique",
          path: ["cards", index, "cardId"],
        });
      }
      ids.add(card.cardId);
    }
    if (Date.parse(grant.expiresAt) <= Date.parse(grant.createdAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expiresAt must follow createdAt", path: ["expiresAt"] });
    }
  });

export const SupportPassportCreateGrantInputSchema = z
  .object({
    principal: z.string().trim().min(1).max(512),
    cards: z.array(SupportPassportGrantCardRefSchema).min(1).max(8),
    expiresAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    const ids = new Set<string>();
    for (const [index, card] of input.cards.entries()) {
      if (ids.has(card.cardId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "card IDs must be unique",
          path: ["cards", index, "cardId"],
        });
      }
      ids.add(card.cardId);
    }
  });

export const SupportPassportCreateGrantRequestSchema = z
  .object({
    cardIds: z.array(SupportPassportMemoryIdSchema).min(1).max(8),
    cardRevisions: z.array(SupportPassportGrantCardRefSchema).min(1).max(8),
    expiresAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((input, ctx) => {
    const cardIds = new Set(input.cardIds);
    const revisionIds = new Set(input.cardRevisions.map((card) => card.cardId));
    if (
      cardIds.size !== input.cardIds.length ||
      revisionIds.size !== input.cardRevisions.length ||
      cardIds.size !== revisionIds.size ||
      input.cardIds.some((cardId) => !revisionIds.has(cardId))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "card revisions must match the selected card IDs",
        path: ["cardRevisions"],
      });
    }
  });

export const SupportPassportOwnerGrantSchema = z
  .object({
    grantId: GrantIdSchema,
    stateVersion: z.number().int().positive(),
    cards: z.array(SupportPassportGrantCardRefSchema).min(1).max(8),
    createdAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
    revokedAt: IsoTimestampSchema.optional(),
    status: z.enum(["active", "expired", "revoked"]),
  })
  .strict();

export const SupportPassportCreatedGrantSchema = z
  .object({
    grant: SupportPassportOwnerGrantSchema,
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export const SupportPassportPublicCardSchema = z
  .object({
    cardId: SupportPassportMemoryIdSchema,
    title: z.string().trim().min(1).max(80),
    statement: z.string().trim().min(1).max(500),
    category: SupportPassportCardCategorySchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();

export const SupportPassportPublicGuideSchema = z
  .object({
    schemaVersion: z.literal(1),
    grantId: GrantIdSchema,
    expiresAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    cards: z.array(SupportPassportPublicCardSchema).min(1).max(8),
  })
  .strict();

export const SupportPassportRevokeGrantInputSchema = z
  .object({
    principal: z.string().trim().min(1).max(512),
    grantId: GrantIdSchema,
    expectedStateVersion: z.number().int().positive().optional(),
  })
  .strict();

export const SupportPassportListGrantsInputSchema = z
  .object({
    principal: z.string().trim().min(1).max(512),
  })
  .strict();

export type SupportPassportGrantCardRef = z.infer<typeof SupportPassportGrantCardRefSchema>;
export type SupportPassportGrantState = z.infer<typeof SupportPassportGrantStateSchema>;
export type SupportPassportCreateGrantInput = z.input<typeof SupportPassportCreateGrantInputSchema>;
export type SupportPassportCreateGrantRequest = z.input<typeof SupportPassportCreateGrantRequestSchema>;
export type SupportPassportOwnerGrant = z.infer<typeof SupportPassportOwnerGrantSchema>;
export type SupportPassportCreatedGrant = z.infer<typeof SupportPassportCreatedGrantSchema>;
export type SupportPassportPublicGuide = z.infer<typeof SupportPassportPublicGuideSchema>;
export type SupportPassportRevokeGrantInput = z.input<typeof SupportPassportRevokeGrantInputSchema>;
