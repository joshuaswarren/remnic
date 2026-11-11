/**
 * Framing for the MCP stdio transport.
 *
 * The MCP spec sends one JSON message per line. Some clients send a
 * `Content-Length` header instead. `push` appends raw bytes. `next` returns one
 * frame at a time and `null` when the buffered bytes hold no complete frame
 * yet. A buffer that starts with `Content-Length:` is a header frame. Any other
 * buffer is read up to the next newline. Each form is bounded to
 * MCP_STDIO_MAX_FRAME_BYTES, so a peer cannot grow the buffer without limit.
 */
export const MCP_STDIO_MAX_FRAME_BYTES = 131072;

export type McpFrameForm = "header" | "line";

export type McpFrame =
  | { kind: "body"; text: string; form: McpFrameForm }
  | { kind: "too-large"; form: McpFrameForm };

const HEADER_PREFIX = "content-length:";

export class McpFrameReader {
  private buffer = Buffer.alloc(0);
  /** Body bytes of a refused oversized header frame that have not arrived yet. */
  private skipBytes = 0;
  /** Buffer length when `next` last stopped on an incomplete frame. */
  private waitingBytes = 0;

  push(chunk: Buffer): void {
    const dropped = Math.min(this.skipBytes, chunk.length);
    this.skipBytes -= dropped;
    const kept = chunk.subarray(dropped);
    if (kept.length > 0) this.buffer = Buffer.concat([this.buffer, kept]);
  }

  /** True when bytes arrived after `next` last examined the buffer. */
  hasUnread(): boolean {
    return this.buffer.length > this.waitingBytes;
  }

  next(): McpFrame | null {
    this.waitingBytes = 0;
    // A blank line carries no message. Skip it and read the next frame, so a
    // run of blank lines cannot stall the frames that follow in this buffer.
    for (;;) {
      const frame = this.isHeaderFrame() ? this.nextHeader() : this.nextLine();
      if (frame !== "blank") return frame;
    }
  }

  /** A header frame starts with `Content-Length:`. Anything else is a line. */
  private isHeaderFrame(): boolean {
    if (this.buffer.length < HEADER_PREFIX.length) return false;
    return this.buffer.subarray(0, HEADER_PREFIX.length).toString("utf-8").toLowerCase() === HEADER_PREFIX;
  }

  private nextHeader(): McpFrame | null {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      if (this.buffer.length <= MCP_STDIO_MAX_FRAME_BYTES) return this.wait();
      return this.discardBuffer("header");
    }
    if (headerEnd > MCP_STDIO_MAX_FRAME_BYTES) return this.discardBuffer("header");

    const headers = this.buffer.subarray(0, headerEnd).toString("utf-8").split("\r\n");
    const lengthHeader = headers.find((line) => line.toLowerCase().startsWith(HEADER_PREFIX));
    const contentLength = lengthHeader ? Number.parseInt(lengthHeader.split(":")[1]?.trim() ?? "0", 10) : NaN;
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      this.buffer = Buffer.alloc(0);
      return null;
    }

    const bodyStart = headerEnd + 4;
    if (contentLength > MCP_STDIO_MAX_FRAME_BYTES) {
      const rest = this.buffer.subarray(bodyStart);
      this.skipBytes = Math.max(0, contentLength - rest.length);
      this.buffer = rest.subarray(Math.min(contentLength, rest.length));
      return { kind: "too-large", form: "header" };
    }
    const bodyEnd = bodyStart + contentLength;
    if (this.buffer.length < bodyEnd) return this.wait();
    const text = this.buffer.subarray(bodyStart, bodyEnd).toString("utf-8");
    this.buffer = this.buffer.subarray(bodyEnd);
    return { kind: "body", text, form: "header" };
  }

  /** A line frame, `"blank"` for an empty line, or `null` when more bytes must arrive. */
  private nextLine(): McpFrame | "blank" | null {
    const newline = this.buffer.indexOf("\n");
    if (newline < 0) {
      if (this.buffer.length <= MCP_STDIO_MAX_FRAME_BYTES) return this.wait();
      return this.discardBuffer("line");
    }
    if (newline > MCP_STDIO_MAX_FRAME_BYTES) return this.discardBuffer("line");
    const text = this.buffer.subarray(0, newline).toString("utf-8").replace(/\r$/, "");
    this.buffer = this.buffer.subarray(newline + 1);
    if (text.trim().length === 0) return "blank";
    return { kind: "body", text, form: "line" };
  }

  private wait(): null {
    this.waitingBytes = this.buffer.length;
    return null;
  }

  private discardBuffer(form: McpFrameForm): McpFrame {
    this.buffer = Buffer.alloc(0);
    return { kind: "too-large", form };
  }
}
