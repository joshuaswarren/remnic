/**
 * LSP degradation codes — shaped like {@link SearchDegradation} from
 * @remnic/core/search/port (issue #1536, CLAUDE.md rule 34).
 *
 * Every failure mode produces a DISTINCT code so callers (index_status,
 * remnic doctor) can render per-language LSP state without conflating
 * "server not installed" with "server timed out" or "protocol violation".
 *
 * The codes are the load-bearing signal — `detail` is optional and never
 * carries `error.message` (which may contain absolute paths — rule 11).
 */

/**
 * Backend identifier — always `"lsp"` so callers can distinguish LSP
 * degradations from QMD/search degradations in a unified handler.
 */
export type LspBackend = "lsp";

/**
 * Distinct failure codes (rule 34 — never `[]`-on-error).
 *
 *   - `server_missing`      — the configured server binary is not on PATH
 *                              or is not executable (probe phase).
 *   - `handshake_timeout`   — `initialize` did not complete within
 *                              `lsp.timeoutMs`.
 *   - `handshake_error`     — server responded to `initialize` with an
 *                              error or a malformed response.
 *   - `request_timeout`     — a `textDocument/definition` request did
 *                              not receive a response within the
 *                              per-request deadline.
 *   - `request_error`       — server returned a JSON-RPC error response
 *                              for a resolution request.
 *   - `protocol_error`      — malformed JSON-RPC frame (bad header,
 *                              unparseable JSON, unknown method).
 *   - `server_crashed`      — the child process exited unexpectedly
 *                              mid-run.
 *   - `budget_exhausted`    — `lsp.maxRequestsPerRun` reached; remaining
 *                              call sites keep their Phase A resolution.
 *   - `not_enabled`         — `lsp.enabled` is `false`; no probe attempted.
 *   - `unknown_language`    — the file's language has no registered
 *                              server spec and none was overridden in
 *                              `lsp.servers`.
 */
export type LspDegradationCode =
  | "server_missing"
  | "handshake_timeout"
  | "handshake_error"
  | "request_timeout"
  | "request_error"
  | "protocol_error"
  | "server_crashed"
  | "budget_exhausted"
  | "not_enabled"
  | "unknown_language";

/**
 * Tagged degradation — mirrors the shape of {@link SearchDegradation}.
 * `ok: false` results from the client/registry/resolution surface carry
 * this object so consumers can switch on `code` programmatically.
 */
export interface LspDegradation {
  readonly backend: LspBackend;
  readonly code: LspDegradationCode;
  readonly detail?: string;
}

/**
 * Tagged-result helpers — the shared discriminated-union pattern used
 * throughout the coding-graph package (rule 34). Every LSP surface
 * returns `{ ok: true; … }` on success or `{ ok: false; degradation }`
 * on failure — never throws, never returns `[]` to mean "error".
 */
export type LspResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly degradation: LspDegradation };

/**
 * Construct a degradation object. Kept as a factory rather than a class
 * so callers can spread it into a result without `new`.
 */
export function lspDegradation(
  code: LspDegradationCode,
  detail?: string,
): LspDegradation {
  return detail !== undefined ? { backend: "lsp", code, detail } : { backend: "lsp", code };
}
