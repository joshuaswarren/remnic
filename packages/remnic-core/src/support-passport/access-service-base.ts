import { enforceNamespaceAllowList, tokenCapabilityStore } from "../access-token-capabilities.js";
import type { StorageManager } from "../index.js";
import type { LocalLlmClient } from "../local-llm.js";
import type { PluginConfig } from "../types.js";
import {
  SupportPassportAccessSurface,
  type SupportPassportCreateGrantResult,
  type SupportPassportMemoryPreview,
  type SupportPassportRevokeGrantResult,
} from "./access-surface.js";
import type { SupportPassportOwnerScope } from "./card-state.js";
import type { SupportPassportCard, SupportPassportCardCategory } from "./contracts.js";
import { SupportPassportError } from "./errors.js";
import type {
  SupportPassportCreateGrantRequest,
  SupportPassportOwnerGrant,
  SupportPassportPublicGuide,
} from "./grant-contracts.js";
import { type SupportPassportModelRoute, createSupportPassportModelAdapter } from "./model-adapter.js";
import type { SupportPassportAnswerOutput } from "./model-contracts.js";
import { supportsSupportPassportPrivateFiles } from "./private-file.js";

export abstract class SupportPassportAccessServiceBase {
  private _supportPassportSurface: SupportPassportAccessSurface | undefined;

  abstract get configRef(): PluginConfig;
  abstract get localLlmRef(): LocalLlmClient | null;
  abstract getWritableStorageForNamespace(namespace?: string, principal?: string): Promise<SupportPassportOwnerScope>;
  abstract getStorageForResolvedNamespace(namespace: string): Promise<StorageManager>;

  get supportPassportGatewayRouteRef(): SupportPassportModelRoute | null {
    return null;
  }

  get supportPassportPlatformRef(): NodeJS.Platform {
    return process.platform;
  }

  private getSupportPassportSurface(publicRequest = false): SupportPassportAccessSurface {
    if (!this.supportPassportEnabled) {
      if (publicRequest) {
        throw new SupportPassportError("grant_not_found", "The share link was not found.", 404);
      }
      throw new SupportPassportError("feature_disabled", "Support passport is disabled.", 404);
    }
    if (!this._supportPassportSurface) {
      this._supportPassportSurface = new SupportPassportAccessSurface({
        config: this.configRef,
        platform: this.supportPassportPlatformRef,
        resolveOwner: async (principal) => {
          const owner = await this.getWritableStorageForNamespace(undefined, principal);
          enforceNamespaceAllowList(tokenCapabilityStore.getStore(), owner.namespace, this.configRef.defaultNamespace);
          return owner;
        },
        resolveNamespace: (namespace) => this.getStorageForResolvedNamespace(namespace),
        modelAdapter: createSupportPassportModelAdapter(this.configRef, {
          localLlm: this.localLlmRef ?? undefined,
          gatewayRoute: this.supportPassportGatewayRouteRef ?? undefined,
        }),
      });
    }
    return this._supportPassportSurface;
  }

  get supportPassportEnabled(): boolean {
    return (
      this.configRef.supportPassport?.enabled === true &&
      supportsSupportPassportPrivateFiles(this.supportPassportPlatformRef)
    );
  }

  async supportPassportListCards(principal: string): Promise<SupportPassportCard[]> {
    return this.getSupportPassportSurface().listCards(principal);
  }

  async supportPassportPreviewMemory(principal: string, memoryId: string): Promise<SupportPassportMemoryPreview> {
    return this.getSupportPassportSurface().previewMemory(principal, memoryId);
  }

  async supportPassportCreateManualDraft(
    principal: string,
    input: { title: string; statement: string; category: SupportPassportCardCategory; reviewBy: string },
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    return this.getSupportPassportSurface().createManualDraft(principal, input, options);
  }

  async supportPassportGenerateDrafts(
    principal: string,
    input: {
      sourceMemoryIds: string[];
      sourceMemoryRevisions: Array<{ memoryId: string; revision: string }>;
      consent: boolean;
      signal?: AbortSignal;
      onCommitted?: () => void;
    }
  ): Promise<SupportPassportCard[]> {
    return this.getSupportPassportSurface().generateDrafts(principal, input);
  }

  async supportPassportReplaceCard(
    principal: string,
    cardId: string,
    input: {
      title: string;
      statement: string;
      category: SupportPassportCardCategory;
      reviewBy: string;
      expectedRevision: string;
    },
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    return this.getSupportPassportSurface().replaceCard(principal, cardId, input, options);
  }

  async supportPassportApproveCard(
    principal: string,
    cardId: string,
    input: { expectedRevision: string; reasonCode?: string },
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    return this.getSupportPassportSurface().approveCard(principal, cardId, input, options);
  }

  async supportPassportRejectCard(
    principal: string,
    cardId: string,
    input: { expectedRevision: string; reasonCode?: string },
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    return this.getSupportPassportSurface().rejectCard(principal, cardId, input, options);
  }

  async supportPassportWithdrawCard(
    principal: string,
    cardId: string,
    input: { expectedRevision: string; reasonCode?: string },
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCard> {
    return this.getSupportPassportSurface().withdrawCard(principal, cardId, input, options);
  }

  async supportPassportCreateGrant(
    principal: string,
    input: SupportPassportCreateGrantRequest,
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportCreateGrantResult> {
    return this.getSupportPassportSurface().createGrant(principal, input, options);
  }

  async supportPassportListGrants(principal: string): Promise<SupportPassportOwnerGrant[]> {
    return this.getSupportPassportSurface().listGrants(principal);
  }

  async supportPassportRevokeGrant(
    principal: string,
    grantId: string,
    input: { expectedVersion?: number },
    options: { signal?: AbortSignal; onCommitted?: () => void } = {}
  ): Promise<SupportPassportRevokeGrantResult> {
    return this.getSupportPassportSurface().revokeGrant(principal, grantId, input, options);
  }

  async supportPassportReadGrant(grantId: string, secret: string): Promise<SupportPassportPublicGuide> {
    return this.getSupportPassportSurface(true).readGrant(grantId, secret);
  }

  async supportPassportAskGrant(
    grantId: string,
    secret: string,
    question: string,
    signal?: AbortSignal
  ): Promise<SupportPassportAnswerOutput> {
    return this.getSupportPassportSurface(true).askGrant(grantId, secret, question, signal);
  }
}
