
export class CaptureConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureConfigError";
  }
}

/** Caller-correctable request/CLI input — maps to HTTP 400. */
export class CaptureInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureInputError";
  }
}
