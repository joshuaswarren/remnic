export type SupportPassportErrorCode =
  | "card_data_invalid"
  | "card_not_found"
  | "consent_required"
  | "feature_disabled"
  | "forbidden"
  | "grant_expired"
  | "grant_gone"
  | "grant_not_found"
  | "grant_stale"
  | "invalid_card_status"
  | "invalid_input"
  | "model_output_invalid"
  | "provider_unavailable"
  | "rate_limited"
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
