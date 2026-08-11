export type SupportPassportErrorCode =
  | "card_data_invalid"
  | "card_not_found"
  | "invalid_card_status"
  | "invalid_input"
  | "revision_conflict"
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
