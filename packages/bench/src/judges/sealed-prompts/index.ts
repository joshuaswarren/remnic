/**
 * Sealed rubric prompt registry.
 *
 * The canonical form of each sealed rubric prompt is a frozen string literal
 * in this registry. The matching `.md` file in this directory is a
 * human-readable mirror kept for reviewers — the `.md` is never loaded at
 * runtime. This keeps bundling trivial (no filesystem assets) while still
 * letting reviewers audit rubric text as prose.
 *
 * Rotation policy:
 *   - Never edit an existing entry in place.
 *   - Add a new key (`assistant-rubric-v2`, etc.) and ship a matching `.md`.
 *   - Keep the old entry available so historical benchmark results remain
 *     reproducible.
 */

import { ASSISTANT_RUBRIC_V1, ASSISTANT_RUBRIC_V1_ID } from "./assistant-rubric-v1.js";

export const SEALED_PROMPT_REGISTRY: Readonly<Record<string, string>> = Object.freeze({
  [ASSISTANT_RUBRIC_V1_ID]: ASSISTANT_RUBRIC_V1,
});

export const DEFAULT_ASSISTANT_RUBRIC_ID = ASSISTANT_RUBRIC_V1_ID;
