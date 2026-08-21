/**
 * Observe-derived transcript persistence (issue #2783).
 *
 * Delegate-mode gateways POST every turn to `/observe`; without a transcript
 * append in the daemon's observe path the transcript store never grows and
 * the hourly summarizer starves silently while every run reports ok. This
 * module is that append: it mirrors the embedded runtime's `agent_end`
 * handler (src/index.ts) — same `TranscriptManager`, same entry shape, same
 * `transcriptEnabled` presentation gate, same 10-char noise floor.
 *
 * Turns are deduped against a bounded process-lifetime (session, role,
 * content) fingerprint — the daemon-side equivalent of the embedded
 * runtime's `observedInboundContentFingerprints`, extended to both roles
 * because an un-keyed client re-POST always carries the whole turn — so a
 * retry cannot double-write it.
 */

import { randomUUID } from "node:crypto";
import { log } from "./logger.js";
import type { Orchestrator } from "./orchestrator.js";
import type { TranscriptEntry } from "./types.js";

const OBSERVE_TRANSCRIPT_DEDUPE_MAX_ENTRIES = 8192;
const OBSERVE_TRANSCRIPT_MIN_CONTENT_CHARS = 10;

/** Bounded FIFO of seen fingerprints; insertion order is the eviction order. */
export class ObserveTranscriptPersister {
  private readonly seenFingerprints = new Set<string>();

  /**
   * Append every eligible message of an observe payload to the per-session
   * transcript store. Best-effort: a failing append logs and does not fail
   * the observe. Returns true when at least one turn was appended.
   */
  async persist(orchestrator: Orchestrator, sessionKey: string, messages: ReadonlyArray<{ role: string; content: string }>): Promise<boolean> {
    let persisted = false;
    for (const message of messages) {
      if (message.content.length < OBSERVE_TRANSCRIPT_MIN_CONTENT_CHARS) continue;
      const fingerprint = `${sessionKey}\0${message.role}\0${message.content}`;
      if (this.seenFingerprints.has(fingerprint)) continue;
      this.remember(fingerprint);
      const entry: TranscriptEntry = {
        timestamp: new Date().toISOString(),
        role: message.role as TranscriptEntry["role"],
        content: message.content,
        sessionKey,
        turnId: randomUUID(),
      };
      try {
        await orchestrator.transcript.append(entry);
        persisted = true;
      } catch (err) {
        // Same policy as the LCM enqueue in the observe path: transcript
        // persistence must never fail the observe itself.
        log.error(`access-observe transcript append failed: ${err}`);
      }
    }
    return persisted;
  }

  private remember(fingerprint: string): void {
    this.seenFingerprints.add(fingerprint);
    if (this.seenFingerprints.size > OBSERVE_TRANSCRIPT_DEDUPE_MAX_ENTRIES) {
      const oldest = this.seenFingerprints.keys().next().value;
      if (typeof oldest === "string") this.seenFingerprints.delete(oldest);
    }
  }
}
