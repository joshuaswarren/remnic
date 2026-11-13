import type { RemnicPiConfig } from "./config.js";

export type DaemonProbeResult = "ready" | "starting" | "unreachable";

type StatusSession = {
  notify: (message: string, level: "warning") => void;
  setStatus: (key: string, value: string) => void;
};
type OfflineStatusState = { statusOffline: boolean };
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
