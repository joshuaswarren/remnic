import type { LastRecallSnapshot } from "@remnic/core/recall-state";
import type { SessionToggleStore } from "@remnic/core/session-toggles";

export interface SessionCommandContext {
  sessionKey?: string;
  agentId?: string;
  args?: string | readonly string[];
}

export interface SessionCommandRuntime {
  toggles: SessionToggleStore;
  getLastRecall(sessionKey: string): LastRecallSnapshot | null;
  getLastRecallSummary(sessionKey: string): string | null;
  flushSession(sessionKey: string): Promise<void>;
}

export interface StructuredSessionCommandReply {
  text: string;
}

type SessionCommandDescriptor = {
  name: string;
  description: string;
  category: string;
  pluginId: string;
  acceptsArgs: boolean;
  subcommands: Array<{
    name: string;
    description: string;
    args: string[];
    handler: (commandCtx?: SessionCommandContext) => Promise<string>;
  }>;
  handler: (
    commandCtx?: SessionCommandContext,
  ) => Promise<StructuredSessionCommandReply>;
};

type LegacySessionCommandDescriptor = Omit<SessionCommandDescriptor, "handler"> & {
  handler: (commandCtx?: SessionCommandContext) => Promise<string>;
};

function describeToggleSource(source: "primary" | "secondary" | "none"): string {
  if (source === "primary") return "Remnic session override";
  if (source === "secondary") return "bundled active-memory override";
  return "global config";
}

function resolveSession(commandCtx: SessionCommandContext): { sessionKey: string; agentId: string } {
  return {
    sessionKey: commandCtx.sessionKey ?? "default",
    agentId: commandCtx.agentId ?? "main",
  };
}

function normalizeCommandArgs(args: SessionCommandContext["args"]): string[] {
  if (Array.isArray(args)) {
    return args
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0);
  }
  if (typeof args === "string") {
    return args
      .split(/\s+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }
  return [];
}

export function buildSessionCommandDescriptors(
  pluginId: string,
  runtime: SessionCommandRuntime,
): SessionCommandDescriptor[] {
  const subcommands = [
    {
      name: "off",
      description: "Disable Remnic recall for this session",
      args: [],
      handler: async (commandCtx: SessionCommandContext = {}) => {
        const { sessionKey, agentId } = resolveSession(commandCtx);
        await runtime.toggles.setDisabled(sessionKey, agentId, true);
        return `Remnic recall disabled for session ${sessionKey}.`;
      },
    },
    {
      name: "on",
      description: "Re-enable Remnic recall for this session",
      args: [],
      handler: async (commandCtx: SessionCommandContext = {}) => {
        const { sessionKey, agentId } = resolveSession(commandCtx);
        await runtime.toggles.setDisabled(sessionKey, agentId, false);
        return `Remnic recall re-enabled for session ${sessionKey}.`;
      },
    },
    {
      name: "status",
      description: "Show Remnic recall status and last injected summary",
      args: [],
      handler: async (commandCtx: SessionCommandContext = {}) => {
        const { sessionKey, agentId } = resolveSession(commandCtx);
        const resolved = await runtime.toggles.resolve(sessionKey, agentId);
        const lastRecall = runtime.getLastRecall(sessionKey);
        const summaryText = runtime.getLastRecallSummary(sessionKey);
        const summary = summaryText && summaryText.length > 0
          ? summaryText
          : lastRecall && lastRecall.memoryIds.length > 0
            ? `${lastRecall.memoryIds.length} memory item(s), latency ${lastRecall.latencyMs ?? "?"}ms`
            : "NONE";
        return [
          `Remnic recall is ${resolved.disabled ? "disabled" : "enabled"} for session ${sessionKey}.`,
          `Source: ${describeToggleSource(resolved.source)}.`,
          `Last recall: ${summary}.`,
        ].join(" ");
      },
    },
    {
      name: "clear",
      description: "Clear the session override and use global config again",
      args: [],
      handler: async (commandCtx: SessionCommandContext = {}) => {
        const { sessionKey, agentId } = resolveSession(commandCtx);
        await runtime.toggles.clear(sessionKey, agentId);
        return `Cleared the Remnic session override for ${sessionKey}.`;
      },
    },
    {
      name: "stats",
      description: "Show Remnic extraction and recall stats for this session",
      args: [],
      handler: async (commandCtx: SessionCommandContext = {}) => {
        const { sessionKey } = resolveSession(commandCtx);
        const lastRecall = runtime.getLastRecall(sessionKey);
        if (!lastRecall) {
          return `No Remnic recall stats are available for session ${sessionKey} yet.`;
        }
        return [
          `Session ${sessionKey}.`,
          `Planner mode: ${lastRecall.plannerMode ?? "unknown"}.`,
          `Latency: ${lastRecall.latencyMs ?? "?"}ms.`,
          `Memories: ${lastRecall.memoryIds.length}.`,
        ].join(" ");
      },
    },
    {
      name: "flush",
      description: "Force-flush the extraction buffer now",
      args: [],
      handler: async (commandCtx: SessionCommandContext = {}) => {
        const { sessionKey } = resolveSession(commandCtx);
        await runtime.flushSession(sessionKey);
        return `Flushed the Remnic buffer for session ${sessionKey}.`;
      },
    },
  ];

  // Top-level handler + description + acceptsArgs let the OpenClaw host
  // registerPluginCommand validator accept this descriptor. The validator
  // (openclaw/dist/command-registration:validatePluginCommandDefinition)
  // requires a function `handler` and a non-empty string `description` on the
  // registered command itself; it does not walk a `subcommands` array. The
  // dispatcher below routes `/remnic <sub>` to the matching subcommand while
  // keeping the `subcommands` array available for command-discovery surfaces
  // that introspect it.
  const subcommandNames = subcommands.map((entry) => entry.name).join(", ");
  return [
    {
      name: "remnic",
      description: `Remnic memory controls (${subcommandNames})`,
      category: "memory",
      pluginId,
      acceptsArgs: true,
      subcommands,
      handler: async (commandCtx: SessionCommandContext = {}) => {
        const requested =
          normalizeCommandArgs(commandCtx.args)[0]?.trim().toLowerCase() ?? "status";
        const match = subcommands.find((entry) => entry.name === requested);
        if (!match) {
          return {
            text: `Unknown Remnic subcommand "${requested}". Try one of: ${subcommandNames}.`,
          };
        }
        return { text: await match.handler(commandCtx) };
      },
    },
  ];
}

export function buildLegacySessionCommandDescriptors(
  pluginId: string,
  runtime: SessionCommandRuntime,
): LegacySessionCommandDescriptor[] {
  return buildLegacySessionCommandDescriptorsFromDescriptors(
    buildSessionCommandDescriptors(pluginId, runtime),
  );
}

export function buildLegacySessionCommandDescriptorsFromDescriptors(
  descriptors: SessionCommandDescriptor[],
): LegacySessionCommandDescriptor[] {
  return descriptors.map((descriptor) => ({
    ...descriptor,
    handler: async (commandCtx: SessionCommandContext = {}) =>
      (await descriptor.handler(commandCtx)).text,
  }));
}
