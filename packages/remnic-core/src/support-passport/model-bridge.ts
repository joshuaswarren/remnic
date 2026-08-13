import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import type {
  SupportPassportModelMessage,
  SupportPassportModelRoute,
  SupportPassportModelRouteResult,
} from "./model-adapter.js";
import type { SupportPassportExternalRequestHandler } from "./public-http.js";

export const SUPPORT_PASSPORT_MODEL_JOB_PATH = "/engram/v1/support-passport/internal/model/jobs/next";
export const SUPPORT_PASSPORT_MODEL_RESULT_PATH = "/engram/v1/support-passport/internal/model/jobs/result";

const ModelMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().max(120_000),
  })
  .strict();

const ModelJobSchema = z
  .object({
    id: z.string().uuid(),
    messages: z.array(ModelMessageSchema).min(1).max(8),
    temperature: z.number().finite().min(0).max(2),
    maxTokens: z.number().int().min(1).max(32_000),
    timeoutMs: z.number().int().min(1).max(120_000),
    operation: z.enum(["support-passport-draft", "support-passport-answer"]),
    jsonSchema: z
      .object({
        name: z.string().min(1).max(128),
        schema: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();

export type SupportPassportModelJob = z.infer<typeof ModelJobSchema>;

export function parseSupportPassportModelJob(value: unknown): SupportPassportModelJob | undefined {
  const parsed = ModelJobSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const ModelResultSchema = z
  .object({
    id: z.string().uuid(),
    result: z
      .object({
        content: z.string().max(250_000),
        modelUsed: z.string().min(1).max(512),
        usage: z
          .object({
            inputTokens: z.number().int().nonnegative().optional(),
            outputTokens: z.number().int().nonnegative().optional(),
            totalTokens: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();

interface PendingJob {
  job: SupportPassportModelJob;
  deadlineAt: number;
  resolve: (result: SupportPassportModelRouteResult | null) => void;
  requeue(): void;
}

export interface SupportPassportModelBridgeOptions {
  maxPendingJobs?: number;
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(Buffer.byteLength(body)));
  res.end(body);
}

function respondNoContent(res: ServerResponse): void {
  res.statusCode = 204;
  res.setHeader("cache-control", "no-store");
  res.end();
}

function requestPath(req: IncomingMessage): string | undefined {
  try {
    return new URL(req.url ?? "/", "http://placeholder").pathname;
  } catch {
    return undefined;
  }
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

/**
 * In-memory transport between a standalone Remnic daemon and its OpenClaw
 * delegate. The transport carries provider-neutral model jobs only.
 */
export class SupportPassportModelBridge {
  readonly route: SupportPassportModelRoute;
  readonly requestHandler: SupportPassportExternalRequestHandler;

  private readonly maxPendingJobs: number;
  private readonly pending = new Map<string, PendingJob>();
  private readonly available: string[] = [];
  private readonly waiters: Array<(job: SupportPassportModelJob | null) => void> = [];
  private readonly claimed = new Set<string>();
  private closed = false;

  constructor(options: SupportPassportModelBridgeOptions = {}) {
    this.maxPendingJobs = options.maxPendingJobs ?? 32;
    if (!Number.isInteger(this.maxPendingJobs) || this.maxPendingJobs < 1) {
      throw new Error("maxPendingJobs must be a positive integer");
    }
    this.route = {
      kind: "gateway",
      invoke: (messages, invokeOptions) => this.invoke(messages, invokeOptions),
    };
    this.requestHandler = (req, res, ctx) => this.handleRequest(req, res, ctx.authorized, ctx.tokenAuthorized);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.resolve(null);
    this.pending.clear();
    this.available.length = 0;
    this.claimed.clear();
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  private invoke(
    messages: SupportPassportModelMessage[],
    options: Parameters<SupportPassportModelRoute["invoke"]>[1]
  ): Promise<SupportPassportModelRouteResult | null> {
    if (this.closed || this.pending.size >= this.maxPendingJobs || options.signal?.aborted) {
      return Promise.resolve(null);
    }
    const parsed = ModelJobSchema.safeParse({
      id: randomUUID(),
      messages,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
      operation: options.operation,
      jsonSchema: options.jsonSchema,
    });
    if (!parsed.success) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const deadlineAt = Date.now() + parsed.data.timeoutMs;
      const timeout = setTimeout(() => settle(null), parsed.data.timeoutMs);
      const settle = (result: SupportPassportModelRouteResult | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.pending.delete(parsed.data.id);
        this.claimed.delete(parsed.data.id);
        const availableIndex = this.available.indexOf(parsed.data.id);
        if (availableIndex >= 0) this.available.splice(availableIndex, 1);
        options.signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = (): void => settle(null);
      const requeue = (): void => {
        if (!this.pending.has(parsed.data.id) || !this.claimed.delete(parsed.data.id)) return;
        const waiter = this.waiters.shift();
        if (waiter) {
          this.claimed.add(parsed.data.id);
          waiter(this.claimedJob(parsed.data));
        } else {
          this.available.push(parsed.data.id);
        }
      };
      this.pending.set(parsed.data.id, {
        job: parsed.data,
        deadlineAt,
        resolve: settle,
        requeue,
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      const waiter = this.waiters.shift();
      if (waiter) {
        this.claimed.add(parsed.data.id);
        waiter(this.claimedJob(parsed.data));
      } else this.available.push(parsed.data.id);
    });
  }

  private claimedJob(job: SupportPassportModelJob): SupportPassportModelJob | null {
    const pending = this.pending.get(job.id);
    if (!pending) return null;
    const remainingMs = pending.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      pending.resolve(null);
      return null;
    }
    return { ...job, timeoutMs: remainingMs };
  }

  private takeAvailable(): SupportPassportModelJob | null {
    for (;;) {
      const id = this.available.shift();
      if (!id) return null;
      const pending = this.pending.get(id);
      if (pending) {
        this.claimed.add(id);
        return this.claimedJob(pending.job);
      }
    }
  }

  private nextJob(timeoutMs: number, signal: AbortSignal): Promise<SupportPassportModelJob | null> {
    const available = this.takeAvailable();
    if (available || this.closed || signal.aborted || timeoutMs === 0 || this.waiters.length >= this.maxPendingJobs) {
      return Promise.resolve(available);
    }
    return new Promise((resolve) => {
      let active = true;
      const done = (job: SupportPassportModelJob | null): void => {
        if (!active) return;
        active = false;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        resolve(job);
      };
      const abort = (): void => {
        const index = this.waiters.indexOf(done);
        if (index >= 0) this.waiters.splice(index, 1);
        done(null);
      };
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(done);
        if (index >= 0) this.waiters.splice(index, 1);
        done(null);
      }, timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.push(done);
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    authorized: boolean,
    tokenAuthorized: boolean
  ): Promise<boolean> {
    const pathname = requestPath(req);
    const owned =
      req.method === "POST" &&
      (pathname === SUPPORT_PASSPORT_MODEL_JOB_PATH || pathname === SUPPORT_PASSPORT_MODEL_RESULT_PATH);
    if (!owned) return false;
    if (!tokenAuthorized) {
      res.setHeader("www-authenticate", "Bearer");
      respondJson(res, 401, { error: "unauthorized", code: "unauthorized" });
      return true;
    }
    if (!authorized) {
      respondJson(res, 403, { error: "forbidden", code: "forbidden" });
      return true;
    }
    if (pathname === SUPPORT_PASSPORT_MODEL_JOB_PATH) {
      let timeoutMs = 20_000;
      try {
        const parsed = z
          .object({ timeoutMs: z.number().int().min(0).max(25_000) })
          .strict()
          .parse(await readJson(req, 1_024));
        timeoutMs = parsed.timeoutMs;
      } catch {
        respondJson(res, 400, { error: "invalid_request", code: "invalid_request" });
        return true;
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      req.once("aborted", abort);
      res.once("close", abort);
      const job = await this.nextJob(timeoutMs, controller.signal);
      req.off("aborted", abort);
      res.off("close", abort);
      if (res.destroyed) {
        if (job) this.pending.get(job.id)?.requeue();
        return true;
      }
      if (job) respondJson(res, 200, job);
      else respondNoContent(res);
      return true;
    }
    try {
      const parsed = ModelResultSchema.parse(await readJson(req, 300_000));
      const pending = this.pending.get(parsed.id);
      if (!pending || !this.claimed.has(parsed.id)) {
        respondJson(res, 404, { error: "job_not_found", code: "job_not_found" });
        return true;
      }
      pending.resolve(parsed.result);
      respondNoContent(res);
    } catch {
      respondJson(res, 400, { error: "invalid_request", code: "invalid_request" });
    }
    return true;
  }
}
