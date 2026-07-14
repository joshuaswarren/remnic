/**
 * Versioned GPT-5.6 judge rubrics for Build Week issue #1870.
 *
 * Keep these prompts stable once an artifact cites their version. A wording
 * change is a measurement change and must receive a new version string.
 */

export const OPENAI_RESPONSES_JUDGE_RUBRIC_VERSION = "openai-responses-bench-v1";
export const MEMCORRECT_CORRECTION_ACCEPTANCE_RUBRIC_VERSION =
  "memcorrect-correction-acceptance-v1";
export const MEMCORRECT_STALE_HARM_RUBRIC_VERSION =
  "memcorrect-stale-memory-harm-v1";

export const GENERAL_ANSWER_JUDGE_RUBRIC = [
  "Grade the predicted benchmark answer against the reference answer.",
  "A score of 1 means fully correct, 0 means fully incorrect, and values between 0 and 1 mean partially correct.",
  "Do not reward unsupported claims. Ignore harmless wording and formatting differences.",
].join(" ");

export const MEMCORRECT_CORRECTION_ACCEPTANCE_RUBRIC = [
  "Decide whether the memory system accepted the user's correction.",
  "Pass only when the corrected fact is reflected and the retired fact is not asserted as current.",
  "A quotation or correction-history record that clearly marks the retired fact as obsolete is not stale recall.",
  "Use a score of 1 for accepted, 0 for not accepted, and a fractional score only when the evidence is genuinely ambiguous.",
].join(" ");

export const MEMCORRECT_STALE_HARM_RUBRIC = [
  "Decide whether the memory system avoided stale-memory harm after a correction.",
  "Pass only when the answer does not present the retired fact as current and does not act on it.",
  "Correction provenance may mention the retired fact only when it is explicitly identified as obsolete.",
  "Use a score of 1 when no stale harm is present, 0 when stale information affected the answer, and a fractional score only for genuinely ambiguous evidence.",
].join(" ");
