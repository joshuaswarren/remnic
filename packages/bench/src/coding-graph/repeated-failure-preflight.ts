import type { RepeatedFailureInvalidReason } from "./repeated-failure-types.js";

export type RepeatedFailurePreflightInvalidReason = Extract<
  RepeatedFailureInvalidReason,
  "CORPUS_INVALID" | "CORE_REPO_DIR_MISMATCH"
>;

export class RepeatedFailurePreflightError extends Error {
  readonly invalidReason: RepeatedFailurePreflightInvalidReason;

  constructor(invalidReason: RepeatedFailurePreflightInvalidReason, message: string) {
    super(message);
    this.name = "RepeatedFailurePreflightError";
    this.invalidReason = invalidReason;
  }
}
