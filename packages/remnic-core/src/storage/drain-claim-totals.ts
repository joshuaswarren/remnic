/**
 * Cheap drain-claim totals for liveness surfaces (`/health.extraction`, #3442).
 *
 * The in-memory buffer snapshot misses every turn handed to a drain claim, so
 * health can report a tiny backlog while hundreds of thousands of turns sit in
 * `<stateDir>/buffer/drain/`. This reader answers "how much is claimed?" from
 * the `*.json.count` sidecars ALONE: it stats each claim body to validate the
 * sidecar's cached identity (size + mtime, the same rule `readSummary` uses)
 * and never parses a claim body — on the health path a body parse is exactly
 * the multi-GB cost we are avoiding, and stale/missing sidecars count as
 * `unverifiedClaims` instead of triggering one. It also never WRITES: summary
 * refreshes stay owned by the drain path (`readSummary`).
 *
 * Bounded: the sidecar scan stops after `maxClaims` bodies (`truncated: true`),
 * while `claimedSessions` still counts every body from the single readdir, so
 * the session count stays exact even when the scan is capped. Callers cache the
 * result (`BufferDrainClaims.claimTotals`) rather than re-scanning per request.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** How the reported oldest claimed age was derived. */
export type DrainClaimAgeBasis = "turn" | "claim-mtime-lower-bound";

export interface DrainClaimTotals {
  /** Claim bodies in the drain directory: every session handed to a drainer. */
  claimedSessions: number;
  /** Sum of `pending` over sidecars that still match their body's identity. */
  claimedPendingTurns: number;
  /**
   * Oldest oldest-turn candidate over claims with pending > 0; null when none
   * report one. Legacy sidecars (pre-#3442) contribute their BODY MTIME, which
   * is a true LOWER BOUND on the oldest turn's age: every claim-body mutation
   * is a whole-file rewrite, so mtime >= newest turn >= oldest turn.
   */
  oldestClaimedTurnAt: string | null;
  /** How `oldestClaimedTurnAt` was derived (see the field doc above). */
  oldestClaimedAgeBasis: DrainClaimAgeBasis | null;
  /** Sidecars read and identity-verified this scan. */
  verifiedSidecars: number;
  /** Bodies whose sidecar is missing, unparsable, or stale — excluded from the sums, never parsed to recover. */
  unverifiedClaims: number;
  /**
   * Claims with a non-empty pending-hand-in inbox (`.inbox.jsonl`): their
   * turns are pending but NOT in `claimedPendingTurns` (the sidecar counts
   * only the body), so the pending sum UNDERCOUNTS by this many claims'
   * worth. Each contributes its inbox mtime as a lower-bound age candidate:
   * appends only ever add content, so every inbox turn predates the last
   * append (mtime >= newest inbox turn >= oldest inbox turn).
   */
  claimsPendingInbox: number;
  /** The sidecar scan stopped at `maxClaims`; bodies past the cap are not summed. */
  truncated: boolean;
}

/** Default bound on bodies scanned per refresh (jarvis-ml evidence: ~2.4k claims). */
const DEFAULT_MAX_CLAIMS = 4_096;

/** Claim bodies are exactly `s-<64 hex>.json`; leases/locks/counts/inboxes carry suffixes. */
const CLAIM_BODY_PATTERN = /^s-[0-9a-f]{64}\.json$/;

/** The sidecar body contract; `oldestTurnAt` is absent in pre-#3442 sidecars. */
const sidecarSchema = z.object({
  size: z.number(),
  mtimeMs: z.number(),
  pending: z.number().nonnegative(),
  oldestTurnAt: z.string().optional(),
});

/**
 * A sidecar is trusted only while its cached body identity still matches;
 * any deviation (schema, identity, parse) reads as "unverified", never a crash.
 */
function verifiedSidecar(
  raw: string,
  identity: { size: number; mtimeMs: number },
): { pending: number; oldestTurnAt?: string } | null {
  let parsed: z.infer<typeof sidecarSchema>;
  try {
    parsed = sidecarSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
  if (parsed.size !== identity.size || parsed.mtimeMs !== identity.mtimeMs) return null;
  return { pending: parsed.pending, oldestTurnAt: parsed.oldestTurnAt };
}

export async function readDrainClaimTotals(
  claimsDir: string,
  opts: { maxClaims?: number } = {},
): Promise<DrainClaimTotals> {
  const totals: DrainClaimTotals = {
    claimedSessions: 0,
    claimedPendingTurns: 0,
    oldestClaimedTurnAt: null,
    oldestClaimedAgeBasis: null,
    verifiedSidecars: 0,
    unverifiedClaims: 0,
    claimsPendingInbox: 0,
    truncated: false,
  };
  let oldest: { ms: number; iso: string; basis: DrainClaimAgeBasis } | null = null;
  let bodies: string[];
  try {
    bodies = (await readdir(claimsDir)).filter((name) => CLAIM_BODY_PATTERN.test(name)).sort();
  } catch {
    // No claims directory yet: nothing has ever been claimed. Empty backlog.
    return totals;
  }
  totals.claimedSessions = bodies.length;
  const maxClaims = opts.maxClaims ?? DEFAULT_MAX_CLAIMS;
  if (bodies.length > maxClaims) {
    totals.truncated = true;
    bodies = bodies.slice(0, maxClaims);
  }
  for (const name of bodies) {
    const bodyPath = path.join(claimsDir, name);
    let identity;
    try {
      identity = await stat(bodyPath);
    } catch {
      totals.unverifiedClaims += 1;
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(`${bodyPath}.count`, "utf8");
    } catch {
      totals.unverifiedClaims += 1;
      continue;
    }
    const sidecar = verifiedSidecar(raw, { size: identity.size, mtimeMs: identity.mtimeMs });
    if (sidecar === null) {
      totals.unverifiedClaims += 1;
      continue;
    }
    totals.verifiedSidecars += 1;
    totals.claimedPendingTurns += sidecar.pending;
    // Hand-in inbox: appended after the body counts were cached, so a non-empty
    // inbox holds pending turns the sidecar does not know about. One extra
    // stat per claim, no parse — the file only ever grows by appends, so its
    // mtime is a lower bound on the oldest turn inside it.
    const inboxStat = await stat(`${bodyPath}.inbox.jsonl`).catch(() => null);
    const inboxPending = inboxStat !== null && inboxStat.size > 0;
    if (inboxPending) totals.claimsPendingInbox += 1;
    if (sidecar.pending > 0 || inboxPending) {
      // Oldest-age candidates. The sidecar's turn timestamp (when it parses,
      // else the body mtime as a lower bound — see DrainClaimTotals doc)
      // describes the body's turns only while pending > 0; the inbox mtime
      // covers the hand-ins. The per-claim minimum competes in the global
      // minimum with its own basis.
      const candidates: { ms: number; iso: string; basis: DrainClaimAgeBasis }[] = [];
      if (sidecar.pending > 0) {
        const turnIso = sidecar.oldestTurnAt;
        if (turnIso !== undefined) {
          const turnMs = Date.parse(turnIso);
          if (Number.isFinite(turnMs)) candidates.push({ ms: turnMs, iso: turnIso, basis: "turn" });
          else candidates.push({ ms: identity.mtimeMs, iso: new Date(identity.mtimeMs).toISOString(), basis: "claim-mtime-lower-bound" });
        } else {
          candidates.push({ ms: identity.mtimeMs, iso: new Date(identity.mtimeMs).toISOString(), basis: "claim-mtime-lower-bound" });
        }
      }
      if (inboxPending && inboxStat !== null) {
        candidates.push({ ms: inboxStat.mtimeMs, iso: new Date(inboxStat.mtimeMs).toISOString(), basis: "claim-mtime-lower-bound" });
      }
      const claimOldest = candidates.sort((a, b) => a.ms - b.ms)[0];
      if (claimOldest !== undefined && (oldest === null || claimOldest.ms < oldest.ms)) oldest = claimOldest;
    }
  }
  totals.oldestClaimedTurnAt = oldest?.iso ?? null;
  totals.oldestClaimedAgeBasis = oldest?.basis ?? null;
  return totals;
}
