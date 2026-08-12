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
import { CaptureInputError } from "./errors.js";
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
  /**
   * Bounded reorder window in ms for cross-channel arrival skew (issue
   * #2145). A transcribed chunk is HELD until the newest observed chunk end
   * is this far past its own end, then released oldest-first, so a delayed
   * system chunk is assembled into the conversation it temporally belongs to
   * rather than joined to a later mic chunk's. 0 (the default here, so
   * existing callers are unchanged) releases every chunk on arrival.
   */
  reorderWindowMs?: number;
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

/** One transcribed chunk waiting in the reorder buffer (issue #2145). */
interface BufferedChunk {
  event: ChunkEvent;
  chunkId: string;
  built: Array<{ seg: AssemblySegment; raw: TranscribedSegment }>;
  /** Earliest segment start, or the chunk's own start when it is silent. */
  startMs: number;
  /** Latest segment end, never earlier than the chunk's own end. */
  endMs: number;
}

/**
 * Epoch ms for an instant the native layer already validated. A value that
 * cannot be parsed would silently sort first and defeat the reorder buffer,
 * so it is rejected instead.
 */
function instantMs(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new CaptureInputError(`${field}: expected an ISO-8601 instant, got ${JSON.stringify(value)}`);
  }
  return ms;
}

function firstStartMs(event: ChunkEvent, raw: readonly TranscribedSegment[]): number {
  let earliest = instantMs(event.startedAtUtc, "chunk.startedAtUtc");
  for (const segment of raw) {
    earliest = Math.min(earliest, instantMs(segment.startUtc, "segment.startUtc"));
  }
  return earliest;
}

function lastEndMs(event: ChunkEvent, raw: readonly TranscribedSegment[]): number {
  let latest = instantMs(event.endedAtUtc, "chunk.endedAtUtc");
  for (const segment of raw) {
    latest = Math.max(latest, instantMs(segment.endUtc, "segment.endUtc"));
  }
  return latest;
}

export function createChunkProcessor(deps: ChunkProcessorDeps): ChunkProcessor {
  let tail: Promise<void> = Promise.resolve();
  let recovered = false;
  let openConversationId: string | null = null;
  const processedThisRun = new Set<string>();
  // Bounded reorder buffer (issue #2145). With `captureChannel: "both"` the
  // native helper emits one chunk stream per channel, and a system chunk for
  // an earlier window can arrive AFTER a later mic chunk. Feeding the
  // assembler in arrival order then joins the delayed (earlier) segment to a
  // conversation that started after it. Chunks are held here until the newest
  // observed chunk end is `reorderWindowMs` past their own end, then released
  // oldest-first, so the assembler always sees a chronological stream.
  //
  // A HELD chunk is not marked complete and keeps its WAV, so a crash before
  // release replays it from the raw audio — the same durability contract as
  // an untranscribed chunk.
  const reorderWindowMs = Math.max(0, deps.reorderWindowMs ?? 0);
  const buffer: BufferedChunk[] = [];
  const bufferedIds = new Set<string>();
  let watermarkSourceMs = Number.NEGATIVE_INFINITY;
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
  /**
   * Cluster one conversation's surviving segments (issue #2145).
   *
   * Runs AFTER dedup, so a pruned mic loopback contributes nothing: no
   * inflated `embeddingCount`, no phantom cluster for a speaker that already
   * exists. Only rows that still have no cluster are assigned, so a repeated
   * finalize is idempotent. Diarization is therefore a pure function of the
   * deduped segment set, independent of cross-channel arrival order.
   */
  const diarizeConversation = (id: string): void => {
    const diarizer = deps.diarizer;
    if (!diarizer) return;
    const pending = deps.spool.conversationSegmentsForDiarization(id);
    if (pending.length === 0) return;
    // A label-only enrolled self can never match live audio, so the mic
    // heuristic stays the wearer signal until voice enrollment lands.
    const selfVoiceEnrolled = diarizer.clusters().some((c) => c.isSelf && c.embeddingCount > 0);
    const assignments: Array<{ id: string; speakerCluster: string; isWearer: boolean }> = [];
    const touched = new Set<string>();
    for (const segment of pending) {
      const clusterId = diarizer.assign(segment.embedding);
      const assigned = diarizer.clusters().find((c) => c.id === clusterId);
      const isWearer =
        (assigned?.isSelf ?? false) || (segment.channel === "mic" && !selfVoiceEnrolled);
      assignments.push({ id: segment.id, speakerCluster: clusterId, isWearer });
      touched.add(clusterId);
    }
    // Clusters first: a segment row must never reference a cluster that is
    // not persisted yet, so a crash between the two leaves the segments
    // unassigned and the next finalize redoes them.
    const byId = new Map(diarizer.clusters().map((c) => [c.id, c]));
    for (const clusterId of touched) {
      const cluster = byId.get(clusterId);
      if (!cluster) continue;
      deps.spool.upsertSpeaker({
        id: cluster.id,
        label: cluster.label,
        isSelf: cluster.isSelf,
        embeddingCount: cluster.embeddingCount,
        centroid: cluster.centroid,
        examples: cluster.examples,
      });
    }
    deps.spool.assignSegmentSpeakers(assignments);
  };
  const finalizeConv = (id: string): void => {
    dedupeConversation(id);
    diarizeConversation(id);
    deps.spool.finalizeConversation(id);
  };

  const report = (error: unknown, event: ChunkEvent): void => {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)), event);
  };

  async function process(event: ChunkEvent): Promise<void> {
    const chunkId = chunkStableId(event);
    // In-run replay: already applied, or already transcribed and waiting in
    // the reorder buffer. Either way this event carries nothing new.
    if (processedThisRun.has(chunkId) || bufferedIds.has(chunkId)) return;
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
    buffer.push({
      event,
      chunkId,
      built: buildSegments(event, raw),
      startMs: firstStartMs(event, raw),
      endMs: lastEndMs(event, raw),
    });
    bufferedIds.add(chunkId);
    watermarkSourceMs = Math.max(watermarkSourceMs, lastEndMs(event, raw));
    await releaseReady(false);
  }

  /** Build the base (undiarized) segments for one chunk's raw transcript. */
  function buildSegments(
    event: ChunkEvent,
    raw: readonly TranscribedSegment[],
  ): Array<{ seg: AssemblySegment; raw: TranscribedSegment }> {
    const built: Array<{ seg: AssemblySegment; raw: TranscribedSegment }> = [];
    for (const s of raw) {
      const text = s.text.trim();
      if (text === "") continue;
      built.push({
        seg: {
          channel: event.channel,
          text,
          startUtc: s.startUtc,
          endUtc: s.endUtc,
          isWearer: event.channel === "mic",
        },
        raw: s,
      });
    }
    return built;
  }

  /**
   * Apply one buffered chunk: assemble, append, mark complete, reclaim the
   * WAV. Everything here runs on the RELEASE timeline, not the arrival
   * timeline, so a delayed chunk is assembled at its own place in time.
   */
  async function applyChunk(entry: BufferedChunk): Promise<void> {
    const { event, chunkId, built } = entry;
    // Recover the newest still-open conversation once (any chunk, incl. silent)
    // so a post-restart chunk continues it; then finalize a stale open
    // conversation when this chunk is released a gap past it. Pure-silence runs
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
        // Embed now — this is where the audio exists — but do NOT cluster.
        // Clustering runs at finalize over the segments that SURVIVE
        // cross-channel dedup (issue #2145), so a mic loopback duplicate that
        // is later pruned can no longer inflate a centroid or invent a
        // phantom speaker. The embedding rides along on the segment row.
        if (deps.embed) {
          for (const item of grp.items) {
            item.seg.embedding = await deps.embed(event, item.raw);
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
    processedThisRun.add(chunkId);
    if (chunkFullyProcessed) {
      // The chunk is fully durably transcribed: record completion and reclaim
      // the raw WAV. A partial chunk (earlier groups applied, this run added
      // nothing) must RETAIN its WAV so a later full replay can still transcribe
      // the missing tail groups. Cleanup is best-effort; the janitor is the backstop.
      deps.spool.markChunkComplete(chunkId, openConversationId ?? "-");
      try {
        await deps.cleanupRawAudio(event);
      } catch (err) {
        report(err, event);
      }
    }
  }

  /**
   * Release every buffered chunk the watermark has passed, oldest first.
   *
   * Release is whole-chunk: a chunk's own segments are already chronological,
   * and holding until its END clears the watermark is what makes the released
   * stream chronological ACROSS chunks. Whole-chunk release also keeps the
   * per-chunk idempotency keys (`chunkId`, `chunkId:g`, `chunkId:done`)
   * exactly as they were, so replay and crash recovery are unchanged.
   *
   * `flushAll` ignores the watermark, for `finalize()`.
   */
  async function releaseReady(flushAll: boolean): Promise<void> {
    const threshold = flushAll ? Number.POSITIVE_INFINITY : watermarkSourceMs - reorderWindowMs;
    for (;;) {
      const readyIndex = pickNextReleasable(threshold);
      if (readyIndex === -1) return;
      const [entry] = buffer.splice(readyIndex, 1);
      if (entry === undefined) return;
      bufferedIds.delete(entry.chunkId);
      try {
        await applyChunk(entry);
      } catch (error) {
        report(error, entry.event);
      }
    }
  }

  /**
   * Index of the oldest releasable chunk, or -1. Ordering is by first
   * segment start, then chunk end, then id: a total comparator, so the
   * release order is identical across runs (rule 12).
   */
  function pickNextReleasable(threshold: number): number {
    let best = -1;
    for (let i = 0; i < buffer.length; i++) {
      const candidate = buffer[i];
      if (candidate.endMs > threshold) continue;
      if (best === -1) {
        best = i;
        continue;
      }
      const incumbent = buffer[best];
      if (
        candidate.startMs < incumbent.startMs ||
        (candidate.startMs === incumbent.startMs &&
          (candidate.endMs < incumbent.endMs ||
            (candidate.endMs === incumbent.endMs && candidate.chunkId < incumbent.chunkId)))
      ) {
        best = i;
      }
    }
    return best;
  }

  function enqueue(event: ChunkEvent): void {
    tail = tail.then(() => process(event)).catch((error) => report(error, event));
  }

  function drain(): Promise<void> {
    return tail.then(() => undefined);
  }

  async function finalize(): Promise<number> {
    // Flush the reorder buffer ON the serialized chain, so a chunk still
    // arriving cannot interleave with the flush.
    tail = tail.then(() => releaseReady(true));
    await drain();
    deps.assembler.finalize();
    // Dedup then cluster EVERY still-capturing conversation before the bulk
    // flip to final — including one left by a crashed prior run that this
    // process never touched (so it has no in-memory openConversationId) — so
    // the served (final-only) output never contains a loopback duplicate and
    // every surviving segment carries its speaker.
    for (const id of deps.spool.capturingConversationIds()) {
      dedupeConversation(id);
      diarizeConversation(id);
    }
    return deps.spool.finalizeOpenConversations();
  }

  return { enqueue, drain, finalize };
}
