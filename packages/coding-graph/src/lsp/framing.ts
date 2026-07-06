/**
 * Length-prefixed LSP framing — `Content-Length: <N>\r\n\r\n` headers
 * followed by exactly `<N>` bytes of JSON body (LSP 3.17 §6.1 — Base Protocol).
 *
 * This is the one module where off-by-one and split-buffer bugs hide.
 * The parser tracks a RUNNING OFFSET — it never re-scans bytes a
 * previous scan already confirmed separator-free (rule 32).
 */

// ──────────────────────────────────────────────────────────────────────────
// Encoder — serialize a JSON-RPC message into a Content-Length frame.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Encode a JSON-RPC message as a Content-Length-prefixed frame ready to
 * write to the server's stdin. Uses UTF-8 — the LSP base protocol
 * mandates UTF-8 content encoding (§6.1).
 */
export function encodeLspFrame(message: unknown): string {
  const body = JSON.stringify(message);
  // Content-Length counts UTF-8 BYTES, not JS UTF-16 code units. Node's
  // Buffer.byteLength accounts for multi-byte sequences.
  const byteLength = Buffer.byteLength(body, "utf8");
  return `Content-Length: ${byteLength}\r\n\r\n${body}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Decoder — streaming parser that accumulates chunks and yields complete
// messages. Never throws on partial input — it just returns fewer messages
// and retains the residual for the next feed() call.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Reason for a decode failure. A `protocol_error` degradation surfaces
 * the specific reason so the caller can distinguish "bad header" from
 * "unparseable JSON body".
 */
export type FrameDecodeErrorKind =
  | "malformed_header" // header line is not `Content-Length: <digits>`
  | "json_parse_error"; // body is not valid JSON

export interface FrameDecodeError {
  readonly kind: FrameDecodeErrorKind;
  readonly detail: string;
}

export interface FrameDecodeSuccess {
  readonly ok: true;
  readonly messages: unknown[];
}

export type FrameDecodeResult = FrameDecodeSuccess | { readonly ok: false; readonly error: FrameDecodeError };

// Sentinel for the header/body separator — `\r\n\r\n` (as bytes).
const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");
const HEADER_SEPARATOR_LEN = HEADER_SEPARATOR.length;

/**
 * Streaming LSP frame decoder. Feed raw Buffer or string chunks via
 * {@link feed}; each call returns the complete JSON messages parsed
 * since the last call, plus any error if a frame was malformed.
 *
 * Works with BYTES internally because Content-Length counts UTF-8 bytes
 * (LSP 3.17 §6.1), not UTF-16 code units. A string-based buffer would
 * mis-slice any body containing multi-byte characters (𝕏, emoji, CJK).
 *
 * The decoder maintains a running byte-buffer and a scan offset. After
 * each feed, consumed bytes are sliced away so the buffer never grows
 * unbounded across a long session (rule 11 — no unbounded state).
 */
export class LspFrameDecoder {
  private buffer = Buffer.alloc(0);
  /**
   * Scan offset into {@link buffer}. The header scan resumes here on
   * the next feed() — never re-scans bytes already confirmed to not
   * contain the separator (rule 32). Reset to 0 after each consumed
   * frame because slicing the buffer discards those bytes.
   */
  private scanOffset = 0;

  /**
   * Feed a raw chunk (Buffer or string) from the server's stdout.
   * Returns all complete messages parsed from the accumulated buffer
   * since the last call, or the first decode error encountered (the
   * decoder stops on error — a protocol violation means the stream is
   * corrupt and further parsing is undefined).
   */
  feed(chunk: Buffer | string): FrameDecodeResult {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buffer = this.buffer.length === 0 ? Buffer.from(buf) : Buffer.concat([this.buffer, buf]);
    const messages: unknown[] = [];

    // Loop: extract as many complete frames as the current buffer holds.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const sepIdx = this.buffer.indexOf(HEADER_SEPARATOR, this.scanOffset);
      if (sepIdx < 0) {
        // No complete header yet. Advance scanOffset past the bytes
        // already confirmed separator-free (rule 32). The separator is
        // 4 bytes, so a partial match could start up to 3 bytes before
        // the current end.
        this.scanOffset = Math.max(0, this.buffer.length - (HEADER_SEPARATOR_LEN - 1));
        return { ok: true, messages };
      }

      const headerBlock = this.buffer.subarray(0, sepIdx).toString("utf8");
      const contentLength = parseContentLength(headerBlock);
      if (contentLength === null) {
        return {
          ok: false,
          error: {
            kind: "malformed_header",
            detail: `header block has no valid Content-Length: ${JSON.stringify(headerBlock)}`,
          },
        };
      }

      const bodyStart = sepIdx + HEADER_SEPARATOR_LEN;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) {
        // Body not fully received yet. Back up scanOffset to just before
        // the separator so the next feed re-finds it.
        this.scanOffset = Math.max(0, sepIdx - (HEADER_SEPARATOR_LEN - 1));
        return { ok: true, messages };
      }

      const bodyBytes = this.buffer.subarray(bodyStart, bodyEnd);
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyBytes.toString("utf8"));
      } catch (e) {
        return {
          ok: false,
          error: {
            kind: "json_parse_error",
            detail: `body is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
          },
        };
      }
      messages.push(parsed);

      // Slice consumed bytes off the front — subarray returns a view
      // into the same memory; concat on the next feed replaces it.
      this.buffer = this.buffer.subarray(bodyEnd);
      this.scanOffset = 0;
    }
  }

  /** True if there is un-consumed residual data in the buffer. */
  get hasResidual(): boolean {
    return this.buffer.length > 0;
  }

  /** Reset the decoder to a clean state (test seam). */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.scanOffset = 0;
  }
}

/**
 * Parse the `Content-Length` value from a header block. Returns the byte
 * count or null if the header is absent or malformed. LSP headers are
 * case-insensitive and may appear in any order, but Content-Length is
 * mandatory (§6.1).
 */
function parseContentLength(headerBlock: string): number | null {
  const lines = headerBlock.split("\r\n");
  for (const line of lines) {
    const match = /^Content-Length:\s*(\d+)\s*$/i.exec(line);
    if (match) {
      const n = Number(match[1]);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
  }
  return null;
}
