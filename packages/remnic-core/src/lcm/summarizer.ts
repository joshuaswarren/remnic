import { log } from "../logger.js";
import { looksLikeMechanicalTelemetryTranscript } from "../telemetry-transcript.js";
import { estimateTokenCount } from "../token-estimate.js";
import type { LcmArchive, LcmMessage } from "./archive.js";
import { estimateTokens } from "./archive.js";
import type { LcmDag } from "./dag.js";

/** Generate a ULID-like ID (timestamp + random). */
function generateNodeId(): string {
  const ts = Date.now().toString(36).padStart(9, "0");
  const rand = Math.random().toString(36).slice(2, 10);
  return `lcm-${ts}-${rand}`;
}

export type SummarizeFn = (
  text: string,
  targetTokens: number,
  aggressive: boolean,
) => Promise<string | null>;

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
   * Three-level escalation:
   * 0 = Normal LLM summary
   * 1 = Aggressive bullet compression
   * 2 = Deterministic truncation (no LLM)
   */
  private async summarizeWithEscalation(
    text: string,
    targetTokens: number,
  ): Promise<{ text: string; escalation: number }> {
    const { telemetryPrefilterEnabled } = this.config;
    if (
      telemetryPrefilterEnabled &&
      looksLikeMechanicalTelemetryTranscript(text)
    ) {
      return {
        text: deterministicTruncate(
          text,
          Math.min(targetTokens, this.config.deterministicMaxTokens),
        ),
        escalation: 2,
      };
    }

    // Level 0: Normal LLM summary
    try {
      const result = await this.summarizeFn(text, targetTokens, false);
      if (result && estimateTokens(result) <= targetTokens * 1.5) {
        return { text: result, escalation: 0 };
      }
      // If too long, try aggressive
    } catch (err) {
      log.debug(`LCM level-0 summary failed: ${err}`);
    }

    // Level 1: Aggressive bullet compression
    try {
      const aggressiveTarget = Math.max(32, Math.ceil(targetTokens * 0.5));
      const result = await this.summarizeFn(text, aggressiveTarget, true);
      if (result && estimateTokens(result) <= targetTokens * 1.5) {
        return { text: result, escalation: 1 };
      }
    } catch (err) {
      log.debug(`LCM level-1 summary failed: ${err}`);
    }

    // Level 2: Deterministic truncation (guaranteed, no LLM)
    return {
      text: deterministicTruncate(text, this.config.deterministicMaxTokens),
      escalation: 2,
    };
  }
}

/** Deterministic truncation: first and last sentence, plus middle truncation. */
function deterministicTruncate(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || estimateTokenCount(text) <= maxTokens) return text;

  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
  if (sentences.length <= 2) return clampToTokenBudget(text, maxTokens);

  const first = sentences[0];
  const last = sentences[sentences.length - 1];
  const render = (middle: string[], truncated: boolean): string =>
    `${first} ${middle.join(" ")}${truncated ? " [...] " : " "}${last}`;

  const base = render([], false);
  if (estimateTokenCount(base) > maxTokens) return clampToTokenBudget(text, maxTokens);
  if (estimateTokenCount(render([], true)) > maxTokens) return base;

  const middle: string[] = [];
  for (let i = 1; i < sentences.length - 1; i++) {
    const candidate = [...middle, sentences[i]];
    const truncated = i < sentences.length - 2;
    if (estimateTokenCount(render(candidate, truncated)) > maxTokens) break;
    middle.push(sentences[i]);
  }

  const truncated = middle.length < sentences.length - 2;
  return clampToTokenBudget(render(middle, truncated), maxTokens);
}

function clampToTokenBudget(text: string, maxTokens: number): string {
  const codePoints = [...text];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokenCount(codePoints.slice(0, mid).join("")) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return codePoints.slice(0, low).join("");
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
