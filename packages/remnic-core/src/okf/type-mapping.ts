/**
 * OKF v0.1 `type` mapping (issue #1946) — the single source of truth for
 * the inert `type` metadata emitted alongside Remnic's canonical fields.
 *
 * `category` remains the canonical internal field; `type` is
 * presentation/interop metadata for OKF consumers and NEVER overrides
 * `category` on parse (the parser reads `type` into its own field only).
 */
import path from "node:path";

/** OKF `type` values derived from Remnic memory categories. */
export const OKF_TYPE_BY_CATEGORY: Readonly<Record<string, string>> = Object.freeze({
  fact: "Memory Fact",
  decision: "Decision",
  preference: "Preference",
  commitment: "Commitment",
  relationship: "Relationship",
  principle: "Principle",
  moment: "Moment",
  skill: "Skill",
  correction: "Correction",
  rule: "Rule",
});

/** Fallback for categories not listed above (unknown/future categories). */
export const OKF_TYPE_FALLBACK = "Memory";

/** Stable domain seam over the category table (single mapping source, AGENTS.md pattern 9). */
export function okfTypeForCategory(category: string): string {
  return OKF_TYPE_BY_CATEGORY[category] ?? OKF_TYPE_FALLBACK;
}

/** Artifact memories report `Artifact` regardless of their storage category. */
export function okfTypeForMemory(fm: { category: string; artifactType?: string }): string {
  return fm.artifactType ? "Artifact" : okfTypeForCategory(fm.category);
}

/** OKF types for entity files, derived from the entity kind. */
export const OKF_TYPE_BY_ENTITY_KIND: Readonly<Record<string, string>> = Object.freeze({
  person: "Person",
  company: "Company",
  organization: "Organization",
  project: "Project",
  topic: "Topic",
  technology: "Technology",
  place: "Place",
  event: "Event",
});

/** Stable domain seam over the entity-kind table (single mapping source). */
export function okfTypeForEntityKind(kind: string | undefined): string {
  const normalized = kind?.trim().toLowerCase();
  return (normalized !== undefined && OKF_TYPE_BY_ENTITY_KIND[normalized]) || "Entity";
}

/** Fixed OKF types for non-memory bundle files. */
export const OKF_PROFILE_TYPE = "Profile";
export const OKF_QUESTION_TYPE = "Question";
export const OKF_DECISION_RECORD_TYPE = "Decision Record";
export const OKF_ARCHITECTURE_CARD_TYPE = "Architecture Card";
export const OKF_CODE_MODULE_TYPE = "Code Module";

/**
 * OKF §6/§7 reserve `index.md` and `log.md` for bundle-level files with a
 * different contract. Remnic never writes them (separate issue), and writes
 * targeting those basenames are rejected outright so a stray ID can never
 * shadow a reserved bundle file.
 */
export const OKF_RESERVED_BASENAMES: Readonly<Record<string, true>> = Object.freeze({
  "index.md": true,
  "log.md": true,
});

export function assertNotOkfReservedBasename(filePath: string): void {
  const basename = path.basename(filePath);
  if (OKF_RESERVED_BASENAMES[basename] === true) {
    throw new Error(
      `OKF reserved basename '${basename}' is not a valid memory file target (${filePath}); OKF §6/§7 reserves it for bundle-level files.`,
    );
  }
}
