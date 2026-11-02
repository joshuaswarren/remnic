import { setTimeout as delay } from "node:timers/promises";

import type { RemnicClient } from "./client.js";
import type { RemnicPiConfig } from "./config.js";
import type { PiApi, PiContextSnapshot, DaemonProbeResult, StateEntryData } from "./index.js";
import type { RecallTimeoutBreaker } from "./recall-timeout-breaker.js";

// The index.ts-local helpers the startup chain depends on, threaded in as
// callbacks: every `./index.js` import above is type-only, so there is no
// runtime import cycle back into the extension module.
export type StartupProbeDeps = {
  /** Pure daemon health probe: no shared-breaker writes; the chain applies `breaker` under its currency guard. */
  probeHealth: (client: RemnicClient, config: RemnicPiConfig) => Promise<DaemonHealthVerdict>;
  statusLabel: (probe: DaemonProbeResult, namespace: string | undefined) => string;
  recallDisabledStatus: string;
  /** Append a persistent `remnic_state` entry; the chain owns the preflight payloads. */
  appendStateEntry: (data: StateEntryData) => void;
  errorText: (cause: unknown) => string;
};

/** Pure probe verdict plus the shared-breaker action the chain applies when still current. */
export type DaemonHealthVerdict = {
  result: DaemonProbeResult;
  breaker: "reachable" | "unreachable" | "none";
};

type StartupProbeContext = {
  pi: PiApi;
  session: PiContextSnapshot;
  client: RemnicClient;
  config: RemnicPiConfig;
  recallTimeoutBreaker: RecallTimeoutBreaker;
  /** The live session state plus this chain's epoch; the chain is current only while `state.startupEpoch === epoch`. */
  state: { startupEpoch: number };
  epoch: number;
  /** True while the session is still live (its state is the host map's entry). */
  isLive: () => boolean;
};

/**
 * Run the session_start startup chain (health probe -> version warning ->
 * namespace preflight) without blocking the caller. Side effects are identical
 * to the former in-handler sequence; only the timing changes. The returned
 * promise is kept on the session state so a first-turn daemon call (recall or
 * observe) can await the freshest reachability verdict, and it never rejects
 * (see the catch backstop). Result publication and shared-breaker updates are
 * guarded by a currency check (this chain's epoch is still the session's)
 * plus a liveness check (the session has not shut down), so a superseded or
 * post-shutdown chain settles quietly instead of overriding a newer verdict.
 */
export function runStartupProbeChain(deps: StartupProbeDeps, ctx: StartupProbeContext): Promise<DaemonProbeResult> {
  return new StartupProbeChain(deps, ctx).run();
}

/**
 * One per `session_start`: owns the epoch/liveness guard so the leaf steps stay
 * pure and no `isCurrent` callback is threaded through them.
 */
class StartupProbeChain {
  constructor(
    private readonly deps: StartupProbeDeps,
    private readonly ctx: StartupProbeContext,
  ) {}

  /** Current only while this chain's epoch is still the session's and the session has not shut down. */
  private isCurrent(): boolean {
    return this.ctx.state.startupEpoch === this.ctx.epoch && this.ctx.isLive();
  }

  async run(): Promise<DaemonProbeResult> {
    const { probeHealth, statusLabel, recallDisabledStatus, errorText } = this.deps;
    const { client, config, recallTimeoutBreaker, session } = this.ctx;
    // Sample before the deferred health round-trip so a markReachable from a
    // newer successful call (e.g. manual /remnic-recall) supersedes this chain's
    // unreachable verdict without blocking that call on startup.
    const reachabilityGeneration = client.reachabilityGenerationToken();
    try {
      const verdict = await probeHealth(client, config);
      this.applyBreaker(verdict, reachabilityGeneration);
      const probe = verdict.result;
      if (probe !== "unreachable") {
        await client.warnIfVersionMismatch({ timeoutMs: config.startupRequestTimeoutMs });
      }
      if (config.statusEnabled && this.isCurrent()) {
        session.setStatus(
          "remnic",
          recallTimeoutBreaker.isTripped() ? recallDisabledStatus : statusLabel(probe, config.namespace),
        );
      }
      if (this.isCurrent()) {
        await this.runNamespacePreflight();
      }
      return probe;
    } catch (err) {
      // Backstop for the version/preflight steps: surface the error and settle
      // with a safe verdict so the background chain never rejects.
      if (this.isCurrent()) session.notify(`Remnic startup check failed: ${errorText(err)}`, "warning");
      return "unreachable";
    }
  }

  /** Epoch/liveness plus reachability-generation: stale unreachable must not clobber a newer success. */
  private applyBreaker(verdict: DaemonHealthVerdict, reachabilityGeneration: number): void {
    if (!this.isCurrent()) return;
    if (verdict.breaker === "reachable") this.ctx.client.markReachable();
    else if (verdict.breaker === "unreachable") {
      this.ctx.client.markUnreachableIfGeneration(reachabilityGeneration, this.ctx.config.daemonCooldownMs);
    }
  }

  /**
   * Startup namespace-writability preflight (issue #1888 part 3). Runs at each session_start. When the
   * configured namespace is NOT writable for this client's principal, every memory
   * write is rejected and — since the dead-letter quarantine landed — parked, never
   * stored. A silent per-call rejection is invisible; this surfaces it LOUDLY and
   * persistently (an error `remnic_state` entry + error notification, re-emitted
   * every session while broken).
   *
   * `appendEntry` has no delete, so the CURRENT state is always recorded: a
   * `NAMESPACE_OK` entry on a writable result makes the latest `remnic_state`
   * entry authoritative even across an extension/host restart (no in-memory
   * transition tracking that a restart would lose). Only errors notify — the OK
   * entry is a silent heartbeat, never a success toast every healthy session. A
   * daemon that cannot be reached (indeterminate) records nothing, leaving the
   * last known state intact — we neither cry wolf nor falsely clear a real error.
   */
  private async runNamespacePreflight(): Promise<void> {
    const { appendStateEntry } = this.deps;
    const { session, client, config } = this.ctx;
    // No token → the client cannot write anyway; known-unreachable → the answer
    // would be indeterminate. Either way, do not touch the recorded state.
    if (!config.authToken || !client.isReachable()) return;
    const result = await client.preflightNamespace(session.sessionKey, {
      timeoutMs: config.startupRequestTimeoutMs,
    });
    if (!this.isCurrent()) return; // the request may resolve after supersession or shutdown
    if (result.status === "not_writable") {
      // The remediation differs by cause: `unsupported` means the daemon has
      // namespaces disabled, so ONLY its default namespace is writable — pointing
      // the operator at namespacePolicies would be misleading.
      const fix =
        result.reason === "unsupported"
          ? "The daemon has namespaces disabled, so only its default namespace is writable — set the client's namespace to the daemon's defaultNamespace (or omit it)."
          : "Fix the client's namespace config: it must match a namespacePolicies entry, or be the daemon's defaultNamespace/sharedNamespace.";
      const message =
        `Remnic: configured namespace "${result.namespace}" is NOT writable for this client's principal ` +
        `(${result.reason}). Every memory write will be rejected and dead-lettered (recoverable via ` +
        `\`remnic quarantine list\`), NOT stored. ${fix}`;
      session.notify(message, "error");
      appendStateEntry({
        level: "error",
        code: "NAMESPACE_NOT_WRITABLE",
        namespace: result.namespace,
        reason: result.reason,
        message,
        persistent: true,
        recordedAt: new Date().toISOString(),
      });
      return;
    }
    if (result.status === "writable") {
      appendStateEntry({
        level: "info",
        code: "NAMESPACE_OK",
        namespace: result.namespace,
        recordedAt: new Date().toISOString(),
      });
    }
    // indeterminate → record nothing; keep the last known state.
  }
}

/**
 * Resolve when `promise` settles or `budgetMs` elapses, whichever comes first.
 * `budgetMs <= 0` skips the wait; the budget timer is cancelled as soon as the
 * race settles, so a pending wait never lingers.
 */
export async function settleWithinBudget(promise: Promise<unknown>, budgetMs: number): Promise<void> {
  if (budgetMs <= 0) return;
  const cancel = new AbortController();
  // The promisified timer REJECTS with AbortError on cancel; swallow it so the
  // budget side of the race can never become an unhandled rejection.
  const budget = delay(budgetMs, undefined, { signal: cancel.signal }).catch(() => undefined);
  try {
    await Promise.race([promise, budget]);
  } finally {
    cancel.abort();
  }
}

/**
 * Join the session's in-flight startup probe, bounded by the smaller of the
 * startup and turn budgets, so a first-turn daemon call (recall or observe)
 * sees the freshest reachability verdict instead of firing while the probe is
 * still deciding. A settled probe costs ~0 (next microtask). Runs at most once
 * per session, so recall and observe share this single join.
 */
export async function joinStartupProbe(
  state: { startupProbe: Promise<DaemonProbeResult> | null; startupProbeJoined: boolean },
  config: RemnicPiConfig,
): Promise<void> {
  if (state.startupProbeJoined || !state.startupProbe) return;
  state.startupProbeJoined = true;
  await settleWithinBudget(
    state.startupProbe,
    Math.min(config.startupRequestTimeoutMs, config.turnRequestTimeoutMs),
  );
}
