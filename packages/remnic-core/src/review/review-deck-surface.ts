import { createHash } from "node:crypto";

import { EngramAccessInputError } from "../access-service.js";
import type { CorrectionPlan, CorrectionRequest } from "../correction/index.js";
import type { Orchestrator } from "../orchestrator.js";
import type { MemoryLifecycleEvent } from "../types.js";
import {
  ReviewDeckCursorError,
  buildReviewDeckPage,
  type ReviewDeckActionReceipt,
  type ReviewDeckActionRequest,
  type ReviewDeckPage,
  type ReviewDeckUndoRequest,
} from "./review-deck.js";
import {
  executeReviewDeckAction,
  executeReviewDeckUndo,
  type ReviewDeckMutationContext,
} from "./review-deck-mutation.js";
import { readReviewDeckSnapshot } from "./review-deck-snapshot.js";

export interface ReviewDeckSurfaceDeps {
  readonly orchestrator: Orchestrator;
  resolveReadableNamespace(namespace: string | undefined, principal?: string): string;
  writableNamespaceFor(
    namespace: string | undefined,
    sessionKey: string | undefined,
    authenticatedPrincipal?: string,
  ): string;
  correctionPlan(request: CorrectionRequest, opts?: { abortSignal?: AbortSignal }): Promise<CorrectionPlan>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class ReviewDeckSurface {
  constructor(private readonly deps: ReviewDeckSurfaceDeps) {}

  async list(opts: {
    namespace?: string;
    principal?: string;
    cursor?: string;
    limit: number;
  }): Promise<ReviewDeckPage> {
    const namespace = this.deps.resolveReadableNamespace(opts.namespace, opts.principal);
    const storage = await this.deps.orchestrator.getStorage(namespace);
    const snapshot = readReviewDeckSnapshot({ memoryDir: storage.dir, namespace });
    try {
      return buildReviewDeckPage(snapshot.rows, {
        scope: {
          principalDigest: digest(opts.principal ?? ""),
          namespace,
          filterDigest: digest(""),
          corpusVersion: snapshot.corpusVersion,
        },
        cursor: opts.cursor,
        limit: opts.limit,
      });
    } catch (error) {
      if (error instanceof ReviewDeckCursorError) {
        throw new EngramAccessInputError(error.message);
      }
      throw error;
    }
  }

  async action(
    req: ReviewDeckActionRequest,
    opts: { namespace?: string; principal?: string; signal?: AbortSignal },
  ): Promise<ReviewDeckActionReceipt> {
    return executeReviewDeckAction(await this.mutationContext(opts), req);
  }

  async undo(
    req: ReviewDeckUndoRequest,
    opts: { namespace?: string; principal?: string; signal?: AbortSignal },
  ): Promise<ReviewDeckActionReceipt> {
    return executeReviewDeckUndo(await this.mutationContext(opts), req);
  }

  private async mutationContext(opts: {
    namespace?: string;
    principal?: string;
    signal?: AbortSignal;
  }): Promise<ReviewDeckMutationContext> {
    const namespace = this.deps.writableNamespaceFor(opts.namespace, undefined, opts.principal);
    this.deps.resolveReadableNamespace(namespace, opts.principal);
    const storage = await this.deps.orchestrator.getStorage(namespace);
    return {
      memoryDir: storage.dir,
      namespace,
      principalDigest: digest(opts.principal ?? ""),
      appendLifecycleEvents: async (events) => {
        await storage.appendMemoryLifecycleEvents(events as MemoryLifecycleEvent[]);
      },
      readLifecycleEvents: (memoryId) =>
        memoryId ? storage.getMemoryTimeline(memoryId) : storage.readMemoryLifecycleEvents(),
      onApproveBlockedMemory: (tombstoneId) => {
        void storage.revokeTombstone(tombstoneId, "user_correction").catch(() => undefined);
      },
      planCorrection: async ({ itemId, correctionText }) => {
        const plan = await this.deps.correctionPlan(
          {
            text: correctionText,
            targetIds: [itemId],
            principal: opts.principal,
            namespace,
          },
          opts.signal ? { abortSignal: opts.signal } : undefined,
        );
        return { planId: plan.planId, preview: plan };
      },
      signal: opts.signal,
    };
  }
}
