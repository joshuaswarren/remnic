import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

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
  "engram.support_passport_grant_revoke",
  "remnic.support_passport_grant_revoke",
]);
const SUPPORT_PASSPORT_ADMIN_CONSOLE_ASSETS = new Map<string, string>([
  ["what-helps-me.css", "text/css; charset=utf-8"],
  ["model.js", "application/javascript; charset=utf-8"],
  ["app.js", "application/javascript; charset=utf-8"],
]);

export abstract class SupportPassportAccessHttpBase {
  private supportPassportPublicHandler: ReturnType<typeof buildSupportPassportPublicRequestHandler> | undefined;
  protected abstract readonly service: EngramAccessService;
  protected abstract readonly adminConsolePublicDir: string;
  protected abstract resolveRequestPrincipal(req: IncomingMessage): string | undefined;
  protected abstract readJsonBody(req: IncomingMessage, maxBodyBytes?: number): Promise<Record<string, unknown>>;
  protected abstract respondJson(res: ServerResponse, status: number, payload: unknown): void;
  protected abstract reserveWriteRateLimitSlot(req?: IncomingMessage): WriteRateLimitReservation;
  protected abstract respondAdminConsoleShell(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    relativePath?: string,
    allowPrefill?: boolean,
  ): Promise<void>;
  protected abstract respondStatic(res: ServerResponse, filePath: string, contentType: string): Promise<void>;

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
      respondJson: (status, payload) => {
        res.setHeader("cache-control", "private, no-store");
        res.setHeader("vary", "Authorization");
        this.respondJson(res, status, payload);
      },
      reserveWriteRateLimitSlot: () => this.reserveWriteRateLimitSlot(req),
    });
  }

  protected handleSupportPassportPublicRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    this.supportPassportPublicHandler ??= buildSupportPassportPublicRequestHandler(this.service, {
      trustedProxyAddresses: this.service.configRef?.supportPassport?.trustedProxyAddresses ?? [],
    });
    return this.supportPassportPublicHandler(req, res, {
      authorized: false,
      tokenAuthorized: false,
    });
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

  protected async handleSupportPassportUi(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string
  ): Promise<boolean> {
    if (req.method !== "GET") return false;
    const isSupportPassportPath =
      pathname === "/remnic/ui/what-helps-me" ||
      pathname === "/engram/ui/what-helps-me" ||
      pathname.startsWith("/remnic/ui/what-helps-me/") ||
      pathname.startsWith("/engram/ui/what-helps-me/");
    if (!isSupportPassportPath) return false;
    if (!this.service.supportPassportEnabled) {
      this.respondJson(res, 404, { error: "not_found" });
      return true;
    }
    if (pathname === "/remnic/ui/what-helps-me" || pathname === "/engram/ui/what-helps-me") {
      const search = new URL(req.url ?? pathname, "http://placeholder").search;
      res.statusCode = 301;
      res.setHeader("location", `${pathname}/${search}`);
      res.end();
      return true;
    }
    if (pathname === "/remnic/ui/what-helps-me/" || pathname === "/engram/ui/what-helps-me/") {
      const helperRequest = new URL(req.url ?? pathname, "http://placeholder").searchParams.has("grant");
      res.setHeader("content-security-policy", "frame-ancestors 'none'");
      res.setHeader("x-frame-options", "DENY");
      await this.respondAdminConsoleShell(req, res, pathname, "what-helps-me/index.html", !helperRequest);
      return true;
    }
    const fileName = pathname.split("/").at(-1) ?? "";
    const assetType = SUPPORT_PASSPORT_ADMIN_CONSOLE_ASSETS.get(fileName);
    if (assetType && pathname.split("/").length === 5) {
      await this.respondStatic(res, path.join(this.adminConsolePublicDir, "what-helps-me", fileName), assetType);
      return true;
    }
    this.respondJson(res, 404, { error: "not_found" });
    return true;
  }
}
