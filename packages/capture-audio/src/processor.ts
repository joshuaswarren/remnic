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
  // Order-independent cross-channel dedup, applied at finalization: a mic
  // segment duplicating a system (loopback) segment in the same conversation is
  // pruned, keeping the cleaner system copy. Running at finalize — when every
  // segment is present — means arrival order (mic-before-system or the reverse)
  // never matters, so the native helper's shutdown ordering can't leak a dup.
  const dedupeConversation = (id: string): void => {
    const segs = deps.spool.conversationSegmentsForDedup(id);
    if (segs.length === 0) return;
    const options = deps.dedupWindowMs !== undefined ? { toleranceMs: deps.dedupWindowMs } : {};
    const keep = new Set(dedupeCrossChannel(segs, options).map((s) => s.id));
    const drop = segs.filter((s) => !keep.has(s.id)).map((s) => s.id);
    if (drop.length > 0) deps.spool.deleteSegments(drop);
  };
  const finalizeConv = (id: string): void => {
    dedupeConversation(id);
    deps.spool.finalizeConversation(id);
  };

  const report = (error: unknown, event: ChunkEvent): void => {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)), event);
  };

  async function process(event: ChunkEvent): Promise<void> {
    const chunkId = chunkStableId(event);
    if (processedThisRun.has(chunkId)) return; // in-run replay: already handled
    // Durable (cross-restart) FULL replay: a completed chunk wrote a per-chunk
    // ':done' marker, so its segments AND cluster updates are persisted. Skip
    // transcription + diarization entirely. A PARTIAL replay (crash between
    // group appends) has no marker, so it falls through and per-group
    // idempotency re-appends only the missing groups below.
    if (deps.spool.isChunkApplied(`${chunkId}:done`)) {
      processedThisRun.add(chunkId);
      // Retry raw-WAV reclaim: the marker is written before cleanup, so if the
      // first run's cleanup failed (or it died between marking and deleting), a
      // replay is our chance to remove the file instead of waiting for the janitor.
      try {
        await deps.cleanupRawAudio(event);
      } catch (err) {
        report(err, event);
      }
      return;
    }

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
      finalizeConv(closed);
      openConversationId = null;
    }

    // Whether self is VOICE-enrolled (has an embedding to match), computed once:
    // a label-only enroll-self can never match live audio, so the mic heuristic
    // must remain the wearer signal until voice enrollment lands.
    const selfVoiceEnrolled =
      deps.diarizer !== undefined && deps.diarizer.clusters().some((c) => c.isSelf && c.embeddingCount > 0);
    // Build base segments WITHOUT diarization; diarization is applied lazily per
    // group below, only for groups that will actually be appended, so a partial
    // replay never re-embeds an already-applied group (which would corrupt its
    // speaker centroid/count). Each base segment carries its raw segment for the
    // lazy embedding.
    const built: Array<{ seg: AssemblySegment; raw: TranscribedSegment }> = [];
    for (const s of raw) {
      const text = s.text.trim();
      if (text === "") continue;
      built.push({
        seg: { channel: event.channel, text, startUtc: s.startUtc, endUtc: s.endUtc, isWearer: event.channel === "mic" },
        raw: s,
      });
    }

    if (built.length > 0) {
      // Segments usually land in one conversation, but a gap >= threshold (or
      // conversationGapMinutes = 0) can split them intra-chunk. Group by the
      // conversation the assembler places each segment in.
      const groups: Array<{
        id: string;
        startedAtUtc: string;
        items: Array<{ seg: AssemblySegment; raw: TranscribedSegment }>;
      }> = [];
      for (const item of built) {
        const conv = deps.assembler.add(item.seg);
        const last = groups[groups.length - 1];
        if (last && last.id === conv.id) last.items.push(item);
        else groups.push({ id: conv.id, startedAtUtc: conv.startedAtUtc, items: [item] });
      }
      // Append each group, finalizing a conversation only once we move past it
      // (AFTER its rows are appended). A group already applied in a prior run is
      // skipped so the SAME chunk's later, unpersisted groups still append.
      for (let g = 0; g < groups.length; g++) {
        const grp = groups[g];
        const key = groups.length === 1 ? chunkId : `${chunkId}:${g}`;
        if (deps.spool.isChunkApplied(key)) {
          openConversationId = grp.id;
          continue;
        }
        if (openConversationId !== null && openConversationId !== grp.id) {
          finalizeConv(openConversationId);
        }
        // Diarize this group now (lazily), only because it will be appended.
        if (deps.embed && deps.diarizer) {
          for (const item of grp.items) {
            const embedding = await deps.embed(event, item.raw);
            const clusterId = deps.diarizer.assign(embedding);
            const assigned = deps.diarizer.clusters().find((c) => c.id === clusterId);
            let isWearer = assigned?.isSelf ?? false;
            // Label-only self can't match live audio: keep the mic=wearer heuristic.
            if (!isWearer && event.channel === "mic" && !selfVoiceEnrolled) isWearer = true;
            item.seg.isWearer = isWearer;
            item.seg.speakerCluster = clusterId;
          }
        }
        deps.spool.appendAssembledSegments({
          idempotencyKey: key,
          chunkId: key,
          conversationId: grp.id,
          startedAtUtc: grp.startedAtUtc,
          state: "capturing",
          device: event.device,
          wavPath: event.path,
          segments: grp.items.map((it) => it.seg),
        });
        // Persist any speaker clusters referenced by the just-appended segments
        // immediately, so a kill-9 after this durable append cannot lose the
        // cluster map and let the next voice reuse an id (mis-attribution).
        if (deps.diarizer) {
          const touched = new Set(
            grp.items.map((it) => it.seg.speakerCluster).filter((id): id is string => typeof id === "string"),
          );
          if (touched.size > 0) {
            const byId = new Map(deps.diarizer.clusters().map((c) => [c.id, c]));
            for (const cid of touched) {
              const c = byId.get(cid);
              if (c) {
                deps.spool.upsertSpeaker({
                  id: c.id,
                  label: c.label,
                  isSelf: c.isSelf,
                  embeddingCount: c.embeddingCount,
                  centroid: c.centroid,
                  examples: c.examples,
                });
              }
            }
          }
        }
        openConversationId = grp.id;
      }
    }

    // Mark the whole chunk complete only when it is safe: either we processed
    // real segments this run (so every group of this chunk is now applied), or
    // it is a genuinely fresh silent chunk with no prior partial application. A
    // zero-segment run over a chunk whose earlier groups were already applied
    // (a partial crash) must NOT be marked done, or the missing tail groups
    // would be stranded forever.
    const chunkFullyProcessed = built.length > 0 || !deps.spool.isChunkApplied(`${chunkId}:0`);
    if (chunkFullyProcessed) {
      deps.spool.markChunkComplete(chunkId, openConversationId ?? "-");
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
    // Dedup EVERY still-capturing conversation before the bulk flip to final —
    // including one left by a crashed prior run that this process never touched
    // (so it has no in-memory openConversationId) — so the served (final-only)
    // output never contains a loopback duplicate.
    for (const id of deps.spool.capturingConversationIds()) dedupeConversation(id);
    return deps.spool.finalizeOpenConversations();
  }

  return { enqueue, drain, finalize };
}
