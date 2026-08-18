/**
 * Day-summary cron model resolution (extracted from
 * orchestration/maintenance.ts in #2047 so that capped file keeps only
 * scheduling wiring). Pure function of config — no I/O.
 */

import type { PluginConfig } from "../types.js";

/**
 * Resolve the cron-routing model + fallback chain. Only in gateway mode is
 * summaryModel routable as an OpenClaw agentTurn model; in plugin mode it is
 * a direct-client model id for Remnic's own LLM calls. Task-chain fallbacks
 * attach only when the model matches the task-chain primary (a distinct
 * override's fallbacks would be unrelated); gateway default models are
 * appended as tail fallbacks (de-duped) so a task-chain outage doesn't stop
 * the cron before reaching the gateway default chain.
 */
export function resolveDaySummaryCronModel(config: PluginConfig): {
  model?: string;
  fallbacks: string[];
} {
  const rawSummaryModel = config.summaryModel;
  const taskPrimary = config.taskModelChain?.primary;
  const isGateway = config.modelSource === "gateway";
  const model = isGateway ? rawSummaryModel || taskPrimary || undefined : undefined;
  const fallbacks: string[] = [];
  if (model && taskPrimary && model === taskPrimary) {
    const seen = new Set<string>(model ? [model] : []);
    const addUnique = (value: string | undefined) => {
      if (typeof value !== "string") return;
      const trimmed = value.trim();
      if (trimmed.length > 0 && !seen.has(trimmed)) {
        seen.add(trimmed);
        fallbacks.push(trimmed);
      }
    };
    for (const fb of config.taskModelChain?.fallbacks ?? []) addUnique(fb);
    const gwDefaults = config.gatewayConfig?.agents?.defaults?.model;
    addUnique(gwDefaults?.primary);
    if (Array.isArray(gwDefaults?.fallbacks)) {
      for (const fb of gwDefaults.fallbacks) addUnique(fb);
    }
  }
  return { ...(model ? { model } : {}), fallbacks };
}
