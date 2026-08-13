import type { IncomingMessage, ServerResponse } from "node:http";

import { EngramAccessForbiddenError } from "../access-errors.js";
import type { EngramAccessService } from "../access-service.js";
import { enforceNamespaceAllowList, tokenCapabilityStore } from "../access-token-capabilities.js";
import type { WriteRateLimitReservation } from "../write-rate-limiter.js";
import { handleSupportPassportOwnerHttp } from "./access-http.js";
import { buildSupportPassportPublicRequestHandler } from "./public-http.js";

const SUPPORT_PASSPORT_QUOTA_LIMITED_WRITE_TOOLS = new Set([
  "engram.support_passport_draft_create",
  "remnic.support_passport_draft_create",
  "engram.support_passport_drafts_generate",
  "remnic.support_passport_drafts_generate",
  "engram.support_passport_card_replace",
  "remnic.support_passport_card_replace",
  "engram.support_passport_card_approve",
  "remnic.support_passport_card_approve",
  "engram.support_passport_card_reject",
  "remnic.support_passport_card_reject",
  "engram.support_passport_card_withdraw",
  "remnic.support_passport_card_withdraw",
  "engram.support_passport_grant_create",
  "remnic.support_passport_grant_create",
]);

export abstract class SupportPassportAccessHttpBase {
  private supportPassportPublicHandler: ReturnType<typeof buildSupportPassportPublicRequestHandler> | undefined;
  protected abstract readonly service: EngramAccessService;
  protected abstract resolveRequestPrincipal(req: IncomingMessage): string | undefined;
  protected abstract readJsonBody(req: IncomingMessage, maxBodyBytes?: number): Promise<Record<string, unknown>>;
  protected abstract respondJson(res: ServerResponse, status: number, payload: unknown): void;
  protected abstract reserveWriteRateLimitSlot(req?: IncomingMessage): WriteRateLimitReservation;

  protected handleSupportPassportOwnerRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    hasQuery: boolean,
    abortSignal: AbortSignal
  ): Promise<boolean> {
    return handleSupportPassportOwnerHttp({
      req,
      res,
      pathname,
      hasQuery,
      service: this.service,
      principal: this.resolveRequestPrincipal(req),
      abortSignal,
      readJsonBody: () => this.readJsonBody(req),
      respondJson: (status, payload) => this.respondJson(res, status, payload),
      reserveWriteRateLimitSlot: () => this.reserveWriteRateLimitSlot(req),
    });
  }

  protected handleSupportPassportPublicRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    this.supportPassportPublicHandler ??= buildSupportPassportPublicRequestHandler(this.service);
    return this.supportPassportPublicHandler(req, res, { authorized: false });
  }

  protected async enforceSupportPassportAuthorizationProbe(req: IncomingMessage): Promise<void> {
    const principal = this.resolveRequestPrincipal(req)?.trim();
    if (!principal) {
      throw new EngramAccessForbiddenError("A trusted principal is required for support passport access.");
    }
    const owner = await this.service.getWritableStorageForNamespace(undefined, principal);
    enforceNamespaceAllowList(
      tokenCapabilityStore.getStore(),
      owner.namespace,
      this.service.configRef.defaultNamespace
    );
  }

  protected isSupportPassportQuotaLimitedWriteTool(toolName: string): boolean {
    return SUPPORT_PASSPORT_QUOTA_LIMITED_WRITE_TOOLS.has(toolName);
  }
}
