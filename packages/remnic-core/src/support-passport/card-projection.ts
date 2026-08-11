import type { MemoryFile } from "../types.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import {
  computeSupportPassportCardRevision,
  SupportPassportCardCategorySchema,
  SupportPassportCardSchema,
  SupportPassportCardStatusSchema,
  type SupportPassportCard,
} from "./contracts.js";

export const SUPPORT_PASSPORT_CARD_TAG = "support-passport-card";
export const SUPPORT_PASSPORT_ATTRIBUTE_KEYS = Object.freeze({
  title: "support-passport-title",
  category: "support-passport-category",
  order: "support-passport-order",
  reviewBy: "support-passport-review-by",
  sourceMemoryIds: "support-passport-source-ids",
});

export interface StoredSupportPassportCard {
  card: SupportPassportCard;
  memory: MemoryFile;
  order: number;
  sourceMemoryIds: string[];
}

function parseSourceMemoryIds(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 5) return null;
    if (parsed.some((id) => typeof id !== "string" || id.length < 1 || id.length > 128)) return null;
    if (new Set(parsed).size !== parsed.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function projectSupportPassportCard(memory: MemoryFile): StoredSupportPassportCard | null {
  const frontmatter = memory.frontmatter;
  const attributes = frontmatter.structuredAttributes;
  if (frontmatter.category !== "preference") return null;
  if (!frontmatter.tags?.includes(SUPPORT_PASSPORT_CARD_TAG)) return null;
  if (!attributes || frontmatter.blockedBy || frontmatter.archivedAt) return null;

  const category = SupportPassportCardCategorySchema.safeParse(attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.category]);
  const status = SupportPassportCardStatusSchema.safeParse(frontmatter.status);
  const order = Number(attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.order]);
  const sourceMemoryIds = parseSourceMemoryIds(attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.sourceMemoryIds] ?? "");
  if (!category.success || !status.success || !Number.isSafeInteger(order) || order < 0 || !sourceMemoryIds) return null;

  const fields = {
    cardId: frontmatter.id,
    title: attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.title] ?? "",
    statement: stripAttributesSuffix(memory.content),
    category: category.data,
    status: status.data,
    updatedAt: frontmatter.updated,
    reviewBy: attributes[SUPPORT_PASSPORT_ATTRIBUTE_KEYS.reviewBy] ?? "",
  };
  const parsed = SupportPassportCardSchema.safeParse({
    ...fields,
    revision: computeSupportPassportCardRevision(fields),
  });
  if (!parsed.success) return null;
  return { card: parsed.data, memory, order, sourceMemoryIds };
}
