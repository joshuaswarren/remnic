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

import { log } from "@remnic/core/logger";

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
/**
 * Stable per-segment idempotency key.
 *
 * Derived from the segment's CONTENT — its bounds and text — not its position.
 * An index is not an identity: a retranscription that changes segment
 * boundaries, or inserts a segment before a partially committed prefix, would
 * bind an existing key to different audio (issue #2145). Content survives
 * both, so a key always means the same bytes.
 */
export function segmentStableKey(chunkId: string, segment: { startUtc: string; endUtc: string; text: string }): string {
  const digest = createHash("sha1")
    .update(`${segment.startUtc}\u0000${segment.endUtc}\u0000${segment.text}`)
    .digest("hex")
    .slice(0, 16);
  return `${chunkId}:h${digest}`;
}

/**
 * Marker key describing a chunk's WHOLE transcript.
 *
 * A segment count is too weak a manifest: a replay that returns the same
 * number of DIFFERENT segments would match it and let a partially applied
 * chunk be marked complete with mixed content. Hashing every segment key
 * catches both a shortened and a changed transcript (issue #2145).
 */
export function transcriptManifestKey(
  chunkId: string,
  segments: readonly { startUtc: string; endUtc: string; text: string }[],
): string {
  const digest = createHash("sha1")
    .update(segments.map((segment) => segmentStableKey(chunkId, segment)).join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `${chunkId}:m${digest}`;
}

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
  // Set when a chunk is deliberately left unapplied for a later replay: its
  // conversation must stay `capturing` so that replay can resume it.
  let retainedForReplay = false;
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
    // `assign` mutates the in-memory centroids and counts. If the commit rolls
    // back, those mutations must roll back too — otherwise the retry counts
    // the same embeddings against an already-advanced clusterer and persists
    // skewed snapshots. The snapshot below is the undo log.
    const before = diarizer.clusters();
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
    // ONE transaction: a crash between persisting the cluster counts and
    // persisting the assignments would leave the counts advanced while the
    // segments still look pending, and the next finalize would count the same
    // embeddings again (issue #2145).
    const byId = new Map(diarizer.clusters().map((c) => [c.id, c]));
    const clusters = [...touched]
      .map((clusterId) => byId.get(clusterId))
      .filter((cluster): cluster is NonNullable<typeof cluster> => cluster !== undefined)
      .map((cluster) => ({
        id: cluster.id,
        label: cluster.label,
        isSelf: cluster.isSelf,
        embeddingCount: cluster.embeddingCount,
        centroid: cluster.centroid,
        examples: cluster.examples,
      }));
    try {
      deps.spool.commitDiarization({ clusters, assignments });
    } catch (err) {
      // Restore the clusterer to its pre-assign state so the next finalize
      // starts from the same place SQLite did.
      diarizer.restore(before);
      throw err;
    }
  };
  const finalizeConv = (id: string): void => {
    dedupeConversation(id);
    diarizeConversation(id);
    deps.spool.finalizeConversation(id);
  };

  const report = (error: unknown, event: ChunkEvent): void => {
    // A throwing operator callback must not become a pipeline failure: it would
    // propagate into the serialized chain and stall every later chunk.
    try {
      deps.onError?.(error instanceof Error ? error : new Error(String(error)), event);
    } catch {
      // nothing left to report it to
    }
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

    // Pre-#2145 runs keyed appends per GROUP (`chunkId` or `chunkId:<n>`).
    // Those keys cannot be mapped onto the new per-segment keys, so a chunk
    // carrying one is treated as already applied: re-appending under new keys
    // would duplicate its segments, which is worse than leaving the tail of
    // one in-flight chunk unsent across the upgrade.
    if (deps.spool.isChunkApplied(chunkId) || deps.spool.isChunkApplied(`${chunkId}:0`)) {
      // Legacy group keys prove only that SOME group persisted, so this chunk
      // is left strictly alone: not re-appended (which would duplicate the
      // stored groups), and not marked done or reclaimed (which would discard
      // an unpersisted tail). The WAV stays for a rebuild or manual replay,
      // and the operator is told once.
      processedThisRun.add(chunkId);
      log.warn(
        `[capture-audio] chunk ${chunkId} was partially applied under the pre-#2145 key scheme; leaving it and its raw audio in place for replay`,
      );
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
    const built = buildSegments(event, raw);
    buffer.push({
      event,
      chunkId,
      built,
      startMs: firstStartMs(event, raw),
      endMs: lastEndMs(event, raw),
    });
    bufferedIds.add(chunkId);
    // Recorded AFTER buffering (so a throw here cannot drop the helper's
    // one-shot event) but BEFORE any append, and only once: this is the fact a
    // later replay cannot re-derive, so it must survive a failure partway
    // through appending this chunk (issue #2145).
    if (built.length > 0 && !deps.spool.hasAppliedChunkPrefix(`${chunkId}:m`)) {
      try {
        deps.spool.markApplied(transcriptManifestKey(chunkId, built.map((item) => item.seg)), "-");
      } catch (err) {
        report(err, event);
      }
    }
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
   * Apply one batch of released chunks.
   *
   * Whole-chunk release alone is not enough: two chunks can COVER THE SAME
   * WINDOW on different channels, so a mic segment at 00:00 and 00:20 must not
   * be applied ahead of a system segment at 00:10 (issue #2145). The batch's
   * segments are therefore interleaved into one chronological stream, fed to
   * the assembler in that order, and appended as runs that each belong to one
   * chunk — so the per-chunk idempotency keys (`chunkId`, `chunkId:g`,
   * `chunkId:done`) keep their existing shape and a lone chunk still uses the
   * bare `chunkId` exactly as before.
   *
   * Everything here runs on the RELEASE timeline, not the arrival timeline.
   */
  async function applyBatch(
    batch: readonly BufferedChunk[],
    progress: { persisted: boolean },
  ): Promise<void> {
    // Recover the newest still-open conversation once (any chunk, incl. silent)
    // so a post-restart chunk continues it; then finalize a stale open
    // conversation when this batch is released a gap past it. Pure-silence runs
    // never call assembler.add, so closeIfIdle is what closes them.
    if (!recovered) {
      recovered = true;
      const prior = deps.spool.latestCapturingConversation();
      if (prior) {
        deps.assembler.resume(prior);
        openConversationId = prior.id;
      }
    }
    const earliestStart = batch.reduce(
      (earliest, entry) => (entry.startMs < earliest.startMs ? entry : earliest),
      batch[0],
    );
    const closed = deps.assembler.closeIfIdle(earliestStart.event.startedAtUtc);
    if (closed !== null && closed === openConversationId) {
      // Dedupes, diarizes and flips a conversation in the spool — durable, so
      // the caller must not rewind past it. Flagged AFTER the call: a throw
      // inside it leaves nothing durable, and the batch should still rewind.
      finalizeConv(closed);
      progress.persisted = true;
      openConversationId = null;
    }

    // One chronological stream across the batch. The comparator is total —
    // start, then end, then chunk id, then position — so the same batch always
    // interleaves the same way (rule 12).
    const stream = batch
      .flatMap((entry) =>
        entry.built.map((item, index) => ({ entry, item, index })),
      )
      .sort((left, right) => {
        if (left.item.seg.startUtc !== right.item.seg.startUtc) {
          return left.item.seg.startUtc < right.item.seg.startUtc ? -1 : 1;
        }
        if (left.item.seg.endUtc !== right.item.seg.endUtc) {
          return left.item.seg.endUtc < right.item.seg.endUtc ? -1 : 1;
        }
        if (left.entry.chunkId !== right.entry.chunkId) {
          return left.entry.chunkId < right.entry.chunkId ? -1 : 1;
        }
        return left.index - right.index;
      });

    // Durable segments leave the stream before anything else touches them: a
    // replay must not pay for their embedding again, and an input-specific
    // embedding failure on an already-persisted segment would requeue the
    // batch forever and block the segments that ARE missing (issue #2145).
    const fresh = stream.filter(
      ({ entry, item }) => !deps.spool.isChunkApplied(segmentStableKey(entry.chunkId, item.seg)),
    );


    // Embed before a single `assembler.add`. Embedding is the only await that
    // can throw before persistence, and the assembler has no undo: a throw
    // after it had consumed segments would leave it advanced.
    if (deps.embed) {
      for (const { entry, item } of fresh) {
        item.seg.embedding = await deps.embed(entry.event, item.raw);
      }
    }

    // Assign conversations over the interleaved stream, then cut it into runs
    // that each belong to ONE chunk and ONE conversation. The runs are already
    // in chronological order, so a conversation is only finalized once the
    // stream has truly moved past it.
    //
    // Already-applied segments are dropped BEFORE the assembler sees them.
    // They live in a durable conversation already, so re-adding them would
    // either duplicate in-memory state or — if the assembler were rewound to
    // undo them — mint a second id for a conversation that is already on disk
    // and split it. Skipping is the only option that keeps the in-memory ids
    // and the persisted ids identical (issue #2145).
    const runs: Array<{
      entry: BufferedChunk;
      id: string;
      startedAtUtc: string;
      items: Array<{ seg: AssemblySegment; raw: TranscribedSegment; index: number }>;
    }> = [];
    for (const { entry, item, index } of fresh) {
      const conv = deps.assembler.add(item.seg);
      const carried = { ...item, index };
      const last = runs[runs.length - 1];
      if (last && last.id === conv.id && last.entry === entry) last.items.push(carried);
      else runs.push({ entry, id: conv.id, startedAtUtc: conv.startedAtUtc, items: [carried] });
    }

    // Idempotency keys are derived from each segment's position in ITS OWN
    // chunk, never from the batch: `chunkId:i<index>`. A key must mean the
    // same bytes on every replay, and a replay rarely reproduces the same
    // batch — so a positional `chunkId:g` could skip a group that now holds
    // different segments, or miss an applied one and append twice. One append
    // per segment costs one extra row per segment and makes the guard exact.
    for (const run of runs) {
      const { chunkId, event } = run.entry;
      for (const item of run.items) {
        const key = segmentStableKey(chunkId, item.seg);
        if (openConversationId !== null && openConversationId !== run.id) {
          finalizeConv(openConversationId);
          progress.persisted = true;
        }
        deps.spool.appendAssembledSegments({
          idempotencyKey: key,
          chunkId: key,
          conversationId: run.id,
          startedAtUtc: run.startedAtUtc,
          state: "capturing",
          device: event.device,
          wavPath: event.path,
          segments: [item.seg],
        });
        progress.persisted = true;
        openConversationId = run.id;
      }
    }

    for (const entry of batch) {
      // Mark the whole chunk complete only when it is safe: either we processed
      // real segments this run (so every run of this chunk is now applied), or
      // it is a genuinely fresh silent chunk with no prior partial application.
      // A zero-segment run over a chunk whose earlier groups were already
      // applied (a partial crash) must NOT be marked done, or the missing tail
      // groups would be stranded forever.
      // Completeness needs one fact a replay cannot re-derive: how many
      // segments the transcript produced the FIRST time. Without it, a shorter
      // retranscription is indistinguishable from a missing tail — mark done
      // and a tail can be lost, refuse and a fully-applied chunk
      // re-transcribes forever. So the count is persisted once and compared.
      // The manifest marker was written at transcribe time, so a mismatch here
      // means an EARLIER run produced a DIFFERENT transcript — shorter, or the
      // same length with different content. Either way a segment no run has
      // accounted for may be missing, so the chunk stays open and keeps its
      // audio.
      const manifestMatches = deps.spool.isChunkApplied(
        transcriptManifestKey(entry.chunkId, entry.built.map((item) => item.seg)),
      );
      const fullyProcessed =
        entry.built.length > 0
          ? manifestMatches
          : !deps.spool.hasAppliedChunkPrefix(`${entry.chunkId}:`);
      if (entry.built.length > 0 && !manifestMatches) {
        retainedForReplay = true;
        log.warn(
          `[capture-audio] chunk ${entry.chunkId} retranscribed to a different transcript than an earlier run; keeping its raw audio for replay`,
        );
      }
      processedThisRun.add(entry.chunkId);
      if (!fullyProcessed) continue;
      // The chunk is fully durably transcribed: record completion and reclaim
      // the raw WAV. A partial chunk (earlier groups applied, this run added
      // nothing) must RETAIN its WAV so a later full replay can still
      // transcribe the missing tail. Cleanup is best-effort; the janitor is
      // the backstop.
      deps.spool.markChunkComplete(entry.chunkId, openConversationId ?? "-");
      try {
        await deps.cleanupRawAudio(entry.event);
      } catch (err) {
        report(err, entry.event);
      }
    }
  }

  /**
   * Release every buffered chunk the watermark has passed, as one batch.
   *
   * A chunk becomes releasable when the newest observed chunk end is
   * `reorderWindowMs` past its own end. Releasing the whole releasable set
   * together is what lets `applyBatch` interleave overlapping cross-channel
   * windows; holding until the END clears the watermark is what bounds how far
   * out of order an arrival can be.
   *
   * `flushAll` ignores the watermark, for `finalize()`.
   */
  async function releaseReady(flushAll: boolean): Promise<void> {
    // A failed FINAL flush must reach the caller: `stop()` discards the buffer
    // afterwards, and reporting success would silently drop the retained
    // chunks (issue #2145). A mid-run failure stays reported-and-retried.
    let finalFailure: unknown;
    for (;;) {
      const threshold = flushAll ? Number.POSITIVE_INFINITY : watermarkSourceMs - reorderWindowMs;
      const batch: BufferedChunk[] = [];
      for (let i = buffer.length - 1; i >= 0; i--) {
        const candidate = buffer[i];
        if (candidate.endMs > threshold) continue;
        buffer.splice(i, 1);
        bufferedIds.delete(candidate.chunkId);
        batch.push(candidate);
      }
      if (batch.length === 0) return;
      // Total order so the same batch always applies the same way (rule 12).
      batch.sort(
        (left, right) =>
          left.startMs - right.startMs ||
          left.endMs - right.endMs ||
          (left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0),
      );
      // Rewind only matters when NOTHING durable changed: then the in-memory
      // state is ahead of the spool and the retry would collapse conversations
      // the first attempt split. Once anything is durable — an appended
      // segment OR a finalized conversation — the spool cannot be rewound, so
      // neither is the memory that mirrors it (issue #2145).
      //
      // The snapshot covers every piece of in-memory state `applyBatch`
      // touches, not just the assembler: `resume()` and `openConversationId`
      // are set inside it too, and rewinding the assembler alone would leave
      // the recovery flags claiming a conversation the assembler no longer has.
      const checkpoint = {
        assembler: deps.assembler.checkpoint(),
        recovered,
        openConversationId,
      };
      const progress = { persisted: false };
      try {
        await applyBatch(batch, progress);
      } catch (error) {
        if (!progress.persisted) {
          deps.assembler.rewind(checkpoint.assembler);
          recovered = checkpoint.recovered;
          openConversationId = checkpoint.openConversationId;
        }
        // Requeue FIRST: `report` runs an operator callback that may itself
        // throw, and losing the batch to a broken telemetry sink would turn an
        // observer failure into data loss. A throw mid-batch leaves the chunks
        // after the failure point applied to nothing — they were already
        // spliced out of the buffer, and the native helper emits each event
        // once (issue #2145).
        for (const entry of batch) {
          if (processedThisRun.has(entry.chunkId) || bufferedIds.has(entry.chunkId)) continue;
          buffer.push(entry);
          bufferedIds.add(entry.chunkId);
        }
        if (flushAll) finalFailure ??= error;
        report(error, batch[0].event);
        if (finalFailure !== undefined) throw finalFailure;
        return;
      }
    }
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
    // `report` runs an operator-supplied callback that may itself throw, so the
    // chain is recovered explicitly: a rejected `tail` would make every later
    // drain/finalize reject with the same stale error (AGENTS.md #28).
    const flush = tail.then(() => releaseReady(true));
    tail = flush.catch(() => undefined);
    // A failed flush must NOT skip the sweep: shutdown flips whatever is left
    // to `final`, and skipping would serve conversations that were never
    // deduped or diarized. Run the sweep, then report the flush failure.
    let flushFailure: unknown;
    try {
      await flush;
    } catch (error) {
      flushFailure = error;
    }
    // A failed flush left chunks in the buffer that may belong to the open
    // conversation. Closing it now would strand them: a retry or a raw-WAV
    // replay would open a NEW conversation instead of joining the original.
    // The sweep below still dedupes and diarizes, so anything a later
    // shutdown flips is clean.
    const holdOpen = flushFailure !== undefined || retainedForReplay;
    if (!holdOpen) deps.assembler.finalize();
    // Dedup then cluster EVERY still-capturing conversation before the bulk
    // flip to final — including one left by a crashed prior run that this
    // process never touched (so it has no in-memory openConversationId) — so
    // the served (final-only) output never contains a loopback duplicate and
    // every surviving segment carries its speaker.
    let sweepFailure: unknown;
    let closed = 0;
    for (const id of deps.spool.capturingConversationIds()) {
      try {
        dedupeConversation(id);
        // Diarization is deferred while a flush failure means segments are
        // still buffered: clustering only ever ADDS, so embedding a mic copy
        // whose system duplicate has not arrived yet would leave that copy's
        // contribution in the centroid after dedup deletes the segment.
        if (flushFailure === undefined) diarizeConversation(id);
        // Flipped per conversation, not in bulk: a conversation whose
        // diarization failed must STAY capturing so a later finalize retries
        // it, while the ones that succeeded still reach the final-only read
        // path instead of being stranded behind it.
        if (!holdOpen && deps.spool.finalizeConversation(id)) closed++;
      } catch (error) {
        sweepFailure ??= error;
      }
    }
    // The bulk flip only catches conversations created after the id snapshot
    // above. Skipping it when the sweep failed is what keeps the FAILED
    // conversation `capturing` for the next finalize to retry.
    const total =
      sweepFailure === undefined && !holdOpen ? closed + deps.spool.finalizeOpenConversations() : closed;
    if (flushFailure !== undefined) throw flushFailure;
    if (sweepFailure !== undefined) throw sweepFailure;
    return total;
  }

  return { enqueue, drain, finalize };
}
