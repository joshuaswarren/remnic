import type { IncomingMessage, ServerResponse } from "node:http";

import { EngramAccessInputError } from "../access-service.js";
import type { OperationName } from "../access-boundary.js";
import { SupportPassportAccessHttpBase } from "../support-passport/access-http-base.js";
import type {
  ReviewDeckActionRequest,
  ReviewDeckUndoRequest,
} from "./review-deck.js";

const LIST_PATHS = ["/remnic/v1/review/deck", "/engram/v1/review/deck"] as const;
const ACTION_PATHS = ["/remnic/v1/review/deck/action", "/engram/v1/review/deck/action"] as const;
const UNDO_PATHS = ["/remnic/v1/review/deck/undo", "/engram/v1/review/deck/undo"] as const;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const CURSOR_RE = /^[^\s%]{1,2048}$/;

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EngramAccessInputError(`${field} is required`);
  }
  return value.trim();
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw.length === 0) {
    throw new EngramAccessInputError("limit is required and must be an integer");
  }
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new EngramAccessInputError("limit must be an integer");
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < LIMIT_MIN || value > LIMIT_MAX) {
    throw new EngramAccessInputError(`limit must be an integer from ${LIMIT_MIN} to ${LIMIT_MAX}`);
  }
  return value;
}

function parseCursor(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  if (!CURSOR_RE.test(raw)) {
    throw new EngramAccessInputError("cursor is malformed");
  }
  return raw;
}

function parseActionBody(body: Record<string, unknown>): ReviewDeckActionRequest {
  const action = body.action;
  if (action !== "keep" && action !== "not_true" && action !== "prepare_fix") {
    throw new EngramAccessInputError("action must be one of: keep, not_true, prepare_fix");
  }
  const itemId = requiredString(body, "itemId");
  const revision = requiredString(body, "revision");
  const idempotencyKey = requiredString(body, "idempotencyKey");
  if (action === "prepare_fix") {
    const correctionText = requiredString(body, "correctionText");
    return { schemaVersion: 1, itemId, revision, action, correctionText, idempotencyKey };
  }
  return { schemaVersion: 1, itemId, revision, action, idempotencyKey };
}

function parseUndoBody(body: Record<string, unknown>): ReviewDeckUndoRequest {
  return {
    schemaVersion: 1,
    receiptId: requiredString(body, "receiptId"),
    expectedRevision: requiredString(body, "expectedRevision"),
    idempotencyKey: requiredString(body, "idempotencyKey"),
  };
}

export abstract class ReviewDeckAccessHttpBase extends SupportPassportAccessHttpBase {
  protected abstract enforceTokenOp(op: OperationName): void;
  protected abstract resolveNamespace(req: IncomingMessage, bodyNamespace?: string): string | undefined;
  protected abstract readonly maxBodyBytes: number;

  protected async handleReviewDeckRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    const method = req.method;
    const isList = method === "GET" && (pathname === LIST_PATHS[0] || pathname === LIST_PATHS[1]);
    const isAction = method === "POST" && (pathname === ACTION_PATHS[0] || pathname === ACTION_PATHS[1]);
    const isUndo = method === "POST" && (pathname === UNDO_PATHS[0] || pathname === UNDO_PATHS[1]);
    if (!isList && !isAction && !isUndo) return false;
    if (!this.service.reviewDeckEnabled) {
      this.respondJson(res, 404, { error: "not_found", code: "not_found" });
      return true;
    }

    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    const namespace = this.resolveNamespace(req, parsed.searchParams.get("namespace") ?? undefined);
    const principal = this.resolveRequestPrincipal(req);

    if (isList) {
      this.enforceTokenOp("review_deck_list");
      const page = await this.service.reviewDeckList({
        namespace,
        principal,
        cursor: parseCursor(parsed.searchParams.get("cursor")),
        limit: parseLimit(parsed.searchParams.get("limit")),
      });
      this.respondJson(res, 200, page);
      return true;
    }

    if (isAction) this.enforceTokenOp("review_deck_action");
    else this.enforceTokenOp("review_deck_undo");
    const writeQuota = this.reserveWriteRateLimitSlot(req);
    try {
      const body = await this.readJsonBody(req, this.maxBodyBytes);
      const result = isAction
        ? await this.service.reviewDeckAction(parseActionBody(body), {
            namespace,
            principal,
            signal: abortSignal,
          })
        : await this.service.reviewDeckUndo(parseUndoBody(body), {
            namespace,
            principal,
            signal: abortSignal,
          });
      writeQuota.commit();
      this.respondJson(res, 200, result);
    } catch (error) {
      writeQuota.release();
      throw error;
    }
    return true;
  }
}
