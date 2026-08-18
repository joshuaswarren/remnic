import { summarizeContextPure, type SummarizeFn } from "../context-summary.js";
import { estimateTokens } from "./archive.js";
import type { LcmArchive, LcmMessage } from "./archive.js";
import type { LcmDag } from "./dag.js";

/** Generate a ULID-like ID (timestamp + random). */
function generateNodeId(): string {
  const ts = Date.now().toString(36).padStart(9, "0");
  const rand = Math.random().toString(36).slice(2, 10);
  return `lcm-${ts}-${rand}`;
}

// `SummarizeFn` moved to the shared pure summary seam (context-summary.ts,
// #2347); re-exported here for back-compat with existing imports.
export type { SummarizeFn };

export interface LcmSummarizerConfig {
  leafBatchSize: number;
  rollupFanIn: number;
  maxDepth: number;
  deterministicMaxTokens: number;
  telemetryPrefilterEnabled: boolean;
}

export class LcmSummarizer {
  constructor(
    private readonly archive: LcmArchive,
    private readonly dag: LcmDag,
    private readonly summarizeFn: SummarizeFn,
    private readonly config: LcmSummarizerConfig,
  ) {}

  /**
   * Run incremental summarization for a session.
   * Creates leaf nodes from unsummarized messages, then rolls up as needed.
   */
  async summarizeIncremental(sessionId: string): Promise<number> {
    let nodesCreated = 0;

    // Phase 1: Create leaf nodes from unsummarized messages
    const unsummarized = this.archive.getUnsummarizedMessages(sessionId);
    if (unsummarized.length >= this.config.leafBatchSize) {
      const batches = chunkArray(unsummarized, this.config.leafBatchSize);
      // Only process complete batches (leave partial for next time)
      const completeBatches = unsummarized.length % this.config.leafBatchSize === 0
        ? batches
        : batches.slice(0, -1);

      for (const batch of completeBatches) {
        const created = await this.createLeafNode(sessionId, batch);
        if (created) nodesCreated++;
      }
    }

    // Phase 2: Roll up at each depth level
    if (nodesCreated > 0) {
      nodesCreated += await this.rollupAll(sessionId);
    }

    return nodesCreated;
  }

  /** Create a leaf summary node (depth 0) from a batch of messages. */
  private async createLeafNode(
    sessionId: string,
    messages: LcmMessage[],
  ): Promise<boolean> {
    if (messages.length === 0) return false;

    const combinedText = messages
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n\n");

    const inputTokens = estimateTokens(combinedText);
    const targetTokens = Math.max(64, Math.ceil(inputTokens * 0.25));

    const summary = await this.summarizeWithEscalation(combinedText, targetTokens);

    this.dag.insertNode({
      id: generateNodeId(),
      session_id: sessionId,
      depth: 0,
      parent_id: null,
      summary_text: summary.text,
      token_count: estimateTokens(summary.text),
      msg_start: messages[0].turn_index,
      msg_end: messages[messages.length - 1].turn_index,
      escalation: summary.escalation,
    });

    return true;
  }

  /** Roll up orphan nodes at each depth level up to maxDepth. */
  private async rollupAll(sessionId: string): Promise<number> {
    let totalCreated = 0;

    for (let depth = 0; depth < this.config.maxDepth; depth++) {
      const orphans = this.dag.getOrphanNodesAtDepth(sessionId, depth);
      if (orphans.length < this.config.rollupFanIn) continue;

      const batches = chunkArray(orphans, this.config.rollupFanIn);
      // Only process complete batches
      const completeBatches = orphans.length % this.config.rollupFanIn === 0
        ? batches
        : batches.slice(0, -1);

      for (const batch of completeBatches) {
        const combinedText = batch
          .map((n) => n.summary_text)
          .join("\n\n");

        const inputTokens = estimateTokens(combinedText);
        const targetTokens = Math.max(64, Math.ceil(inputTokens * 0.25));

        const summary = await this.summarizeWithEscalation(combinedText, targetTokens);

        const parentId = generateNodeId();
        this.dag.insertNode({
          id: parentId,
          session_id: sessionId,
          depth: depth + 1,
          parent_id: null,
          summary_text: summary.text,
          token_count: estimateTokens(summary.text),
          msg_start: batch[0].msg_start,
          msg_end: batch[batch.length - 1].msg_end,
          escalation: summary.escalation,
        });

        this.dag.setParent(
          batch.map((n) => n.id),
          parentId,
        );

        totalCreated++;
      }
    }

    return totalCreated;
  }

  /**
   * Three-level escalation, delegated to the shared pure summary seam
   * (context-summary.ts): 0 = normal LLM, 1 = aggressive, 2 = deterministic.
   */
  private async summarizeWithEscalation(
    text: string,
    targetTokens: number,
  ): Promise<{ text: string; escalation: number }> {
    const { deterministicMaxTokens, telemetryPrefilterEnabled } = this.config;
    const result = await summarizeContextPure(text, targetTokens, "auto", {
      llm: this.summarizeFn,
      deterministicMaxTokens,
      telemetryPrefilterEnabled,
    });
    return { text: result.text, escalation: result.escalation ?? 2 };
  }
}


function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
