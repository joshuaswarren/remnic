/**
 * Minimal LSP protocol types — only the subset the resolution pass needs.
 *
 * These are NOT a full LSP type system. They mirror the wire shapes from
 * the LSP specification (v3.17 — https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
 * for the methods we implement: initialize, initialized, shutdown, exit,
 * textDocument/didOpen, textDocument/definition.
 *
 * Keeping a local subset avoids pulling in `vscode-languageserver-protocol`
 * (a dependency the issue explicitly rejects — "No npm LSP framework").
 */

// ──────────────────────────────────────────────────────────────────────────
// Position / Range / Location (LSP 3.17 §3.17–3.18)
// ──────────────────────────────────────────────────────────────────────────

/**
 * LSP Position — zero-based line and character offsets (LSP 3.17 §3.17).
 * `character` is a UTF-16 code-unit offset, matching what tree-sitter
 * byte offsets are converted FROM during the location→node mapping.
 */
export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

/**
 * LSP Range — half-open `[start, end)` (LSP 3.17 §3.18).
 * Matches the coding-graph's half-open byte-span convention (rule 35).
 */
export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

/**
 * LSP Location — a URI + Range (LSP 3.17 §3.19).
 * The resolution pass maps these back to graph nodes by file + span
 * containment.
 */
export interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

// ──────────────────────────────────────────────────────────────────────────
// textDocument identifiers (LSP 3.17 §3.16, §3.17)
// ──────────────────────────────────────────────────────────────────────────

/**
 * LSP TextDocumentIdentifier — a URI identifying a document (LSP 3.17 §3.16).
 */
export interface LspTextDocumentIdentifier {
  readonly uri: string;
}

/**
 * LSP TextDocumentItem — the full open-document payload for didOpen
 * (LSP 3.17 §3.17). Carries the file content so the server can analyze
 * without reading from disk.
 */
export interface LspTextDocumentItem {
  readonly uri: string;
  readonly languageId: string;
  /** Schema version — we always send 1. */
  readonly version: number;
  readonly text: string;
}

/**
 * LSP TextDocumentPositionParams — the request payload for definition
 * (LSP 3.17 §3.18).
 */
export interface LspTextDocumentPositionParams {
  readonly textDocument: LspTextDocumentIdentifier;
  readonly position: LspPosition;
}

// ──────────────────────────────────────────────────────────────────────────
// Initialize (LSP 3.17 §3.16 — Initialize Request)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Client capabilities — we send an empty object because the resolution
 * pass uses no client-side features. The server still needs the field
 * present per the spec.
 */
export interface LspClientCapabilities {
  // Intentionally empty — minimal client.
}

/**
 * Initialize params sent by the client (LSP 3.17 §3.17).
 * `processId` is our PID so a server can track us; `rootUri` is the
 * workspace root for multi-file definition resolution.
 */
export interface LspInitializeParams {
  readonly processId: number | null;
  readonly rootUri: string | null;
  readonly capabilities: LspClientCapabilities;
}

/**
 * Server capabilities — the subset we inspect. `definitionProvider`
 * must be truthy for the resolution pass to work.
 */
export interface LspServerCapabilities {
  readonly definitionProvider?: boolean | object;
  readonly referencesProvider?: boolean | object;
}

/**
 * Initialize result returned by the server (LSP 3.17 §3.17).
 */
export interface LspInitializeResult {
  readonly capabilities: LspServerCapabilities;
  readonly serverInfo?: { readonly name?: string; readonly version?: string };
}

// ──────────────────────────────────────────────────────────────────────────
// JSON-RPC envelope (JSON-RPC 2.0 — LSP transport layer)
// ──────────────────────────────────────────────────────────────────────────

/**
 * JSON-RPC 2.0 request/notification envelope.
 * `id` is present for requests (expects a response), absent for
 * notifications (fire-and-forget).
 */
export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: number | string;
  readonly method: string;
  readonly params?: unknown;
}

/**
 * JSON-RPC 2.0 success response.
 */
export interface JsonRpcResponseSuccess {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result: unknown;
}

/**
 * JSON-RPC 2.0 error response.
 */
export interface JsonRpcResponseError {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcResponseSuccess | JsonRpcResponseError;

/**
 * Type guard — distinguish a success response from an error response.
 */
export function isResponseError(
  msg: JsonRpcResponse,
): msg is JsonRpcResponseError {
  return "error" in msg && msg.error !== undefined;
}
