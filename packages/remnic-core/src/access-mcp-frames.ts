/**
 * Content-Length framing for the MCP stdio transport.
 *
 * `push` appends raw bytes. `next` returns one frame at a time and `null` when
 * the buffered bytes hold no complete frame yet. The header and the body are
 * each bounded to MCP_STDIO_MAX_FRAME_BYTES, which matches the HTTP access
 * default `maxBodyBytes`, so a peer cannot grow the buffer without limit.
 */
export const MCP_STDIO_MAX_FRAME_BYTES = 131072;

export type McpFrame = { kind: "body"; text: string } | { kind: "too-large" };

const TOO_LARGE: McpFrame = { kind: "too-large" };

export class McpFrameReader {
  private buffer = Buffer.alloc(0);
  /** Body bytes of a refused oversized frame that have not arrived yet. */
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
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      if (this.buffer.length <= MCP_STDIO_MAX_FRAME_BYTES) return this.wait();
      return this.discardBuffer();
    }
    if (headerEnd > MCP_STDIO_MAX_FRAME_BYTES) return this.discardBuffer();

    const headers = this.buffer.subarray(0, headerEnd).toString("utf-8").split("\r\n");
    const lengthHeader = headers.find((line) => line.toLowerCase().startsWith("content-length:"));
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
      return TOO_LARGE;
    }
    const bodyEnd = bodyStart + contentLength;
    if (this.buffer.length < bodyEnd) return this.wait();
    const text = this.buffer.subarray(bodyStart, bodyEnd).toString("utf-8");
    this.buffer = this.buffer.subarray(bodyEnd);
    return { kind: "body", text };
  }

  private wait(): null {
    this.waitingBytes = this.buffer.length;
    return null;
  }

  private discardBuffer(): McpFrame {
    this.buffer = Buffer.alloc(0);
    return TOO_LARGE;
  }
}
