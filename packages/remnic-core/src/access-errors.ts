/** Authenticated caller lacks the required authorization (HTTP 403). */
export class EngramAccessForbiddenError extends Error {}

/** Invalid caller input (HTTP 400). */
export class EngramAccessInputError extends Error {}

/**
 * A write rejected by the namespace write-ACL (issue #1888). Subclasses
 * EngramAccessInputError so every existing catch/HTTP-400 mapping still
 * applies, but carries the attempted namespace + principal so the observe/
 * write surfaces can dead-letter the payload before re-throwing (fail-closed
 * placement is unchanged; only the destroyed-payload behavior is fixed).
 */
export class NamespaceNotWritableError extends EngramAccessInputError {
  constructor(
    readonly attemptedNamespace: string,
    readonly principal: string | undefined,
    message?: string
  ) {
    super(message ?? `namespace is not writable: ${attemptedNamespace}`);
    this.name = "NamespaceNotWritableError";
  }
}
