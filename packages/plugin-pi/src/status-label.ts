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

export function remnicStatusLabel(probe: DaemonProbeResult, namespace: string | undefined): string {
  if (probe === "unreachable") return "Remnic offline";
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
  sleep?: (ms: number) => Promise<unknown>;
}

function defaultSleep(ms: number): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  // unref: a background re-probe's backoff must not keep the host process alive.
  setTimeout(resolve, ms).unref();
  return promise;
}

/**
 * Sessions that go offline at startup have no later traffic when idle, so the
 * offline label would stick forever: nothing re-probes it. Re-probe on a
 * bounded backoff until the daemon answers or the session goes away. Silent by
 * design: failures just reschedule, success calls onRecovered once. The timer
 * is unref'd so a pending wait never holds the process open.
 */
export async function recheckOfflineUntilReachable(
  hooks: OfflineReprobeHooks,
  opts?: { initialDelayMs?: number; maxDelayMs?: number },
): Promise<void> {
  const sleep = hooks.sleep ?? defaultSleep;
  let delay = opts?.initialDelayMs ?? 5000;
  const maxDelay = opts?.maxDelayMs ?? 60000;
  for (;;) {
    await sleep(delay);
    if (!hooks.isLive()) return;
    let result: DaemonProbeResult;
    try {
      result = await hooks.probe();
    } catch {
      result = "unreachable";
    }
    if (!hooks.isLive()) return;
    if (result === "ready") {
      hooks.onRecovered();
      return;
    }
    delay = Math.min(delay * 2, maxDelay);
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
