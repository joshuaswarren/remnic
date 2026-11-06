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

/**
 * Drop C0 controls and one ANSI CSI sequence. Char scan on purpose:
 * the regex-safety ratchet flags new regular expressions on changed lines.
 */
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

/** Post-handshake capability probe budget; tools/list is metadata-only. */
const QMD_TOOLS_LIST_TIMEOUT_MS = 1_000;


/** Number of bounded retries after a tools/list timeout. */
const QMD_CAPABILITY_MAX_RETRIES = 2;
const QMD_CAPABILITY_RETRY_DELAY_MS = 500;
const QMD_CAPABILITY_REPROBE_COOLDOWN_MS = 2_000;

/**
 * Return true for a validated support schema, false for a valid old schema,
 * and null for malformed or incomplete tools/list data.
 */
function parseAdditionalSearchesCapability(result: unknown): boolean | null {
  if (!result || typeof result !== "object" || !("tools" in result) || !Array.isArray(result.tools)) return null;
  const queryTool = result.tools.find(
    (tool: unknown) =>
      tool && typeof tool === "object" && "name" in tool && tool.name === "query" && "inputSchema" in tool
  );
  if (!queryTool || typeof queryTool !== "object" || !("inputSchema" in queryTool)) return null;
  const schema: unknown = queryTool.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || !("type" in schema) || schema.type !== "object" || !("properties" in schema)) return null;
  const properties: unknown = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  if (!("additionalSearches" in properties)) return false;
  if (!("query" in properties)) return null;
  const query: unknown = properties.query;
  if (!query || typeof query !== "object" || !("type" in query) || query.type !== "string") return null;
  const additionalSearches: unknown = properties.additionalSearches;
  if (!additionalSearches || typeof additionalSearches !== "object" || Array.isArray(additionalSearches)) return null;
  if (!("type" in additionalSearches) || additionalSearches.type !== "array" || !("items" in additionalSearches)) return null;
  const items: unknown = additionalSearches.items;
  if (!items || typeof items !== "object" || Array.isArray(items) || !("type" in items) || items.type !== "object" || !("properties" in items)) return null;
  const itemProperties: unknown = items.properties;
  if (!itemProperties || typeof itemProperties !== "object" || Array.isArray(itemProperties)) return null;
  if (!("type" in itemProperties) || !("query" in itemProperties)) return null;
  const searchType: unknown = itemProperties.type;
  const searchQuery: unknown = itemProperties.query;
  if (!searchType || typeof searchType !== "object" || !("type" in searchType) || searchType.type !== "string" || !("enum" in searchType) || !Array.isArray(searchType.enum)) return null;
  if (!["lex", "vec", "hyde"].every((type) => searchType.enum.includes(type))) return null;
  if (!searchQuery || typeof searchQuery !== "object" || !("type" in searchQuery) || searchQuery.type !== "string") return null;
  if (!("maxLength" in searchQuery) || typeof searchQuery.maxLength !== "number" || searchQuery.maxLength < 320) return null;
  return true;
}

/**
 * One `qmd mcp` child and its JSON-RPC session.
 *
 * Aborting or timing out a `tools/call` writes MCP `notifications/cancelled`
 * and rejects the caller immediately. The SDK drops the tool result once the
 * server's request controller is aborted, so this session does not wait for
 * a response after cancel. The initialize handshake is not cancelled: a slow
 * model load is supposed to stay alive for the next probe.
 *
 * The child is not killed on cancel. Reloading the rerank model costs longer
 * than the recall budget, and a slow query would then take the warm process
 * down on every timeout.
 */
export class QmdDaemonSession {
  private child: CommandChildProcess | null = null;
  private initialized = false;
  private additionalSearchesAdvertised = false;
  private capabilityDiscoveryPromise: Promise<void> | null = null;
  private capabilitySchemaResolved = false;
  private lastCapabilityProbeAtMs = 0;
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

  /** Spawn the qmd mcp child process and perform MCP handshake. */
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
        void this.discoverToolCapabilities(this.child);
        if (!this.child || this.child.killed || !this.initialized) return false;
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

  /**
   * Best-effort capability discovery after the handshake: read the real
   * tools/list inputSchema instead of guessing versions. Any failure leaves
   * the capability off so the legacy structured path stays intact.
   */
  private discoverToolCapabilities(child: CommandChildProcess | null): Promise<void> {
    if (!child || this.child !== child || child.killed) return Promise.resolve();
    if (this.capabilityDiscoveryPromise) return this.capabilityDiscoveryPromise;
    const probe = Promise.resolve().then(async () => {
      this.lastCapabilityProbeAtMs = Date.now();
      try {
        const result = await this.sendRequest("tools/list", {}, QMD_TOOLS_LIST_TIMEOUT_MS);
        if (this.child !== child) return;
        const capability = parseAdditionalSearchesCapability(result);
        this.capabilitySchemaResolved = capability !== null;
        this.additionalSearchesAdvertised = capability === true;
        this.capabilityRetryCount = 0;
      } catch (err) {
        if (this.child !== child) return;
        const message = err instanceof Error ? err.message : String(err);
        log.debug(`QMD mcp: tools/list capability probe failed, using legacy searches: ${message}`);
        if (isTimeoutMessage(message)) this.scheduleCapabilityRetry(child);
      }
    });
    this.capabilityDiscoveryPromise = probe;
    void probe.finally(() => {
      if (this.capabilityDiscoveryPromise === probe) this.capabilityDiscoveryPromise = null;
    });
    return probe;
  }

  private scheduleCapabilityRetry(child: CommandChildProcess): void {
    if (this.capabilityRetryCount >= QMD_CAPABILITY_MAX_RETRIES || this.capabilityRetryTimer) return;
    this.capabilityRetryCount += 1;
    this.capabilityRetryTimer = setTimeout(() => {
      this.capabilityRetryTimer = null;
      if (this.child === child && this.initialized && !child.killed) {
        void this.discoverToolCapabilities(child);
      }
    }, QMD_CAPABILITY_RETRY_DELAY_MS);
  }

  /** Start a best-effort, rate-limited capability probe without delaying search. */
  probeAdditionalSearchesIfDue(): void {
    const child = this.child;
    if (!child || child.killed || !this.initialized || this.additionalSearchesAdvertised || this.capabilitySchemaResolved) return;
    if (this.capabilityDiscoveryPromise || this.capabilityRetryTimer) return;
    if (Date.now() - this.lastCapabilityProbeAtMs < QMD_CAPABILITY_REPROBE_COOLDOWN_MS) return;
    this.lastCapabilityProbeAtMs = Date.now();
    void this.discoverToolCapabilities(child);
  }

  /** True while the live child's validated tools/list advertises query.additionalSearches. */
  supportsAdditionalSearches(): boolean {
    return this.additionalSearchesAdvertised;
  }

  /** Call an MCP tool and return the parsed result. */
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

  /** Kill stdio process and clear state so the next probe can restart. */
  invalidate(): void {
    this.cleanup({ killChild: true });
  }

  /** Kill stdio process and wait briefly for the child handle to close. */
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

  /** True while the process is spawned but the MCP handshake has not yet completed. */
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
        // Only a tool call that actually went out can be holding the worker.
        // initialize stays running across a slow model load.
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
    // Re-evaluated on every pass so a blank line cannot leave a stale index.
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
    this.additionalSearchesAdvertised = false;
    this.capabilitySchemaResolved = false;
    this.lastCapabilityProbeAtMs = 0;
    clearTimeout(this.capabilityRetryTimer);
    this.capabilityRetryTimer = null;
    this.capabilityRetryCount = 0;
    this.capabilityDiscoveryPromise = null;
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
