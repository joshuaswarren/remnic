/**
 * Chunk processor (issue #1897) — turns completed native WAV chunk events
 * into durable, replay-safe conversations in the spool.
 *
 * The native helper runner owns process lifecycle and emits one validated
 * `ChunkEvent` per recorded WAV. This module consumes those events through a
 * single serialized promise chain: resolve model -> transcribe -> normalize
 * nonempty segments -> assemble -> persist via durable chunk idempotency ->
 * delete the raw WAV. A rejected chunk is reported and the chain recovers so
 * the daemon stays alive; the durable `applied_chunks` guard keeps a
 * restart/replay of the same chunk from duplicating segments.
 *
 * Every collaborator (STT, model resolution, raw-audio cleanup) is injected,
 * so no optional VAD/native runtime is imported here and the package stays
 * à-la-carte.
 */

import { createHash } from "node:crypto";

import type { AssemblySegment, ConversationAssembler } from "./assembly.js";
import type { ChunkEvent } from "./native.js";
import type { Spool } from "./spool.js";
import type { TranscribedSegment } from "./stt.js";

export interface ChunkTranscribeInput {
  wavPath: string;
  modelPath: string;
  chunkStartedAtUtc: string;
}

export interface ChunkProcessorDeps {
  spool: Spool;
  /** Stateful assembler that groups consecutive segments into conversations. */
  assembler: ConversationAssembler;
  /** Resolve the STT model path; called per chunk and may throw when absent. */
  resolveModel: () => string;
  /** Transcribe one WAV chunk into raw segments. */
  transcribe: (input: ChunkTranscribeInput) => Promise<TranscribedSegment[]>;
  /** Delete the raw WAV under retention once the chunk is durably persisted. */
  cleanupRawAudio: (event: ChunkEvent) => Promise<void>;
  /** Reports a per-chunk failure; the chain keeps running afterwards. */
  onError?: (error: Error, event: ChunkEvent) => void;
}

export interface ChunkProcessor {
  /** onChunk seam for `NativeRunnerOptions`. Never throws; failures route to `onError`. */
  enqueue(event: ChunkEvent): void;
  /** Resolve once the serialized chain has settled all enqueued chunks. */
  drain(): Promise<void>;
  /** Drain, then flip open conversations to `final`; returns the count closed. */
  finalize(): Promise<number>;
}

/**
 * Stable chunk identity derived purely from the WAV path. Because it never
 * depends on a freshly-generated conversation id, the same chunk yields the
 * same idempotency key across process restarts.
 */
export function chunkStableId(event: ChunkEvent): string {
  return `chk_${createHash("sha1").update(event.path).digest("hex")}`;
}

export function createChunkProcessor(deps: ChunkProcessorDeps): ChunkProcessor {
  let tail: Promise<void> = Promise.resolve();
  let recovered = false;
  let openConversationId: string | null = null;
  const processedThisRun = new Set<string>();

  const report = (error: unknown, event: ChunkEvent): void => {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)), event);
  };

  async function process(event: ChunkEvent): Promise<void> {
    const chunkId = chunkStableId(event);
    if (processedThisRun.has(chunkId)) return; // in-run replay: already handled

    const modelPath = deps.resolveModel();
    const raw = await deps.transcribe({
      wavPath: event.path,
      modelPath,
      chunkStartedAtUtc: event.startedAtUtc,
    });

    const segments: AssemblySegment[] = [];
    for (const s of raw) {
      const text = s.text.trim();
      if (text === "") continue;
      segments.push({
        channel: event.channel,
        text,
        startUtc: s.startUtc,
        endUtc: s.endUtc,
        // Interim wearer heuristic: the mic channel is the wearer's own audio.
        // This is NOT diarization/speaker attribution — that lands in a later
        // checklist item and will refine `isWearer` and `speakerCluster`.
        isWearer: event.channel === "mic",
      });
    }

    if (segments.length > 0) {
      // After a restart the assembler is empty; recover the newest still-open
      // conversation from the spool once, so an adjacent chunk continues it
      // instead of splitting. The assembler's own gap rule then decides
      // continue-vs-new; a truly stale open conversation is left for stop-time
      // finalization.
      if (!recovered) {
        recovered = true;
        const prior = deps.spool.latestCapturingConversation();
        if (prior) {
          deps.assembler.resume(prior);
          openConversationId = prior.id;
        }
      }
      // Segments usually land in one conversation, but a gap >= threshold (or
      // conversationGapMinutes = 0) can split them intra-chunk. Group by the
      // conversation the assembler places each segment in, finalizing a prior
      // conversation the moment it closes, and append each group under its own
      // id with a per-group idempotency key (replay-safe).
      const groups: Array<{ id: string; startedAtUtc: string; segs: AssemblySegment[] }> = [];
      for (const seg of segments) {
        const conv = deps.assembler.add(seg);
        if (openConversationId !== null && openConversationId !== conv.id) {
          deps.spool.finalizeConversation(openConversationId);
        }
        openConversationId = conv.id;
        const last = groups[groups.length - 1];
        if (last && last.id === conv.id) last.segs.push(seg);
        else groups.push({ id: conv.id, startedAtUtc: conv.startedAtUtc, segs: [seg] });
      }
      for (let g = 0; g < groups.length; g++) {
        const grp = groups[g];
        const key = groups.length === 1 ? chunkId : `${chunkId}:${g}`;
        deps.spool.appendAssembledSegments({
          idempotencyKey: key,
          chunkId: key,
          conversationId: grp.id,
          startedAtUtc: grp.startedAtUtc,
          state: "capturing",
          device: event.device,
          wavPath: event.path,
          segments: grp.segs,
        });
      }
    }

    processedThisRun.add(chunkId);
    await deps.cleanupRawAudio(event);
  }

  function enqueue(event: ChunkEvent): void {
    tail = tail.then(() => process(event)).catch((error) => report(error, event));
  }

  function drain(): Promise<void> {
    return tail.then(() => undefined);
  }

  async function finalize(): Promise<number> {
    await drain();
    deps.assembler.finalize();
    return deps.spool.finalizeOpenConversations();
  }

  return { enqueue, drain, finalize };
}
