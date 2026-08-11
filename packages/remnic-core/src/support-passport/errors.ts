export type SupportPassportErrorCode =
  | "card_data_invalid"
  | "card_not_found"
  | "grant_gone"
  | "grant_not_found"
  | "grant_stale"
  | "invalid_card_status"
  | "invalid_input"
  | "revision_conflict"
  | "state_conflict"
  | "storage_conflict";

export class SupportPassportError extends Error {
  readonly code: SupportPassportErrorCode;
  readonly status: number;

  constructor(code: SupportPassportErrorCode, message: string, status: number) {
    super(message);
    this.name = "SupportPassportError";
    this.code = code;
    this.status = status;
  }
}
