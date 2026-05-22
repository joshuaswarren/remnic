import { ensureCronJob } from "@remnic/core/maintenance/memory-governance-cron";
import type { LiveConnectorsConfig } from "./types.js";

const LIVE_CONNECTOR_CRON_ID = "engram-live-connectors-sync";
const DEFAULT_LIVE_CONNECTOR_CRON_EXPR = "*/5 * * * *";
const ENABLED_LIVE_CONNECTOR_CRON_EXPR = "* * * * *";

export async function ensureLiveConnectorCron(
  jobsPath: string,
  options: {
    timezone: string;
    agentId?: string;
    connectors?: LiveConnectorsConfig;
    scheduleExpr?: string;
  },
): Promise<{ created: boolean; updated: boolean; jobId: string }> {
  const scheduleExpr =
    typeof options.scheduleExpr === "string" && options.scheduleExpr.trim().length > 0
      ? options.scheduleExpr.trim()
      : liveConnectorCronExprForConfig(options.connectors);
  const agentId =
    typeof options.agentId === "string" && options.agentId.trim().length > 0
      ? options.agentId.trim()
      : "main";

  return ensureCronJob(
    jobsPath,
    LIVE_CONNECTOR_CRON_ID,
    () => ({
      id: LIVE_CONNECTOR_CRON_ID,
      agentId,
      name: "Remnic Live Connectors (poll due sources)",
      enabled: true,
      schedule: {
        kind: "cron",
        expr: scheduleExpr,
        tz: options.timezone,
      },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        timeoutSeconds: 900,
        thinking: "off",
        message:
          "You are OpenClaw automation. Call tool `engram.live_connectors_run` with empty params. " +
          "If successful output exactly NO_REPLY. On error output one concise line. Do NOT use message tool.",
      },
      delivery: { mode: "none" },
    }),
    { updateExisting: true, updateFields: ["agentId", "schedule", "payload"] },
  );
}

export function liveConnectorCronExprForConfig(
  connectors: LiveConnectorsConfig | undefined,
): string {
  if (connectors === undefined) return DEFAULT_LIVE_CONNECTOR_CRON_EXPR;
  const hasEnabledConnector = [
    connectors.googleDrive,
    connectors.notion,
    connectors.gmail,
    connectors.github,
  ].some((connector) => connector.enabled);

  return hasEnabledConnector
    ? ENABLED_LIVE_CONNECTOR_CRON_EXPR
    : DEFAULT_LIVE_CONNECTOR_CRON_EXPR;
}
