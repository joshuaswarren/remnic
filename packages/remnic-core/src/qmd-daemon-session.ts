import { abortError, throwIfAborted } from "./abort-error.js";
import { log } from "./logger.js";
import { type CommandChildProcess, launchProcess } from "./runtime/child-process.js";
import { mergeEnv } from "./runtime/env.js";
import { sleep } from "./utils/sleep.js";

export type QmdRuntimeEnv = Record<string, string | undefined>;

export type QmdDaemonSpawn = (
  command: string,
  args: string[],
  options?: Record<string, unknown>
) => CommandChildProcess;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
};

let nextJsonRpcId = 1;

function sanitizeForLog(value: string, max = 200): string {
  let out = "";
  const cap = Math.min(value.length, max);
  for (let i = 0; i < cap; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x1b && value.charCodeAt(i + 1) === 0x5b) {
      i += 2;
      while (i < cap) {
        const next = value.charCodeAt(i);
        const isLetter = (next >= 65 && next <= 90) || (next >= 97 && next <= 122);
        if (isLetter) break;
        i += 1;
      }
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue;
    out += value[i] ?? "";
  }
  if (value.length > max) return `${out}…(truncated)`;
  return out;
}

function isTimeoutMessage(message: string): boolean {
  return message.toLowerCase().includes("timed out");
}

export class QmdDaemonSession {
  private child: CommandChildProcess | null = null;
  private initialized = false;
  private buffer = "";
  private startPromise: Promise<boolean> | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private readonly qmdPath: string;
  private readonly runtimeEnv: QmdRuntimeEnv;
  private readonly indexName?: string;
  private readonly spawn: QmdDaemonSpawn;

  constructor(
    qmdPath: string,
    runtimeEnv: QmdRuntimeEnv = {},
    indexName?: string,
    spawn: QmdDaemonSpawn = launchProcess
  ) {
    this.qmdPath = qmdPath;
    this.runtimeEnv = runtimeEnv;
    this.indexName = indexName?.trim() || undefined;
    this.spawn = spawn;
  }

  async start(): Promise<boolean> {
    if (this.child && !this.child.killed && this.initialized) {
      return true;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = (async () => {
      const processAlreadyRunning = this.child != null && !this.child.killed;
      if (!processAlreadyRunning) {
        if (this.child) {
          this.cleanup({ killChild: true });
        }
        try {
          const args = this.indexName ? ["--index", this.indexName, "mcp"] : ["mcp"];
          const child = this.spawn(this.qmdPath, args, {
            env: mergeEnv({ NO_COLOR: "1", ...this.runtimeEnv }),
            stdio: ["pipe", "pipe", "pipe"],
          });
          this.child = child;
          this.buffer = "";

          child.stdout?.on("data", (data: Buffer) => {
            if (this.child !== child) return;
            this.handleStdoutData(data);
          });
          child.stderr?.on("data", (data: Buffer) => {
            if (this.child !== child) return;
            const msg = data.toString().trim();
            if (msg) log.debug(`QMD mcp stderr: ${sanitizeForLog(msg)}`);
          });
          child.stdin?.on("error", (err) => {
            log.debug(`QMD mcp stdin error (suppressed): ${err.message}`);
          });
          child.on("error", (err) => {
            if (this.child !== child) return;
            log.debug(`QMD mcp process error: ${err.message}`);
            this.cleanup({ child });
          });
          child.on("close", (code) => {
            if (this.child !== child) return;
            log.debug(`QMD mcp process exited (code ${code})`);
            this.cleanup({ child });
          });
        } catch (err) {
          log.debug(`QMD mcp: failed to spawn process: ${err}`);
          this.cleanup({ killChild: true });
          return false;
        }
      } else {
        log.debug("QMD mcp: process already running, retrying handshake");
      }

      try {
        const result = await this.sendRequest(
          "initialize",
          {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "openclaw-remnic", version: "1.0.0" },
          },
          60_000
        );
        if (!result) {
          this.cleanup({ killChild: true });
          return false;
        }
        this.sendNotification("notifications/initialized");
        this.initialized = true;
        log.info("QMD mcp: stdio session initialized");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isTimeoutMessage(msg)) {
          log.debug("QMD mcp: handshake timed out — process still loading, will retry later");
          this.initialized = false;
        } else {
          log.debug(`QMD mcp: failed to start stdio session: ${err}`);
          this.cleanup({ killChild: true });
        }
        return false;
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (!this.child || this.child.killed || !this.initialized) {
      throw new Error("QMD mcp process not running");
    }
    return this.sendRequest("tools/call", { name, arguments: args }, timeoutMs, signal);
  }

  invalidate(): void {
    this.cleanup({ killChild: true });
  }

  async close(timeoutMs = 1_000): Promise<void> {
    const target = this.child;
    if (!target) {
      this.cleanup({ killChild: true });
      return;
    }

    let closed = false;
    const closedPromise = new Promise<void>((resolve) => {
      target.once("close", () => {
        closed = true;
        resolve();
      });
    });

    this.cleanup({ killChild: true });
    await Promise.race([closedPromise, sleep(timeoutMs)]);
    if (!closed) {
      try {
        target.kill("SIGKILL");
      } catch {
        // Ignore process-kill races during shutdown.
      }
      await Promise.race([closedPromise, sleep(250)]);
    }
  }

  isActive(): boolean {
    return this.child !== null && !this.child.killed && this.initialized;
  }

  isLoading(): boolean {
    return this.child !== null && !this.child.killed && !this.initialized;
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      throwIfAborted(signal, `QMD mcp ${method} aborted before request`);
      if (!this.child || !this.child.stdin || this.child.killed) {
        reject(new Error("QMD mcp process not available"));
        return;
      }

      const id = nextJsonRpcId++;
      let written = false;
      const abandon = (reason: string) => {
        if (!written || method !== "tools/call") return;
        this.sendNotification("notifications/cancelled", { requestId: id, reason });
      };
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        cleanup();
        const reason = `QMD mcp ${method} timed out after ${timeoutMs}ms`;
        abandon(reason);
        reject(new Error(reason));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        cleanup();
        abandon("client aborted");
        reject(abortError(`QMD mcp ${method} aborted`));
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };

      this.pendingRequests.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", onAbort, { once: true });
      const message = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      try {
        this.child.stdin.write(message, (err) => {
          if (!err) return;
          written = false;
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          cleanup();
          reject(new Error(`Failed to write to QMD mcp stdin: ${err.message}`));
        });
        written = true;
      } catch (err) {
        written = false;
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        cleanup();
        const messageText = err instanceof Error ? err.message : String(err);
        reject(new Error(`Failed to write to QMD mcp stdin: ${messageText}`));
      }
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin || this.child.killed) return;
    if (this.child.stdin.destroyed) return;
    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params) msg.params = params;
    try {
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // Ignore EPIPE / write-after-close
    }
  }

  private handleStdoutData(data: Buffer | string): void {
    this.buffer += data.toString();
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.handleMessage(msg);
      } catch {
        log.debug(`QMD mcp: unparseable stdout: ${sanitizeForLog(line, 200)}`);
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pendingRequests.get(msg.id as number);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id as number);
        pending.cleanup();
        if (msg.error) {
          pending.reject(new Error(JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }
    if (msg.method) {
      log.debug(`QMD mcp notification: ${msg.method}`);
    }
  }

  private cleanup(opts?: { killChild?: boolean; child?: CommandChildProcess | null }): void {
    const target = opts?.child ?? this.child;
    if (!target) return;
    if (opts?.child && this.child !== opts.child) {
      return;
    }
    if (opts?.killChild && !target.killed) {
      target.kill("SIGTERM");
    }
    this.initialized = false;
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(new Error("QMD mcp process terminated"));
    }
    this.pendingRequests.clear();
    this.startPromise = null;
    this.child = null;
    this.buffer = "";
  }
}
