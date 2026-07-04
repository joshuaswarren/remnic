/**
 * Local-lab sequential phase scheduler (issue #1573 PR2).
 *
 * On a single-GPU lab box (e.g. RTX 3090, 24 GB VRAM) the responder and
 * judge models cannot be co-resident: the harness runs them in two distinct
 * phases, with the operator physically swapping which model is loaded
 * between them. The harness DOES NOT manage model processes — it tells the
 * operator what to do and waits for them to confirm via the next phase's
 * endpoint preflight succeeding.
 *
 * The scheduler:
 *
 *   1. Preflights the phase's endpoint (reachable + serving the manifest
 *      model with enough context — see `preflight.ts`). Hard error on
 *      mismatch; no silent fallback.
 *   2. Calls the phase's `execute()` callback — the runner supplies the
 *      actual ingest/answer or judge work; the scheduler only sequences.
 *   3. Between phases prints the operator hand-off note from
 *      `manifest.notes.responderToJudgeHandoff`, OR proceeds silently when
 *      the next phase's endpoint is the same baseUrl (Ollama can hot-swap
 *      models within one endpoint, so no physical swap is needed).
 *
 * `execute` receives the resolved role so the runner can build the right
 * provider config without re-reading the manifest. The phase scheduler is
 * intentionally process-supervision-free per the issue's "do not add
 * process supervision in v1" instruction.
 */

import type { LocalLabManifest, LocalLabRoleConfig } from "./manifest.js";
import type { ResolvedLocalLabRole } from "./resolve-local-lab-profile.js";
import { resolveLocalLabRole } from "./resolve-local-lab-profile.js";
import {
  preflightLocalLabRole,
  type LocalLabPreflightOptions,
  type LocalLabPreflightResult,
} from "./preflight.js";

export type LocalLabPhaseName = "responder" | "judge" | "embedding";

export interface LocalLabPhaseDescriptor {
  name: LocalLabPhaseName;
  role: LocalLabRoleConfig;
}

/**
 * A unit of phase work supplied by the runner. The callback receives the
 * phase's resolved role so the caller can build its own provider/client
 * without re-reading the manifest. Returning a value (e.g. judge verdicts)
 * is supported; the scheduler does not inspect it.
 */
export type LocalLabPhaseExecute<T = unknown> = (
  role: ResolvedLocalLabRole,
) => Promise<T>;

export interface LocalLabPhase<T = unknown> {
  name: LocalLabPhaseName;
  role: LocalLabRoleConfig;
  execute: LocalLabPhaseExecute<T>;
}

export interface LocalLabPhaseOutcome<T> {
  phase: LocalLabPhaseDescriptor;
  preflight: LocalLabPreflightResult;
  result: T;
}

export interface SequentialPhaseHooks {
  /**
   * Called after a phase's preflight succeeds but before its `execute`.
   * Useful for logging "phase X starting against <endpoint>".
   */
  onPhasePreflight?: (result: LocalLabPreflightResult) => void;
  /** Called immediately before invoking the phase's execute callback. */
  onPhaseStart?: (phase: LocalLabPhaseDescriptor) => void;
  /** Called immediately after a phase's execute resolves. */
  onPhaseComplete?: <T>(outcome: LocalLabPhaseOutcome<T>) => void;
  /**
   * Called between two phases when their endpoints differ. Receives the
   * manifest hand-off note (or undefined). The scheduler does NOT print to
   * stdout itself — it delegates to this hook so tests can observe it
   * without capturing process output.
   */
  onPhaseHandoff?: (
    from: LocalLabPhaseDescriptor,
    to: LocalLabPhaseDescriptor,
    note: string | undefined,
  ) => void;
}

export interface RunSequentialPhasesOptions {
  /** Forwarded to each phase's preflight. */
  preflight?: LocalLabPreflightOptions;
  hooks?: SequentialPhaseHooks;
}

/**
 * Normalize a baseUrl for endpoint-sameness comparison. Strips a single
 * trailing slash so `…/v1` and `…/v1/` compare equal — exactly matching the
 * one-slash trim `discoveryEndpointFor` (preflight) applies before composing
 * discovery URLs (cursor review, issue #1573 PR2). Implemented without a
 * regex so CodeQL's polynomial-backtracking heuristic does not flag manifest
 * baseUrls as uncontrolled regex input.
 */
function normalizeBaseUrlForSameness(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * Run a sequence of phases against the manifest's declared endpoints, with
 * preflight + hand-off enforcement between them. Resolves with each phase's
 * outcome in order, or rejects with a `LocalLabPreflightError`
 * carrying the failing preflight (which surfaces the endpoint's found model
 * list per rule 51).
 *
 * Phases are required to be supplied in run order; the scheduler does not
 * reorder them. Empty phase lists are a no-op (the harness intentionally
 * supports an empty responder/judge pair for preflight-only smoke checks).
 */
export async function runSequentialPhases<T>(
  manifest: LocalLabManifest,
  phases: LocalLabPhase<T>[],
  options: RunSequentialPhasesOptions = {},
): Promise<LocalLabPhaseOutcome<T>[]> {
  const outcomes: LocalLabPhaseOutcome<T>[] = [];
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    const descriptor: LocalLabPhaseDescriptor = {
      name: phase.name,
      role: phase.role,
    };
    // 1. Hand-off BEFORE preflight when this phase lives on a different endpoint
    //    than its predecessor. The operator must see the swap guidance before
    //    the bench probes the (not-yet-started) next endpoint — otherwise a
    //    not-yet-swapped judge endpoint throws LocalLabPreflightError before
    //    the guidance ever prints (cursor review, issue #1573 PR2).
    //    The first phase has no predecessor, so no hand-off fires.
    if (index > 0) {
      const previous = phases[index - 1];
      const sameEndpoint =
      normalizeBaseUrlForSameness(phase.role.baseUrl) ===
      normalizeBaseUrlForSameness(previous.role.baseUrl);
      if (!sameEndpoint) {
        const manifestNote = readHandoffNote(manifest, previous.name, phase.name);
        const note = formatHandoffNote(
          { name: previous.name, role: previous.role },
          descriptor,
          manifestNote,
        );
        options.hooks?.onPhaseHandoff?.(
          { name: previous.name, role: previous.role },
          descriptor,
          note,
        );
      }
    }

    // 2. Preflight — hard fail; surfaces the found model list to the operator.
    const preflight = await preflightLocalLabRole(
      {
        provider: phase.role.provider,
        baseUrl: phase.role.baseUrl,
        model: phase.role.model,
        ctx: phase.role.ctx,
      },
      options.preflight,
    );
    if (!preflight.ok) {
      throw new LocalLabPreflightError({
        phase: descriptor,
        preflight,
        phaseIndex: index,
      });
    }
    options.hooks?.onPhasePreflight?.(preflight);

    // 3. Execute — the runner supplies the actual phase work.
    options.hooks?.onPhaseStart?.(descriptor);
    const resolvedRole = resolveLocalLabRole(phase.role);
    const result = await phase.execute(resolvedRole);
    const outcome: LocalLabPhaseOutcome<T> = {
      phase: descriptor,
      preflight,
      result,
    };
    outcomes.push(outcome);
    options.hooks?.onPhaseComplete?.(outcome);
  }
  return outcomes;
}

/**
 * Error thrown when a phase's preflight fails. Carries the failing result
 * so callers (and tests) can inspect what the endpoint reported.
 */
export class LocalLabPreflightError extends Error {
  readonly phase: LocalLabPhaseDescriptor;
  readonly preflight: LocalLabPreflightResult;
  readonly phaseIndex: number;

  constructor(args: {
    phase: LocalLabPhaseDescriptor;
    preflight: LocalLabPreflightResult;
    phaseIndex: number;
  }) {
    const reason =
      args.preflight.ok === false
        ? args.preflight.reason
        : "preflight reported success but the scheduler treated it as a failure (internal inconsistency)";
    super(
      `local-lab phase "${args.phase.name}" (index ${args.phaseIndex}) preflight failed: ${reason}`,
    );
    this.name = "LocalLabPreflightError";
    this.phase = args.phase;
    this.preflight = args.preflight;
    this.phaseIndex = args.phaseIndex;
  }
}

/**
 * Render the operator hand-off string the scheduler passes to the
 * `onPhaseHandoff` hook. Returns the manifest note when authored, otherwise
 * a default instruction naming the next phase and its endpoint. This is a
 * pure formatting helper — tests assert on it directly.
 */
export function formatHandoffNote(
  from: LocalLabPhaseDescriptor,
  to: LocalLabPhaseDescriptor,
  manifestNote: string | undefined,
): string {
  if (manifestNote !== undefined && manifestNote.trim().length > 0) {
    return manifestNote.trim();
  }
  return (
    `stop ${from.name} endpoint, start ${to.name} endpoint at ${to.role.baseUrl} ` +
    `serving model ${to.role.model}, then resume the bench`
  );
}

/**
 * Read the hand-off note for a given from→to transition. PR2 only authors
 * `responderToJudgeHandoff`; reverse and embedding transitions fall back to
 * the synthesized default in `formatHandoffNote`.
 */
function readHandoffNote(
  manifest: LocalLabManifest,
  from: LocalLabPhaseName,
  to: LocalLabPhaseName,
): string | undefined {
  if (
    from === "responder" &&
    to === "judge" &&
    typeof manifest.notes?.responderToJudgeHandoff === "string"
  ) {
    return manifest.notes.responderToJudgeHandoff;
  }
  return undefined;
}
