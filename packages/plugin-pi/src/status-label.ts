import type { RemnicPiConfig } from "./config.js";

export type DaemonProbeResult = "ready" | "starting" | "unreachable";

type StatusSession = {
  notify: (message: string, level: "warning") => void;
  setStatus: (key: string, value: string) => void;
};
type OfflineStatusState = { statusOffline?: boolean };
type RecallTimeoutTripEntry = {
  level: "warning";
  code: "RECALL_TIMEOUT_TRIP";
  threshold: number;
  window: number;
  reason: string;
  message: string;
  error: string;
  disabledAt: string;
  persistent: true;
};

export const RECALL_DISABLED_STATUS = "Remnic recall paused (timeouts delayed operations; auto-retry after cooldown)";

export function remnicStatusLabel(probe: DaemonProbeResult, namespace: string | undefined, detail?: string): string {
  if (probe === "unreachable") return detail ? `Remnic offline — ${detail}` : "Remnic offline";
  if (probe === "starting") return "Remnic starting";
  return `Remnic ${namespace ? `(${namespace})` : "ready"}`;
}

/**
 * The first later successful recall or observe refreshes the offline label once.
 * The recall breaker is shared by every session in the process, so while it is
 * tripped the label is the paused one, not ready (the same rule as the startup probe).
 */
export function refreshOfflineStatusLabel(
  session: Pick<StatusSession, "setStatus">,
  state: OfflineStatusState,
  config: Pick<RemnicPiConfig, "statusEnabled" | "namespace">,
  recallPaused: boolean,
): void {
  if (!state.statusOffline || !config.statusEnabled) return;
  state.statusOffline = false;
  session.setStatus("remnic", recallPaused ? RECALL_DISABLED_STATUS : remnicStatusLabel("ready", config.namespace));
}

export interface OfflineReprobeHooks {
  probe: () => Promise<DaemonProbeResult>;
  onRecovered: () => void;
  isLive: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  onError?: (cause: unknown) => void;
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  // unref: a background re-probe's backoff must not keep the host process alive.
  setTimeout(resolve, ms).unref();
  return promise;
}

function reportReprobeError(hooks: OfflineReprobeHooks, cause: unknown): void {
  try {
    hooks.onError?.(cause);
  } catch {
    // a broken logger must not become the unhandled rejection this guard exists to stop
  }
}

/**
 * Sessions that go offline at startup have no later traffic when idle, so the
 * offline label would stick forever: nothing re-probes it. Re-probe on a
 * bounded backoff until the daemon answers or the session goes away. Silent by
 * design: failures are logged through onError and the returned promise never
 * rejects, so a fire-and-forget caller cannot raise an unhandled rejection.
 * The timer is unref'd so a pending wait never holds the process open.
 */
export async function recheckOfflineUntilReachable(
  hooks: OfflineReprobeHooks,
  opts?: { initialDelayMs?: number; maxDelayMs?: number },
): Promise<void> {
  const sleep = hooks.sleep ?? defaultSleep;
  let delay = opts?.initialDelayMs ?? 5000;
  const maxDelay = opts?.maxDelayMs ?? 60000;
  try {
    for (;;) {
      try {
        await sleep(delay);
      } catch (err) {
        reportReprobeError(hooks, err);
        return;
      }
      if (!hooks.isLive()) return;
      let result: DaemonProbeResult;
      try {
        result = await hooks.probe();
      } catch {
        result = "unreachable";
      }
      if (!hooks.isLive()) return;
      if (result === "ready") {
        try {
          hooks.onRecovered();
        } catch (err) {
          reportReprobeError(hooks, err);
        }
        return;
      }
      delay = Math.min(delay * 2, maxDelay);
    }
  } catch (err) {
    reportReprobeError(hooks, err);
  }
}

export function emitRecallTimeoutTrip(
  session: StatusSession,
  config: Pick<RemnicPiConfig, "statusEnabled" | "recallTimeoutThreshold" | "recallTimeoutWindow">,
  state: OfflineStatusState,
  errorText: string,
  appendStateEntry: (entry: RecallTimeoutTripEntry) => void,
): void {
  const message =
    `Remnic recall has been paused because repeated timeouts delayed operations ` +
    `(${config.recallTimeoutThreshold} timeouts in the last ${config.recallTimeoutWindow} recall attempts). ` +
    `It retries automatically after a 5 minute cooldown.`;
  session.notify(message, "warning");
  if (config.statusEnabled) {
    state.statusOffline = false;
    session.setStatus("remnic", RECALL_DISABLED_STATUS);
  }
  appendStateEntry({
    level: "warning",
    code: "RECALL_TIMEOUT_TRIP",
    threshold: config.recallTimeoutThreshold,
    window: config.recallTimeoutWindow,
    reason: "Recall paused because timeouts delayed operations; auto-retries after cooldown",
    message,
    error: errorText,
    disabledAt: new Date().toISOString(),
    persistent: true,
  });
}
