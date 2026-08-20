/**
 * Fallback selection for the daily journal recap (issue #2051).
 *
 * Picks the journal body in precedence order: AI render, then the last stored
 * journal, then the deterministic render. A blank body at any level falls
 * through to the next one, so a provider failure never replaces a stored good
 * journal with a thinner deterministic render. This function takes no card
 * list and performs no writes, so discarding deterministic source cards is not
 * something it can do; storage callers own that decision.
 *
 * Pure: no I/O, no clock. Does not mutate its input. Internal helper; wiring
 * into the recap build path is a later slice.
 */

export const RECAP_SOURCE_KINDS = ["ai", "deterministic", "previous"] as const;
export type RecapSourceKind = (typeof RECAP_SOURCE_KINDS)[number];

export interface RecapCandidate {
  /** Rendered journal body. */
  body: string;
  kind: RecapSourceKind;
}

export type RecapSelection =
  | { ok: true; body: string; kind: RecapSourceKind; failure?: string }
  | { ok: false; error: "no_recap_available"; failure?: string };

const SLOT_ORDER: readonly RecapSourceKind[] = [
  "ai",
  "previous",
  "deterministic",
];

function isRecapSourceKind(value: unknown): value is RecapSourceKind {
  return (
    typeof value === "string" &&
    (RECAP_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

/** Select the journal body for one day. Throws TypeError on a bad kind. */
export function selectRecapForDay(input: {
  /** Present only when the AI run succeeded and validated. */
  ai?: RecapCandidate | null;
  /** Always available when cards exist: the deterministic render. */
  deterministic?: RecapCandidate | null;
  /** The last valid stored journal for this day, if any. */
  previous?: RecapCandidate | null;
  /** Typed failure kind from a provider error, when one occurred. */
  failure?: string | null;
}): RecapSelection {
  const failure =
    typeof input.failure === "string" && input.failure.trim() !== ""
      ? input.failure
      : undefined;

  for (const slot of SLOT_ORDER) {
    const candidate = input[slot];
    if (candidate == null) continue;

    const kind = candidate.kind;
    if (!isRecapSourceKind(kind)) {
      throw new TypeError(
        `unknown recap source kind: ${String(kind)}; allowed kinds: ${RECAP_SOURCE_KINDS.join(", ")}`,
      );
    }
    if (kind !== slot) {
      throw new TypeError(
        `recap candidate passed as "${slot}" has kind "${kind}"; kind must match its slot`,
      );
    }

    const body = candidate.body;
    if (typeof body !== "string") {
      throw new TypeError(
        `recap candidate body for slot "${slot}" must be a string`,
      );
    }
    if (body.trim() === "") continue;

    return failure === undefined
      ? { ok: true, body, kind }
      : { ok: true, body, kind, failure };
  }

  return failure === undefined
    ? { ok: false, error: "no_recap_available" }
    : { ok: false, error: "no_recap_available", failure };
}
