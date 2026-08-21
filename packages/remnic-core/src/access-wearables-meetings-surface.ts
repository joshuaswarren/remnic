import type { WearablesService } from "./wearables/service.js";
import type { MeetingsService, MeetingsGetResult, MeetingsListResult } from "./meetings/service.js";
import type { MeetingsDayBuildSummary } from "./meetings/build.js";

/**
 * Caller scope threaded into the wearables + meetings access ops so reads and
 * writes resolve to the CALLER namespace (caller-derived namespace symmetry,
 * issue #2123), not a machine-wide default. Every field is optional; omitting
 * all three preserves the operator/CLI default-namespace behavior.
 */
export type WearablesMeetingsScope = {
  sessionKey?: string;
  authenticatedPrincipal?: string;
  namespace?: string;
};

/**
 * The access-service capabilities the wearables + meetings surface needs.
 * A structural host (not the class itself) so these ops stay pure delegators
 * while EngramAccessService keeps its namespace/principal resolvers private.
 */
export interface WearablesMeetingsHost {
  readonly orchestrator: {
    getWearablesService(namespace: string): WearablesService;
    getMeetingsService(namespace: string): Promise<MeetingsService>;
    readonly config: { readonly meetings: { readonly enabled: boolean } };
  };
  resolveReadableNamespace(namespace: string | undefined, principal?: string): string;
  writableNamespaceFor(
    namespace: string | undefined,
    sessionKey: string | undefined,
    authenticatedPrincipal?: string,
  ): string;
  resolveRequestPrincipal(sessionKey: string | undefined, authenticatedPrincipal?: string): string | undefined;
}

/**
 * Wearables reads resolve to the CALLER namespace via resolveReadableNamespace;
 * sync writes via writableNamespaceFor; build needs BOTH — it reads
 * transcripts/records to derive, then writes episodes. Non-default callers are
 * strictly isolated: no default-ns wearable fallback, no machine-global
 * activity (machine-scoped, consumed only by the default ns).
 */
function wearablesReadService(host: WearablesMeetingsHost, scope?: WearablesMeetingsScope): WearablesService {
  return host.orchestrator.getWearablesService(
    host.resolveReadableNamespace(scope?.namespace, host.resolveRequestPrincipal(scope?.sessionKey, scope?.authenticatedPrincipal)),
  );
}

export function wearablesStatus(
  host: WearablesMeetingsHost,
  scope?: WearablesMeetingsScope,
): Promise<Awaited<ReturnType<WearablesService["status"]>>> {
  return wearablesReadService(host, scope).status();
}

export async function wearablesSync(
  host: WearablesMeetingsHost,
  request: { source?: string; date?: string; days?: number; forceMemories?: boolean } & WearablesMeetingsScope,
): Promise<Awaited<ReturnType<WearablesService["sync"]>>> {
  const namespace = host.writableNamespaceFor(request.namespace, request.sessionKey, request.authenticatedPrincipal);
  const summaries = await host.orchestrator
    .getWearablesService(namespace)
    .sync({ source: request.source, date: request.date, days: request.days, forceMemories: request.forceMemories });
  // Manual one-shot sync (HTTP/MCP/CLI): the meeting tail-step arms a
  // debounced, unref'd timer a short-lived caller exits before firing. Drain
  // it now so a manual sync's meeting build actually runs before we return.
  // The long-lived auto-sync daemon does NOT flush — it keeps coalescing.
  if (host.orchestrator.config.meetings.enabled) {
    await (await host.orchestrator.getMeetingsService(namespace)).flushBuilds();
  }
  return summaries;
}

export function wearablesTranscriptDay(
  host: WearablesMeetingsHost,
  request: { date: string; source?: string } & WearablesMeetingsScope,
): Promise<Awaited<ReturnType<WearablesService["dayTranscript"]>>> {
  return wearablesReadService(host, request).dayTranscript(request.date, request.source);
}

export function wearablesTranscriptSearch(
  host: WearablesMeetingsHost,
  request: { query: string; source?: string; from?: string; to?: string; limit?: number } & WearablesMeetingsScope,
): Promise<Awaited<ReturnType<WearablesService["searchTranscripts"]>>> {
  return wearablesReadService(host, request).searchTranscripts(request.query, {
    source: request.source,
    from: request.from,
    to: request.to,
    limit: request.limit,
  });
}

export function wearablesTranscriptMemories(
  host: WearablesMeetingsHost,
  request: { source?: string; date?: string; limit?: number } & WearablesMeetingsScope,
): Promise<Awaited<ReturnType<WearablesService["transcriptMemories"]>>> {
  return wearablesReadService(host, request).transcriptMemories({
    source: request.source,
    date: request.date,
    limit: request.limit,
  });
}

// Meetings (issue #1900): thin delegations to the caller-ns MeetingsService.
export async function meetingsList(
  host: WearablesMeetingsHost,
  date?: string,
  scope?: WearablesMeetingsScope,
): Promise<MeetingsListResult> {
  return (
    await host.orchestrator.getMeetingsService(
      host.resolveReadableNamespace(scope?.namespace, host.resolveRequestPrincipal(scope?.sessionKey, scope?.authenticatedPrincipal)),
    )
  ).meetingsList(date);
}

export async function meetingsGet(
  host: WearablesMeetingsHost,
  id: string,
  scope?: WearablesMeetingsScope,
): Promise<MeetingsGetResult> {
  return (
    await host.orchestrator.getMeetingsService(
      host.resolveReadableNamespace(scope?.namespace, host.resolveRequestPrincipal(scope?.sessionKey, scope?.authenticatedPrincipal)),
    )
  ).meetingsGet(id);
}

export async function meetingsBuild(
  host: WearablesMeetingsHost,
  date: string,
  scope?: WearablesMeetingsScope,
): Promise<MeetingsDayBuildSummary> {
  const principal = host.resolveRequestPrincipal(scope?.sessionKey, scope?.authenticatedPrincipal);
  const namespace = host.writableNamespaceFor(scope?.namespace, scope?.sessionKey, scope?.authenticatedPrincipal);
  host.resolveReadableNamespace(namespace, principal);
  return (await host.orchestrator.getMeetingsService(namespace)).meetingsBuild(date);
}
