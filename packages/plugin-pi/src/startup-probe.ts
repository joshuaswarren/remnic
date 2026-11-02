import type { RemnicClient } from "./client.js";
import type { RemnicPiConfig } from "./config.js";
import type { PiApi, PiContextSnapshot, DaemonProbeResult } from "./index.js";
import type { RecallTimeoutBreaker } from "./recall-timeout-breaker.js";

/**
 * The index.ts-local helpers the startup chain depends on, threaded in as
 * callbacks so this module stays decoupled from the extension module (no
 * runtime import cycle: every `./index.js` import above is type-only and is
 * erased at load time).
 */
export type StartupProbeDeps = {
  /** Daemon health probe: updates the shared reachability breaker and returns the verdict. */
  probeHealth: (client: RemnicClient, config: RemnicPiConfig) => Promise<DaemonProbeResult>;
  /** Session_start status label for a probe verdict (namespaced). */
  statusLabel: (probe: DaemonProbeResult, namespace: string | undefined) => string;
  /** Status label shown while the recall timeout breaker is tripped. */
  recallDisabledStatus: string;
  /** Namespace-writability preflight; records persistent remnic_state entries. */
  runNamespacePreflight: (
    pi: PiApi,
    session: PiContextSnapshot,
    client: RemnicClient,
    config: RemnicPiConfig,
  ) => Promise<void>;
  /** Error → human message for the defensive chain backstop. */
  errorText: (cause: unknown) => string;
};

/**
 * Run the session_start startup chain (health probe -> version warning ->
 * namespace preflight) without blocking the caller. `session_start` fires this
 * and returns immediately (#3273 phase 1); the returned promise settles once
 * the chain completes and is kept on the session state so the first
 * `before_agent_start` can await the freshest reachability verdict.
 *
 * The side effects are identical to the former in-handler sequence, only the
 * timing changes: `probeHealth` updates the shared breaker (reachable on
 * success / 503 not_ready, unreachable on a connection failure), the status
 * label is still gated on `statusEnabled`, and the namespace preflight records
 * state exactly as before. Every step is guarded so an unexpected error settles
 * the promise (never an unhandled rejection) and is surfaced via the existing
 * notify style.
 */
export function runStartupProbeChain(
  deps: StartupProbeDeps,
  ctx: {
    pi: PiApi;
    session: PiContextSnapshot;
    client: RemnicClient;
    config: RemnicPiConfig;
    recallTimeoutBreaker: RecallTimeoutBreaker;
  },
): Promise<DaemonProbeResult> {
  const { probeHealth, statusLabel, recallDisabledStatus, runNamespacePreflight, errorText } = deps;
  const { pi, session, client, config, recallTimeoutBreaker } = ctx;
  return (async () => {
    // probeHealth never throws: it classifies every failure into a reachable /
    // unreachable verdict, so `probe` is always a real outcome.
    const probe = await probeHealth(client, config);
    if (probe !== "unreachable") {
      // warnIfVersionMismatch is a best-effort diagnostic that swallows its own
      // errors, but guard the step too so an unexpected throw cannot escape.
      await client.warnIfVersionMismatch({ timeoutMs: config.startupRequestTimeoutMs });
    }
    if (config.statusEnabled) {
      session.setStatus(
        "remnic",
        recallTimeoutBreaker.isTripped() ? recallDisabledStatus : statusLabel(probe, config.namespace),
      );
    }
    await runNamespacePreflight(pi, session, client, config);
    return probe;
  })().catch((err): DaemonProbeResult => {
    // Surface an unexpected chain error via the existing notify style and settle
    // with a safe verdict. The probe step never throws in practice, so this is a
    // defensive backstop for the version/preflight steps; reaching it means the
    // daemon is effectively unreachable for startup, so report that verdict.
    session.notify(`Remnic startup check failed: ${errorText(err)}`, "warning");
    return "unreachable";
  });
}

/**
 * Resolve with `promise`'s value when it settles, or resolve with undefined
 * after `budgetMs` whichever comes first. Used to await the in-flight startup
 * probe from `before_agent_start` without ever exceeding the turn's budget.
 * `budgetMs <= 0` skips the wait (nothing to bound against). The budget timer is
 * cleared as soon as the race settles, so a pending wait never lingers.
 */
export async function settleWithinBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | undefined> {
  if (budgetMs <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
  });
  try {
    return await Promise.race([promise, budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
