/**
 * Minimal JSON-RPC-over-stdio LSP client.
 *
 * Implements exactly the protocol subset the resolution pass needs
 * (LSP 3.17): initialize → initialized → didOpen → definition →
 * shutdown → exit. No npm LSP framework — the protocol subset is small
 * and a dependency here would bloat the optional package (issue #1555).
 *
 * Failure discipline (rule 13): every operation degrades to a tagged
 * `LspDegradation` — the client NEVER throws to a caller. Server crashes
 * mid-run, protocol errors, and timeouts all surface as distinct codes.
 *
 * Lifecycle: the client owns the child process. `dispose()` sends
 * shutdown + exit, then hard-kills (SIGKILL) any lingering process —
 * no zombie children survive (tested).
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import process from "node:process";

import {
  encodeLspFrame,
  LspFrameDecoder,
} from "./framing.js";
import {
  type JsonRpcRequest,
  type LspInitializeParams,
  type LspInitializeResult,
  type LspLocation,
  type LspTextDocumentItem,
  type LspTextDocumentPositionParams,
} from "./types.js";
import {
  lspDegradation,
  type LspDegradation,
  type LspResult,
} from "./degradation.js";
import type { LspServerLaunchSpec } from "./config.js";

// ──────────────────────────────────────────────────────────────────────────
// Pending-request entry — stores the resolver pair + timeout handle.
// ──────────────────────────────────────────────────────────────────────────

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (degradation: LspDegradation) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

// ──────────────────────────────────────────────────────────────────────────
// Connection options
// ──────────────────────────────────────────────────────────────────────────

export interface LspClientOptions {
  readonly launchSpec: LspServerLaunchSpec;
  readonly rootUri: string | null;
  readonly timeoutMs: number;
  /**
   * Optional spawn override — test seam. When provided, the client calls
   * this instead of `child_process.spawn`. Must return a ChildProcess-
   * compatible object with stdin/stdout streams.
   */
  readonly spawnFn?: typeof spawn;
}

// ──────────────────────────────────────────────────────────────────────────
// LspClient — the connection. One instance per server process.
// ──────────────────────────────────────────────────────────────────────────

export class LspClient {
  private readonly child: ChildProcess;
  private readonly decoder = new LspFrameDecoder();
  private readonly rootUri: string | null;
  private readonly timeoutMs: number;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private disposed = false;
  private crashed = false;
  private serverCapabilities: LspInitializeResult["capabilities"] | null = null;

  private constructor(child: ChildProcess, rootUri: string | null, timeoutMs: number) {
    this.child = child;
    this.rootUri = rootUri;
    this.timeoutMs = timeoutMs;

    // Wire stdout → decoder → message dispatcher.
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: Buffer | string) => this.onStdoutData(chunk));

    // Drain stderr so the OS pipe buffer doesn't fill and block the server.
    this.child.stderr?.on("data", () => {});

    // Unexpected exit → mark crashed, reject all pending.
    this.child.on("exit", (code, signal) => this.onChildExit(code, signal));
    this.child.on("error", (err) => this.onChildError(err));
  }

  /**
   * Spawn the server and perform the initialize handshake. Returns a
   * tagged result — `{ ok: true, client }` on success, or a degradation
   * on failure (server_missing, handshake_timeout, handshake_error).
   */
  static async connect(options: LspClientOptions): Promise<
    | { ok: true; client: LspClient }
    | { ok: false; degradation: LspDegradation }
  > {
    let child: ChildProcess;
    const spawnFn = options.spawnFn ?? spawn;
    try {
      child = spawnFn(options.launchSpec.command, [...options.launchSpec.args], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        // The server inherits our cwd so relative rootUri paths resolve.
        cwd: process.cwd(),
      });
    } catch {
      return {
        ok: false,
        degradation: lspDegradation(
          "server_missing",
          `failed to spawn ${options.launchSpec.command}`,
        ),
      };
    }

    // If spawn emitted 'error' synchronously (ENOENT), treat as missing.
    // We detect this by checking if the child has already exited.
    if (child.exitCode !== null && child.exitCode !== undefined) {
      return {
        ok: false,
        degradation: lspDegradation("server_missing"),
      };
    }

    const client = new LspClient(child, options.rootUri, options.timeoutMs);

    // If the spawn errored asynchronously (ENOENT fires as 'error' event),
    // the client.crashed flag is set by onChildError. Check after wiring.
    if (client.crashed) {
      return {
        ok: false,
        degradation: lspDegradation("server_missing"),
      };
    }

    // ── initialize handshake ──
    const initParams: LspInitializeParams = {
      processId: process.pid,
      rootUri: options.rootUri,
      capabilities: {},
    };
    const initResult = await client.request("initialize", initParams);
    if (!initResult.ok) {
      // Remap request_timeout → handshake_timeout (the timeout happened
      // during the initialize handshake). protocol_error, server_crashed,
      // and server_missing pass through with their original codes — they
      // describe the specific failure precisely enough.
      await client.dispose();
      const code =
        initResult.degradation.code === "request_timeout"
          ? "handshake_timeout"
          : initResult.degradation.code;
      return {
        ok: false,
        degradation: lspDegradation(code, initResult.degradation.detail),
      };
    }

    if (initResult.value === null || typeof initResult.value !== "object") {
      await client.dispose();
      return {
        ok: false,
        degradation: lspDegradation("protocol_error", "initialize response missing or invalid"),
      };
    }
    const initResponse = initResult.value as LspInitializeResult;
    client.serverCapabilities = initResponse.capabilities;

    // initialized notification (no response expected).
    client.notify("initialized", {});

    return { ok: true, client };
  }

  /**
   * Send `textDocument/didOpen` — notifies the server about an open
   * document with its full content. No response expected.
   */
  didOpen(item: LspTextDocumentItem): void {
    this.notify("textDocument/didOpen", { textDocument: item });
  }

  /**
   * Send `textDocument/definition` for a position in a document. Returns
   * the definition locations (may be empty, a single location, or an
   * array). Degrades on timeout/error/crash — never throws.
   */
  async definition(
    params: LspTextDocumentPositionParams,
  ): Promise<LspResult<{ locations: LspLocation[] }>> {
    if (this.disposed || this.crashed) {
      return {
        ok: false,
        degradation: lspDegradation("server_crashed"),
      };
    }
    const result = await this.request("textDocument/definition", params);
    if (!result.ok) {
      return result;
    }
    // LSP allows Location | Location[] | null for definition.
    const value = result.value;
    let locations: LspLocation[];
    if (value === null || value === undefined) {
      locations = [];
    } else if (Array.isArray(value)) {
      locations = value as LspLocation[];
    } else {
      locations = [value as LspLocation];
    }
    return { ok: true, locations };
  }

  /**
   * Send `shutdown`, then `exit`, then SIGKILL if the process lingers.
   * Idempotent — safe to call multiple times. After dispose, no child
   * process remains (tested — zombie cleanup).
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // Reject all pending requests immediately.
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(lspDegradation("server_crashed"));
      this.pending.delete(id);
    }

    // Try graceful shutdown: send shutdown request, then exit notification.
    if (!this.crashed && this.child.stdin && !this.child.stdin.destroyed) {
      try {
        const promise = new Promise<void>((resolve) => {
          // Send shutdown — don't wait for a response longer than the timeout.
          this.child.stdin?.write(encodeLspFrame({ jsonrpc: "2.0", id: 0, method: "shutdown" }));
          this.child.stdin?.write(encodeLspFrame({ jsonrpc: "2.0", method: "exit" }));
          // Give the server a brief window to exit cleanly.
          const timer = setTimeout(resolve, 500);
          this.child.on("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        await promise;
      } catch {
        // Best-effort — if writing fails, hard-kill below.
      }
    }

    // Hard kill — ensures no zombie survives even if graceful exit failed.
    this.hardKill();
  }

  /** Returns the pid of the child process (for zombie-cleanup tests). */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** True if the server reported definitionProvider capability. */
  get supportsDefinition(): boolean {
    const caps = this.serverCapabilities;
    return caps !== null && Boolean(caps.definitionProvider);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internal — JSON-RPC request/notification machinery
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Send a request and await its response. Returns the `result` field
   * on success, or a degradation on timeout/error/crash/protocol-error.
   */
  private request(method: string, params: unknown): Promise<
    | { ok: true; value: unknown }
    | { ok: false; degradation: LspDegradation }
  > {
    if (this.disposed || this.crashed) {
      return Promise.resolve({
        ok: false,
        degradation: lspDegradation("server_crashed"),
      });
    }
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          entry.reject(lspDegradation("request_timeout", `method=${method}`));
        }
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const frame = encodeLspFrame(message);
        if (!this.child.stdin || this.child.stdin.destroyed) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(lspDegradation("server_crashed"));
          return;
        }
        this.child.stdin.write(frame);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(lspDegradation("server_crashed"));
      }
    });

    return promise.then(
      (value: unknown) => ({ ok: true as const, value }),
      (degradation: LspDegradation) => ({ ok: false as const, degradation }),
    );
  }

  /**
   * Send a notification (no response expected). Best-effort — if the
   * write fails, the next request will surface the crash.
   */
  private notify(method: string, params: unknown): void {
    if (this.disposed || this.crashed) return;
    try {
      const message: JsonRpcRequest = { jsonrpc: "2.0", method, params };
      this.child.stdin?.write(encodeLspFrame(message));
    } catch {
      // Best-effort — notifications have no response path.
    }
  }

  /**
   * Dispatch a decoded JSON-RPC message. Correlates responses to pending
   * requests by id; ignores server-initiated notifications (we don't
   * need them for the resolution pass).
   */
  /**
   * Dispatch a decoded JSON-RPC message. Correlates responses to pending
   * requests by id; ignores server-initiated notifications.
   */
  private dispatchMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) return;
    const rpc = msg as Record<string, unknown>;
    if (rpc.id === undefined || (rpc.result === undefined && rpc.error === undefined)) {
      return;
    }
    const id = typeof rpc.id === "number" ? rpc.id : Number(rpc.id);
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    if (rpc.error !== undefined) {
      // Don't echo raw server error text — it may contain absolute paths.
      entry.reject(lspDegradation("request_error", "server returned an error response"));
    } else {
      entry.resolve(rpc.result);
    }
  }

  /**
   * stdout data handler — feed the decoder, dispatch complete messages,
   * detect protocol errors.
   */
  private onStdoutData(chunk: Buffer | string): void {
    const result = this.decoder.feed(chunk);
    if (!result.ok) {
      this.handleProtocolError(result.error.detail);
      return;
    }
    for (const msg of result.messages) {
      this.dispatchMessage(msg);
    }
  }

  /**
   * Handle an unexpected child exit. All pending requests are rejected
   * with server_crashed.
   */
  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    // Normal exit during dispose — don't mark as crashed.
    if (this.disposed) return;
    this.crashed = true;
    const detail =
      code !== null ? `server exited with code ${code}` : `server killed by ${signal}`;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(lspDegradation("server_crashed", detail));
      this.pending.delete(id);
    }
  }

  /**
   * Handle a spawn error (ENOENT etc). Marks the server as missing.
   */
  private onChildError(err: Error): void {
    // ENOENT = binary not found.
    this.crashed = true;
    const detail = err.message.includes("ENOENT") ? undefined : "spawn error";
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(lspDegradation("server_missing", detail));
      this.pending.delete(id);
    }
  }

  /**
   * Protocol error — the stream produced a malformed frame. Reject all
   * pending and mark disposed so no further requests can be sent.
   */
  private handleProtocolError(detail: string): void {
    this.crashed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(lspDegradation("protocol_error", detail));
      this.pending.delete(id);
    }
  }

  /**
   * Hard-kill the child process: SIGKILL. Called by dispose() as a
   * final cleanup guarantee. Also called if the graceful shutdown path
   * fails. Uses `kill` which is a no-op if the process already exited.
   */
  private hardKill(): void {
    try {
      if (this.child.pid !== undefined && !this.child.killed) {
        this.child.kill("SIGKILL");
      }
    } catch {
      // Best-effort — the process may have already exited.
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// URI helpers — convert between file paths and LSP URIs.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Convert a repo-relative or absolute file path to a `file://` URI.
 * Handles Windows drive letters (C:\ → file:///C:/).
 */
export function pathToUri(filePath: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  // On Windows, prepend / before the drive letter.
  return `file://${abs.replace(/\\/g, "/")}`;
}

/**
 * Convert a `file://` URI back to an absolute file path.
 */
export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    let rest = uri.slice("file://".length);
    // Decode percent-encoded characters (e.g. %20 → space) per RFC 8089.
    try {
      rest = decodeURIComponent(rest);
    } catch {
      // Malformed escape sequence — keep raw path (best-effort).
    }
    // Windows: file:///C:/foo → C:/foo
    if (/^\/[A-Za-z]:/.test(rest)) {
      return rest.slice(1).replace(/\//g, path.sep);
    }
    // Unix: file:///foo → /foo
    return rest.replace(/\//g, path.sep);
  }
  return uri;
}
