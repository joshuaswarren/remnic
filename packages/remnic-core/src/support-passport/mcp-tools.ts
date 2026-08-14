import type { McpTool } from "../access-mcp.js";
import { SUPPORT_PASSPORT_SOURCE_MEMORY_ID_MAX_LENGTH } from "./contracts.js";

const CARD_CATEGORIES = [
  "communication",
  "environment",
  "transitions",
  "sensory",
  "regulation",
  "interests",
  "other",
] as const;

const cardTextProperties = {
  title: { type: "string", minLength: 1, maxLength: 80 },
  statement: { type: "string", minLength: 1, maxLength: 500 },
  category: { type: "string", enum: CARD_CATEGORIES },
  reviewBy: { type: "string", format: "date-time" },
};

const cardRevisionProperties = {
  cardId: { type: "string", minLength: 1, maxLength: 128 },
  expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$" },
};

const cardMutationProperties = {
  ...cardRevisionProperties,
  reasonCode: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" },
};

const sourceMemoryIdProperty = {
  type: "string",
  minLength: 1,
  maxLength: SUPPORT_PASSPORT_SOURCE_MEMORY_ID_MAX_LENGTH,
};

export const SUPPORT_PASSPORT_MCP_MIGRATED_OPERATIONS = {
  "engram.support_passport_memory_preview": "support_passport_memory_preview",
  "engram.support_passport_cards_list": "support_passport_cards_list",
  "engram.support_passport_draft_create": "support_passport_draft_create",
  "engram.support_passport_drafts_generate": "support_passport_drafts_generate",
  "engram.support_passport_card_replace": "support_passport_card_replace",
  "engram.support_passport_card_approve": "support_passport_card_approve",
  "engram.support_passport_card_reject": "support_passport_card_reject",
  "engram.support_passport_card_withdraw": "support_passport_card_withdraw",
  "engram.support_passport_grant_create": "support_passport_grant_create",
  "engram.support_passport_grants_list": "support_passport_grants_list",
  "engram.support_passport_grant_revoke": "support_passport_grant_revoke",
} as const;

export const SUPPORT_PASSPORT_MCP_TOOLS: McpTool[] = [
  {
    name: "engram.support_passport_memory_preview",
    description: "Preview one memory and get the exact revision required for model drafting consent.",
    inputSchema: {
      type: "object",
      properties: { memoryId: sourceMemoryIdProperty },
      required: ["memoryId"],
      additionalProperties: false,
    },
  },
  {
    name: "engram.support_passport_cards_list",
    description: "List your support cards.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "engram.support_passport_draft_create",
    description: "Create one support card draft for your review.",
    inputSchema: {
      type: "object",
      properties: cardTextProperties,
      required: ["title", "statement", "category", "reviewBy"],
      additionalProperties: false,
    },
  },
  {
    name: "engram.support_passport_drafts_generate",
    description: "Draft support cards from only the memories you select and consent to send to your configured model.",
    inputSchema: {
      type: "object",
      properties: {
        sourceMemoryIds: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
          items: sourceMemoryIdProperty,
        },
        sourceMemoryRevisions: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
          items: {
            type: "object",
            properties: {
              memoryId: sourceMemoryIdProperty,
              revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
            required: ["memoryId", "revision"],
            additionalProperties: false,
          },
        },
        consent: { const: true },
      },
      required: ["sourceMemoryIds", "sourceMemoryRevisions", "consent"],
      additionalProperties: false,
    },
  },
  {
    name: "engram.support_passport_card_replace",
    description: "Create a replacement draft for one support card.",
    inputSchema: {
      type: "object",
      properties: { ...cardTextProperties, ...cardRevisionProperties },
      required: ["cardId", "title", "statement", "category", "reviewBy", "expectedRevision"],
      additionalProperties: false,
    },
  },
  ...(["approve", "reject", "withdraw"] as const).map(
    (action): McpTool => ({
      name: `engram.support_passport_card_${action}`,
      description: `${action === "withdraw" ? "Withdraw" : action === "approve" ? "Approve" : "Reject"} one support card as its owner.`,
      inputSchema: {
        type: "object",
        properties: cardMutationProperties,
        required: ["cardId", "expectedRevision", "reasonCode"],
        additionalProperties: false,
      },
    })
  ),
  {
    name: "engram.support_passport_grant_create",
    description: "Create one timed share link for selected approved support cards.",
    inputSchema: {
      type: "object",
      properties: {
        cardIds: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 128 },
        },
        cardRevisions: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: {
            type: "object",
            properties: {
              cardId: { type: "string", minLength: 1, maxLength: 128 },
              revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
            required: ["cardId", "revision"],
            additionalProperties: false,
          },
        },
        expiresAt: { type: "string", format: "date-time" },
        durationMs: { type: "integer", minimum: 300_000, maximum: 604_800_000 },
      },
      required: ["cardIds", "cardRevisions"],
      oneOf: [{ required: ["expiresAt"] }, { required: ["durationMs"] }],
      additionalProperties: false,
    },
  },
  {
    name: "engram.support_passport_grants_list",
    description: "List your support passport share links without secrets.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "engram.support_passport_grant_revoke",
    description: "Stop one support passport share link.",
    inputSchema: {
      type: "object",
      properties: {
        grantId: { type: "string", minLength: 1, maxLength: 128 },
        expectedVersion: { type: "integer", minimum: 1 },
      },
      required: ["grantId", "expectedVersion"],
      additionalProperties: false,
    },
  },
];
