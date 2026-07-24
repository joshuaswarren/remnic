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
import { dedupeCrossChannel } from "./dedup.js";
import type { Embedding, SpeakerClusterer } from "./diarization.js";
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
  /** Resolve the STT model path; called per speech chunk and may throw when absent. */
  resolveModel: () => string;
  /** Transcribe one WAV chunk into raw segments. */
  transcribe: (input: ChunkTranscribeInput) => Promise<TranscribedSegment[]>;
  /** Delete the raw WAV under retention once the chunk is durably persisted. */
  cleanupRawAudio: (event: ChunkEvent) => Promise<void>;
  /**
   * VAD speech gate. When provided and it resolves false, the chunk is treated
   * as non-speech: STT is skipped (the CPU-budget guard) and no segments
   * persist. Absent -> every chunk is transcribed.
   */
  detectSpeech?: (event: ChunkEvent) => boolean | Promise<boolean>;
  /**
   * Speaker-embedding extractor for diarization. With `diarizer`, each segment
   * is embedded and assigned to a speaker cluster; absent -> the interim
   * mic=wearer heuristic and no speaker cluster.
   */
  embed?: (event: ChunkEvent, segment: TranscribedSegment) => Embedding | Promise<Embedding>;
  /** Speaker clusterer (seeded from the spool); its clusters are persisted on finalize. */
  diarizer?: SpeakerClusterer;
  /** Cross-channel dedup window in ms; defaults to the dedup module's tolerance. */
  dedupWindowMs?: number;
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
  // Rolling window of recent SYSTEM-channel segments for cross-channel dedup:
  // a mic segment duplicating a recent system (loopback) segment is dropped.
  let recentSystem: AssemblySegment[] = [];

  const report = (error: unknown, event: ChunkEvent): void => {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)), event);
  };

  async function process(event: ChunkEvent): Promise<void> {
    const chunkId = chunkStableId(event);
    if (processedThisRun.has(chunkId)) return; // in-run replay: already handled

    // VAD gate: a non-speech chunk skips STT (and model resolution) entirely,
    // flowing through as a zero-segment chunk so idle-close + WAV reclaim still
    // run. Absent detectSpeech -> transcribe every chunk.
    const isSpeech = deps.detectSpeech ? await deps.detectSpeech(event) : true;
    const raw = isSpeech
      ? await deps.transcribe({
          wavPath: event.path,
          modelPath: deps.resolveModel(),
          chunkStartedAtUtc: event.startedAtUtc,
        })
      : [];

    // Recover the newest still-open conversation once (any chunk, incl. silent)
    // so a post-restart chunk continues it; then finalize a stale open
    // conversation when this chunk arrives a gap past it. Pure-silence runs
    // never call assembler.add, so closeIfIdle is what closes them.
    if (!recovered) {
      recovered = true;
      const prior = deps.spool.latestCapturingConversation();
      if (prior) {
        deps.assembler.resume(prior);
        openConversationId = prior.id;
      }
    }
    const closed = deps.assembler.closeIfIdle(event.startedAtUtc);
    if (closed !== null && closed === openConversationId) {
      deps.spool.finalizeConversation(closed);
      openConversationId = null;
    }

    const built: AssemblySegment[] = [];
    for (const s of raw) {
      const text = s.text.trim();
      if (text === "") continue;
      // Diarization: with an embedder + clusterer, embed the segment and assign
      // it to a stable speaker cluster (self -> the enrolled wearer). Without
      // them, fall back to the interim mic=wearer heuristic and no cluster.
      let speakerCluster: string | null = null;
      let isWearer = event.channel === "mic";
      if (deps.embed && deps.diarizer) {
        const embedding = await deps.embed(event, s);
        speakerCluster = deps.diarizer.assign(embedding);
        isWearer = deps.diarizer.clusters().find((c) => c.id === speakerCluster)?.isSelf ?? false;
      }
      built.push({
        channel: event.channel,
        text,
        startUtc: s.startUtc,
        endUtc: s.endUtc,
        isWearer,
        ...(speakerCluster !== null ? { speakerCluster } : {}),
      });
    }

    // Cross-channel dedup (keep system, drop mic). A mic chunk's segments are
    // filtered against the recent system window; a system chunk's segments are
    // always kept and buffered so a later mic loopback is deduped. Forward-only:
    // an already-appended mic segment is not retro-removed by a later system
    // dup, which suits the streaming loopback case (system leads or is concurrent).
    let segments = built;
    if (event.channel === "mic" && recentSystem.length > 0) {
      const options = deps.dedupWindowMs !== undefined ? { toleranceMs: deps.dedupWindowMs } : {};
      const survivors = new Set(dedupeCrossChannel([...recentSystem, ...built], options));
      segments = built.filter((seg) => survivors.has(seg));
    } else if (event.channel === "system" && built.length > 0) {
      recentSystem.push(...built);
      const windowMs = deps.dedupWindowMs ?? 5_000;
      const cutoff = Date.parse(event.endedAtUtc) - windowMs;
      if (Number.isFinite(cutoff)) {
        recentSystem = recentSystem.filter((seg) => {
          const end = Date.parse(seg.endUtc);
          return Number.isFinite(end) ? end >= cutoff : true;
        });
      }
    }

    if (segments.length > 0) {
      // Segments usually land in one conversation, but a gap >= threshold (or
      // conversationGapMinutes = 0) can split them intra-chunk. Group by the
      // conversation the assembler places each segment in.
      const groups: Array<{ id: string; startedAtUtc: string; segs: AssemblySegment[] }> = [];
      for (const seg of segments) {
        const conv = deps.assembler.add(seg);
        const last = groups[groups.length - 1];
        if (last && last.id === conv.id) last.segs.push(seg);
        else groups.push({ id: conv.id, startedAtUtc: conv.startedAtUtc, segs: [seg] });
      }
      // Append each group, finalizing a conversation only once we move past it
      // — i.e. AFTER its rows have been appended — so no segment is ever added
      // to an already-finalized conversation, and a gap-closed conversation
      // doesn't linger as `capturing`.
      for (let g = 0; g < groups.length; g++) {
        const grp = groups[g];
        if (openConversationId !== null && openConversationId !== grp.id) {
          deps.spool.finalizeConversation(openConversationId);
        }
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
        openConversationId = grp.id;
      }
    }

    processedThisRun.add(chunkId);
    // A successful transcription (even an empty/silent one) means the chunk is
    // fully handled, so reclaim its raw WAV. A FAILED transcription throws
    // above and never reaches here, so its WAV is retained. Best-effort — a
    // cleanup failure is reported and the retention janitor is the backstop.
    try {
      await deps.cleanupRawAudio(event);
    } catch (err) {
      report(err, event);
    }
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
    // Persist diarization clusters so their ids survive a daemon restart
    // (the next run seeds SpeakerClusterer from readSpeakerClusters()).
    if (deps.diarizer) {
      for (const cluster of deps.diarizer.clusters()) {
        deps.spool.upsertSpeaker({
          id: cluster.id,
          label: cluster.label,
          isSelf: cluster.isSelf,
          embeddingCount: cluster.embeddingCount,
          centroid: cluster.centroid,
          examples: cluster.examples,
        });
      }
    }
    return deps.spool.finalizeOpenConversations();
  }

  return { enqueue, drain, finalize };
}
