import type { IncomingMessage, ServerResponse } from "node:http";

import { type OperationName, getOperation } from "../access-boundary.js";
import type { EngramAccessService } from "../access-service.js";
import { SupportPassportError } from "./errors.js";
import { SupportPassportOwnerCreateGrantRequestSchema } from "./grant-contracts.js";

export interface SupportPassportOwnerHttpDependencies {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  hasQuery: boolean;
  service: EngramAccessService;
  principal?: string;
  abortSignal: AbortSignal;
  readJsonBody(): Promise<Record<string, unknown>>;
  respondJson(status: number, payload: unknown): void;
  reserveWriteRateLimitSlot(): { commit(): void; release(): void };
}

const OWNER_ROOT = "/engram/v1/support-passport";

export const SUPPORT_PASSPORT_OWNER_HTTP_ROUTES = [
  { method: "GET", pathname: `${OWNER_ROOT}/cards`, operation: "support_passport_cards_list" },
  { method: "POST", pathname: `${OWNER_ROOT}/drafts`, operation: "support_passport_draft_create" },
  { method: "POST", pathname: `${OWNER_ROOT}/drafts/generate`, operation: "support_passport_drafts_generate" },
  { method: "GET", pathname: `${OWNER_ROOT}/grants`, operation: "support_passport_grants_list" },
  { method: "POST", pathname: `${OWNER_ROOT}/grants`, operation: "support_passport_grant_create" },
  { method: "GET", pathname: `${OWNER_ROOT}/memories/:id`, operation: "support_passport_memory_preview" },
  { method: "PUT", pathname: `${OWNER_ROOT}/cards/:id`, operation: "support_passport_card_replace" },
  { method: "POST", pathname: `${OWNER_ROOT}/cards/:id/approve`, operation: "support_passport_card_approve" },
  { method: "POST", pathname: `${OWNER_ROOT}/cards/:id/reject`, operation: "support_passport_card_reject" },
  { method: "POST", pathname: `${OWNER_ROOT}/cards/:id/withdraw`, operation: "support_passport_card_withdraw" },
  { method: "POST", pathname: `${OWNER_ROOT}/grants/:id/revoke`, operation: "support_passport_grant_revoke" },
] as const satisfies ReadonlyArray<{ method: string; pathname: string; operation: OperationName }>;

function decodeId(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SupportPassportError("invalid_input", `${label} is invalid.`, 400);
  }
}

async function runOperation(
  name: OperationName,
  input: Record<string, unknown>,
  dependencies: SupportPassportOwnerHttpDependencies,
  recordWriteCommit?: () => void
): Promise<unknown> {
  const operation = getOperation(name);
  if (!operation) throw new Error(`access-boundary: operation not registered: ${name}`);
  const output = (await operation.run(input, {
    service: dependencies.service,
    authenticatedPrincipal: dependencies.principal,
    abortSignal: dependencies.abortSignal,
    ...(recordWriteCommit ? { hooks: { recordWriteCommit } } : {}),
  })) as { result: unknown };
  return output.result;
}

async function runWrite(
  name: OperationName,
  input: Record<string, unknown>,
  dependencies: SupportPassportOwnerHttpDependencies
): Promise<unknown> {
  const writeQuota = dependencies.reserveWriteRateLimitSlot();
  try {
    const result = await runOperation(name, input, dependencies, writeQuota.commit);
    writeQuota.commit();
    return result;
  } catch (error) {
    writeQuota.release();
    throw error;
  }
}

export async function handleSupportPassportOwnerHttp(
  dependencies: SupportPassportOwnerHttpDependencies
): Promise<boolean> {
  const { req, pathname } = dependencies;
  try {
    let operation: OperationName | undefined;
    let input: Record<string, unknown> = {};
    let quotaLimitedWrite = false;

    if (req.method === "GET" && pathname === `${OWNER_ROOT}/cards`) {
      operation = "support_passport_cards_list";
    } else if (req.method === "POST" && pathname === `${OWNER_ROOT}/drafts`) {
      operation = "support_passport_draft_create";
      quotaLimitedWrite = true;
    } else if (req.method === "POST" && pathname === `${OWNER_ROOT}/drafts/generate`) {
      operation = "support_passport_drafts_generate";
      quotaLimitedWrite = true;
    } else if (pathname === `${OWNER_ROOT}/grants` && req.method === "GET") {
      operation = "support_passport_grants_list";
    } else if (pathname === `${OWNER_ROOT}/grants` && req.method === "POST") {
      operation = "support_passport_grant_create";
      quotaLimitedWrite = true;
    } else {
      const memoryMatch = new RegExp(`^${OWNER_ROOT}/memories/([^/]+)$`).exec(pathname);
      const cardMatch = new RegExp(`^${OWNER_ROOT}/cards/([^/]+)(?:/(approve|reject|withdraw))?$`).exec(pathname);
      const grantMatch = new RegExp(`^${OWNER_ROOT}/grants/([^/]+)/revoke$`).exec(pathname);
      if (memoryMatch && req.method === "GET") {
        operation = "support_passport_memory_preview";
        input.memoryId = decodeId(memoryMatch[1] ?? "", "memoryId");
      } else if (cardMatch && req.method === "PUT" && !cardMatch[2]) {
        operation = "support_passport_card_replace";
        input.cardId = decodeId(cardMatch[1] ?? "", "cardId");
        quotaLimitedWrite = true;
      } else if (cardMatch && req.method === "POST" && cardMatch[2]) {
        operation = `support_passport_card_${cardMatch[2]}` as OperationName;
        input.cardId = decodeId(cardMatch[1] ?? "", "cardId");
        quotaLimitedWrite = true;
      } else if (grantMatch && req.method === "POST") {
        operation = "support_passport_grant_revoke";
        input.grantId = decodeId(grantMatch[1] ?? "", "grantId");
        quotaLimitedWrite = true;
      }
    }

    if (!operation) return false;
    if (dependencies.hasQuery) {
      throw new SupportPassportError("invalid_input", "Support passport routes do not accept query values.", 400);
    }
    if (req.method !== "GET") {
      const body = await dependencies.readJsonBody();
      for (const pathField of Object.keys(input)) {
        if (Object.hasOwn(body, pathField)) {
          throw new SupportPassportError("invalid_input", `${pathField} belongs in the URL path.`, 400);
        }
      }
      input = { ...input, ...body };
    }
    if (operation === "support_passport_drafts_generate" && !Object.hasOwn(input, "sourceMemoryRevisions")) {
      throw new SupportPassportError("invalid_input", "Review the selected notes again before drafting.", 400);
    }
    if (operation === "support_passport_grant_create") {
      const grant = SupportPassportOwnerCreateGrantRequestSchema.safeParse(input);
      if (!grant.success) throw new SupportPassportError("invalid_input", "The share link request is invalid.", 400);
      input = {
        cardIds: grant.data.cardIds,
        cardRevisions: grant.data.cardRevisions,
        ...(grant.data.expiresAt !== undefined
          ? { expiresAt: grant.data.expiresAt }
          : { durationMs: grant.data.durationMs }),
      };
    }
    const result = quotaLimitedWrite
      ? await runWrite(operation, input, dependencies)
      : await runOperation(operation, input, dependencies);
    dependencies.respondJson(200, result);
  } catch (error) {
    if (!(error instanceof SupportPassportError)) throw error;
    dependencies.respondJson(error.status, { error: error.message, code: error.code });
  }
  return true;
}
