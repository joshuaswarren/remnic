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
export const SUPPORT_PASSPORT_MODEL_ACK_PATH = "/engram/v1/support-passport/internal/model/jobs/ack";
export const SUPPORT_PASSPORT_MODEL_RESULT_PATH = "/engram/v1/support-passport/internal/model/jobs/result";

const CONSUMER_HANDOFF_GRACE_MS = 1_000;

const ModelMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().max(120_000),
  })
  .strict();

const ModelJobSchema = z
  .object({
    id: z.string().uuid(),
    claimId: z.string().uuid().optional(),
    messages: z.array(ModelMessageSchema).min(1).max(8),
    temperature: z.number().finite().min(0).max(2),
    maxTokens: z.number().int().min(1).max(32_000),
    timeoutMs: z.number().int().min(1).max(120_000),
    claimAckTimeoutMs: z.number().int().min(1).max(120_000).optional(),
    executionLeaseTimeoutMs: z.number().int().min(1).max(120_000).optional(),
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
    claimId: z.string().uuid().optional(),
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

const ModelClaimSchema = z
  .object({
    id: z.string().uuid(),
    claimId: z.string().uuid(),
  })
  .strict();

interface PendingJob {
  job: SupportPassportModelJob;
  deadlineAt: number;
  claimId?: string;
  claimTimer?: ReturnType<typeof setTimeout>;
  resolve: (result: SupportPassportModelRouteResult | null) => void;
  requeue(): void;
}

interface PendingWaiter {
  claimLease: boolean;
  resolve(job: SupportPassportModelJob | null): void;
}

export interface SupportPassportModelBridgeOptions {
  maxPendingJobs?: number;
  claimAckTimeoutMs?: number;
  executionLeaseTimeoutMs?: number;
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
  private readonly claimAckTimeoutMs: number;
  private readonly executionLeaseTimeoutMs: number;
  private readonly pending = new Map<string, PendingJob>();
  private readonly available: string[] = [];
  private readonly waiters: PendingWaiter[] = [];
  private readonly claimed = new Set<string>();
  private lastConsumerPollAt = 0;
  private closed = false;

  constructor(options: SupportPassportModelBridgeOptions = {}) {
    this.maxPendingJobs = options.maxPendingJobs ?? 32;
    this.claimAckTimeoutMs = options.claimAckTimeoutMs ?? 5_000;
    this.executionLeaseTimeoutMs = options.executionLeaseTimeoutMs ?? 15_000;
    if (!Number.isInteger(this.maxPendingJobs) || this.maxPendingJobs < 1) {
      throw new Error("maxPendingJobs must be a positive integer");
    }
    if (!Number.isInteger(this.claimAckTimeoutMs) || this.claimAckTimeoutMs < 1) {
      throw new Error("claimAckTimeoutMs must be a positive integer");
    }
    if (
      !Number.isInteger(this.executionLeaseTimeoutMs) ||
      this.executionLeaseTimeoutMs < 1 ||
      this.executionLeaseTimeoutMs > 120_000
    ) {
      throw new Error("executionLeaseTimeoutMs must be an integer from 1 through 120000");
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
    for (const waiter of this.waiters.splice(0)) waiter.resolve(null);
  }

  private invoke(
    messages: SupportPassportModelMessage[],
    options: Parameters<SupportPassportModelRoute["invoke"]>[1]
  ): Promise<SupportPassportModelRouteResult | null> {
    const consumerAvailable =
      this.waiters.length > 0 ||
      this.claimed.size > 0 ||
      Date.now() - this.lastConsumerPollAt <= CONSUMER_HANDOFF_GRACE_MS;
    if (!consumerAvailable || this.closed || this.pending.size >= this.maxPendingJobs || options.signal?.aborted) {
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
        const pending = this.pending.get(parsed.data.id);
        if (pending?.claimTimer) clearTimeout(pending.claimTimer);
        this.pending.delete(parsed.data.id);
        this.claimed.delete(parsed.data.id);
        const availableIndex = this.available.indexOf(parsed.data.id);
        if (availableIndex >= 0) this.available.splice(availableIndex, 1);
        options.signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = (): void => settle(null);
      const requeue = (): void => {
        const pending = this.pending.get(parsed.data.id);
        if (!pending || !this.claimed.delete(parsed.data.id)) return;
        if (pending.claimTimer) clearTimeout(pending.claimTimer);
        pending.claimTimer = undefined;
        pending.claimId = undefined;
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter.resolve(this.claimPending(pending, waiter.claimLease));
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
        const pending = this.pending.get(parsed.data.id);
        waiter.resolve(pending ? this.claimPending(pending, waiter.claimLease) : null);
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

  private claimPending(pending: PendingJob, claimLease: boolean): SupportPassportModelJob | null {
    const job = this.claimedJob(pending.job);
    if (!job) return null;
    this.claimed.add(job.id);
    if (!claimLease) return job;
    const claimAckTimeoutMs = Math.min(this.claimAckTimeoutMs, job.timeoutMs);
    const executionLeaseTimeoutMs = Math.min(this.executionLeaseTimeoutMs, job.timeoutMs);
    pending.claimId = randomUUID();
    this.armClaimTimer(pending, claimAckTimeoutMs);
    return { ...job, claimId: pending.claimId, claimAckTimeoutMs, executionLeaseTimeoutMs };
  }

  private armClaimTimer(pending: PendingJob, timeoutMs: number): void {
    if (pending.claimTimer) clearTimeout(pending.claimTimer);
    pending.claimTimer = setTimeout(() => pending.requeue(), timeoutMs);
    pending.claimTimer.unref?.();
  }

  private takeAvailable(claimLease: boolean): SupportPassportModelJob | null {
    for (;;) {
      const id = this.available.shift();
      if (!id) return null;
      const pending = this.pending.get(id);
      if (pending) {
        return this.claimPending(pending, claimLease);
      }
    }
  }

  private nextJob(
    timeoutMs: number,
    signal: AbortSignal,
    claimLease: boolean
  ): Promise<SupportPassportModelJob | null> {
    const available = this.takeAvailable(claimLease);
    if (available || this.closed || signal.aborted || timeoutMs === 0 || this.waiters.length >= this.maxPendingJobs) {
      return Promise.resolve(available);
    }
    return new Promise((resolve) => {
      let active = true;
      let waiter: PendingWaiter;
      const done = (job: SupportPassportModelJob | null): void => {
        if (!active) return;
        active = false;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        resolve(job);
      };
      const abort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        done(null);
      };
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        done(null);
      }, timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      waiter = { claimLease, resolve: done };
      this.waiters.push(waiter);
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
      (pathname === SUPPORT_PASSPORT_MODEL_JOB_PATH ||
        pathname === SUPPORT_PASSPORT_MODEL_ACK_PATH ||
        pathname === SUPPORT_PASSPORT_MODEL_RESULT_PATH);
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
      let claimLease = false;
      try {
        const parsed = z
          .object({
            timeoutMs: z.number().int().min(0).max(25_000),
            claimLease: z.boolean().optional(),
          })
          .strict()
          .parse(await readJson(req, 1_024));
        timeoutMs = parsed.timeoutMs;
        claimLease = parsed.claimLease === true;
      } catch {
        respondJson(res, 400, { error: "invalid_request", code: "invalid_request" });
        return true;
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      req.once("aborted", abort);
      res.once("close", abort);
      const job = await this.nextJob(timeoutMs, controller.signal, claimLease);
      req.off("aborted", abort);
      res.off("close", abort);
      if (res.destroyed) {
        if (job) this.pending.get(job.id)?.requeue();
        return true;
      }
      this.lastConsumerPollAt = Date.now();
      if (job) respondJson(res, 200, job);
      else respondNoContent(res);
      return true;
    }
    if (pathname === SUPPORT_PASSPORT_MODEL_ACK_PATH) {
      try {
        const parsed = ModelClaimSchema.parse(await readJson(req, 1_024));
        const pending = this.pending.get(parsed.id);
        if (!pending || !this.claimed.has(parsed.id) || pending.claimId !== parsed.claimId) {
          respondJson(res, 404, { error: "job_not_found", code: "job_not_found" });
          return true;
        }
        const remainingMs = pending.deadlineAt - Date.now();
        if (remainingMs <= 0) {
          pending.resolve(null);
          respondJson(res, 404, { error: "job_not_found", code: "job_not_found" });
          return true;
        }
        this.armClaimTimer(pending, Math.min(this.executionLeaseTimeoutMs, remainingMs));
        respondNoContent(res);
      } catch {
        respondJson(res, 400, { error: "invalid_request", code: "invalid_request" });
      }
      return true;
    }
    try {
      const parsed = ModelResultSchema.parse(await readJson(req, 300_000));
      const pending = this.pending.get(parsed.id);
      if (
        !pending ||
        !this.claimed.has(parsed.id) ||
        (pending.claimId !== undefined && pending.claimId !== parsed.claimId)
      ) {
        respondJson(res, 404, { error: "job_not_found", code: "job_not_found" });
        return true;
      }
      this.lastConsumerPollAt = Date.now();
      pending.resolve(parsed.result);
      respondNoContent(res);
    } catch {
      respondJson(res, 400, { error: "invalid_request", code: "invalid_request" });
    }
    return true;
  }
}
