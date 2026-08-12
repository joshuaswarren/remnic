import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

import { abortError, isAbortError } from "../abort-error.js";
import { type OperationName, getOperation } from "../access-boundary.js";
import type { EngramAccessService } from "../access-service.js";
import { SupportPassportError } from "./errors.js";

const PUBLIC_RATE_LIMIT_MAX_KEYS = 20_000;
const PUBLIC_AUTH_MAX_IN_FLIGHT_PER_NETWORK = 8;
const PUBLIC_AUTH_MAX_IN_FLIGHT_TOTAL = 256;

export const SUPPORT_PASSPORT_PUBLIC_HTTP_ROUTES = [
  {
    method: "GET",
    pathname: "/engram/v1/support-passport/public/grants/:id",
    operation: "support_passport_grant_read",
  },
  {
    method: "POST",
    pathname: "/engram/v1/support-passport/public/grants/:id/ask",
    operation: "support_passport_grant_ask",
  },
] as const satisfies ReadonlyArray<{ method: string; pathname: string; operation: OperationName }>;

export type SupportPassportExternalRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { authorized: boolean }
) => Promise<boolean>;

interface WindowEntry {
  count: number;
  resetAt: number;
}

class FixedWindowLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number
  ) {}

  consume(key: string): boolean {
    const now = this.now();
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && this.entries.size >= PUBLIC_RATE_LIMIT_MAX_KEYS) {
        this.prune(now);
        if (this.entries.size >= PUBLIC_RATE_LIMIT_MAX_KEYS) return false;
      }
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }

  allows(key: string): boolean {
    const now = this.now();
    const current = this.entries.get(key);
    if (current && current.resetAt > now) return current.count < this.limit;
    if (!current && this.entries.size >= PUBLIC_RATE_LIMIT_MAX_KEYS) {
      this.prune(now);
      if (this.entries.size >= PUBLIC_RATE_LIMIT_MAX_KEYS) return false;
    }
    return true;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}

class InFlightLimiter {
  private readonly counts = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly perKeyLimit: number,
    private readonly totalLimit: number
  ) {}

  reserve(key: string): (() => void) | undefined {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.perKeyLimit || this.total >= this.totalLimit) return undefined;
    this.counts.set(key, current + 1);
    this.total += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const count = this.counts.get(key) ?? 0;
      if (count <= 1) this.counts.delete(key);
      else this.counts.set(key, count - 1);
      this.total -= 1;
    };
  }
}

interface PublicRateLimits {
  authentications: InFlightLimiter;
  grantReads: FixedWindowLimiter;
  networkReads: FixedWindowLimiter;
  networkReadFailures: FixedWindowLimiter;
  grantQuestions: FixedWindowLimiter;
  networkQuestions: FixedWindowLimiter;
  networkQuestionFailures: FixedWindowLimiter;
}

export interface SupportPassportPublicHandlerOptions {
  now?: () => number;
}

function createRateLimits(now: () => number): PublicRateLimits {
  return {
    authentications: new InFlightLimiter(PUBLIC_AUTH_MAX_IN_FLIGHT_PER_NETWORK, PUBLIC_AUTH_MAX_IN_FLIGHT_TOTAL),
    grantReads: new FixedWindowLimiter(60, 60_000, now),
    networkReads: new FixedWindowLimiter(60, 60_000, now),
    networkReadFailures: new FixedWindowLimiter(60, 60_000, now),
    grantQuestions: new FixedWindowLimiter(20, 10 * 60_000, now),
    networkQuestions: new FixedWindowLimiter(20, 10 * 60_000, now),
    networkQuestionFailures: new FixedWindowLimiter(20, 10 * 60_000, now),
  };
}

function rateLimited(): SupportPassportError {
  return new SupportPassportError("rate_limited", "Too many helper requests.", 429);
}

async function runPublicOperation(
  service: EngramAccessService,
  name: "support_passport_grant_read" | "support_passport_grant_ask",
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  const operation = getOperation(name);
  if (!operation) throw new Error(`access-boundary: operation not registered: ${name}`);
  const output = (await operation.run(input, {
    service,
    ...(signal ? { abortSignal: signal } : {}),
  })) as { result: unknown };
  return output.result;
}

function consumeAuthenticatedLimits(
  networkLimiter: FixedWindowLimiter,
  grantLimiter: FixedWindowLimiter,
  networkKey: string,
  grantId: string
): void {
  if (!networkLimiter.allows(networkKey) || !grantLimiter.allows(grantId)) throw rateLimited();
  if (!networkLimiter.consume(networkKey) || !grantLimiter.consume(grantId)) throw rateLimited();
}

async function readGrantUnderAuthenticationReservation(
  service: EngramAccessService,
  grantId: string,
  secret: string,
  networkKey: string,
  networkLimiter: FixedWindowLimiter,
  grantLimiter: FixedWindowLimiter,
  failureLimiter: FixedWindowLimiter
) {
  if (!networkLimiter.allows(networkKey) || !grantLimiter.allows(grantId) || !failureLimiter.allows(networkKey)) {
    throw rateLimited();
  }
  let guide: Awaited<ReturnType<EngramAccessService["supportPassportReadGrant"]>>;
  try {
    guide = (await runPublicOperation(service, "support_passport_grant_read", { grantId, secret })) as Awaited<
      ReturnType<EngramAccessService["supportPassportReadGrant"]>
    >;
  } catch (error) {
    if (error instanceof SupportPassportError) {
      if (error.code === "grant_not_found") {
        if (!failureLimiter.consume(networkKey)) throw rateLimited();
      } else {
        consumeAuthenticatedLimits(networkLimiter, grantLimiter, networkKey, grantId);
      }
    }
    throw error;
  }
  consumeAuthenticatedLimits(networkLimiter, grantLimiter, networkKey, grantId);
  return guide;
}

async function readGrantWithRateLimits(
  service: EngramAccessService,
  grantId: string,
  secret: string,
  networkKey: string,
  networkLimiter: FixedWindowLimiter,
  grantLimiter: FixedWindowLimiter,
  failureLimiter: FixedWindowLimiter,
  authenticationLimiter: InFlightLimiter
) {
  const releaseAuthentication = authenticationLimiter.reserve(networkKey);
  if (!releaseAuthentication) throw rateLimited();
  try {
    return await readGrantUnderAuthenticationReservation(
      service,
      grantId,
      secret,
      networkKey,
      networkLimiter,
      grantLimiter,
      failureLimiter
    );
  } finally {
    releaseAuthentication();
  }
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized.startsWith("127.") || normalized.startsWith("::ffff:127.");
}

function forwardedClientAddress(req: IncomingMessage): string | undefined {
  const remoteAddress = req.socket.remoteAddress;
  if (!remoteAddress || !isLoopbackAddress(remoteAddress)) return undefined;
  const raw = req.headers["x-forwarded-for"];
  const hops = (Array.isArray(raw) ? raw : raw ? [raw] : []).flatMap((value) => value.split(","));
  let address = remoteAddress;
  for (let index = hops.length - 1; index >= 0 && isLoopbackAddress(address); index -= 1) {
    const hop = hops[index]?.trim();
    if (!hop || isIP(hop) === 0) return undefined;
    address = hop;
  }
  return address === remoteAddress ? undefined : address;
}

function networkDigest(req: IncomingMessage): string {
  return createHash("sha256")
    .update(forwardedClientAddress(req) ?? req.socket.remoteAddress ?? "unknown")
    .digest("hex");
}

function parseSecret(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return undefined;
  const match = /^(\S+)[ \t]+(\S+)$/.exec(raw);
  if (!match || match[1]?.toLowerCase() !== "supportpassport") return undefined;
  const secret = match[2] ?? "";
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) return undefined;
  return secret;
}

function requestDeclaresBody(req: IncomingMessage): boolean {
  const contentLength = req.headers["content-length"];
  const transferEncoding = req.headers["transfer-encoding"];
  return transferEncoding !== undefined || (contentLength !== undefined && contentLength !== "0");
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("vary", "Authorization");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(Buffer.byteLength(body)));
  res.end(body);
}

async function readQuestionBody(req: IncomingMessage, signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 4_096) {
        throw new SupportPassportError("invalid_input", "The helper question is invalid.", 400);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (signal.aborted || req.aborted) {
      throw isAbortError(signal.reason) ? signal.reason : abortError("The helper left.");
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new SupportPassportError("invalid_input", "The helper question is invalid.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SupportPassportError("invalid_input", "The helper question is invalid.", 400);
  }
  const body = parsed as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || typeof body.question !== "string") {
    throw new SupportPassportError("invalid_input", "The helper question is invalid.", 400);
  }
  const question = body.question.trim();
  if (question.length < 1 || question.length > 500) {
    throw new SupportPassportError("invalid_input", "The helper question is invalid.", 400);
  }
  return question;
}

function requestSignal(req: IncomingMessage, res: ServerResponse): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableFinished && !controller.signal.aborted) controller.abort(abortError("The helper left."));
  };
  req.once("aborted", abort);
  res.once("close", abort);
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off("aborted", abort);
      res.off("close", abort);
    },
  };
}

function decodeGrantId(raw: string): string | undefined {
  try {
    const value = decodeURIComponent(raw);
    return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function buildSupportPassportPublicRequestHandler(
  service: EngramAccessService,
  options: SupportPassportPublicHandlerOptions = {}
): SupportPassportExternalRequestHandler {
  const rateLimits = createRateLimits(options.now ?? Date.now);
  return async (req, res) => {
    let parsed: URL;
    try {
      parsed = new URL(req.url ?? "/", "http://placeholder");
    } catch {
      return false;
    }
    const readMatch = /^\/engram\/v1\/support-passport\/public\/grants\/([^/]+)$/.exec(parsed.pathname);
    const askMatch = /^\/engram\/v1\/support-passport\/public\/grants\/([^/]+)\/ask$/.exec(parsed.pathname);
    const ownedRead = req.method === "GET" && readMatch;
    const ownedQuestion = req.method === "POST" && askMatch;
    if (!ownedRead && !ownedQuestion) return false;

    res.setHeader("cache-control", "private, no-store");
    res.setHeader("vary", "Authorization");
    const grantId = decodeGrantId((ownedRead ? readMatch?.[1] : askMatch?.[1]) ?? "");
    const secret = parseSecret(req);
    if (parsed.search.length > 0) {
      respondJson(res, 400, { error: "The share link request is invalid.", code: "invalid_input" });
      return true;
    }
    if (ownedRead && requestDeclaresBody(req)) {
      respondJson(res, 400, { error: "The share link request is invalid.", code: "invalid_input" });
      return true;
    }
    if (!grantId || !secret) {
      respondJson(res, 404, { error: "The share link was not found.", code: "grant_not_found" });
      return true;
    }

    const lifecycle = requestSignal(req, res);
    try {
      const digest = networkDigest(req);
      if (ownedRead) {
        const guide = await readGrantWithRateLimits(
          service,
          grantId,
          secret,
          digest,
          rateLimits.networkReads,
          rateLimits.grantReads,
          rateLimits.networkReadFailures,
          rateLimits.authentications
        );
        respondJson(res, 200, guide);
      } else {
        const releaseAuthentication = rateLimits.authentications.reserve(digest);
        if (!releaseAuthentication) throw rateLimited();
        let question: string;
        try {
          question = await readQuestionBody(req, lifecycle.signal);
          await readGrantUnderAuthenticationReservation(
            service,
            grantId,
            secret,
            digest,
            rateLimits.networkQuestions,
            rateLimits.grantQuestions,
            rateLimits.networkQuestionFailures
          );
        } finally {
          releaseAuthentication();
        }
        const answer = await runPublicOperation(
          service,
          "support_passport_grant_ask",
          { grantId, secret, question },
          lifecycle.signal
        );
        respondJson(res, 200, answer);
      }
    } catch (error) {
      if (!(error instanceof SupportPassportError)) throw error;
      respondJson(res, error.status, { error: error.message, code: error.code });
    } finally {
      lifecycle.cleanup();
    }
    return true;
  };
}

export function composeSupportPassportExternalRequestHandlers(
  ...handlers: Array<SupportPassportExternalRequestHandler | undefined>
): SupportPassportExternalRequestHandler {
  return async (req, res, ctx) => {
    for (const handler of handlers) {
      if (handler && (await handler(req, res, ctx))) return true;
    }
    return false;
  };
}
