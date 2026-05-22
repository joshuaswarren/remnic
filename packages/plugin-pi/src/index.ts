import { Type, type TSchema } from "@sinclair/typebox";

import { loadConfig, type LoadConfigOptions, type RemnicPiConfig } from "./config.js";
import { RemnicClient, type McpTool, type ObserveMessage } from "./client.js";
import {
  hashObservedMessage,
  latestUserRecallTarget,
  observedMessageDedupeKey,
  sessionKeyFromContext,
  summarizeMessages,
  textFromMessage,
  toObserveMessage,
} from "./messages.js";

type PiApi = {
  on(event: string, handler: (event: any, ctx: any) => unknown | Promise<unknown>): void;
  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }): void;
  registerTool(tool: Record<string, unknown>): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
};

export interface RemnicPiExtensionOptions extends LoadConfigOptions {
  config?: RemnicPiConfig;
}

const STATE_CUSTOM_TYPE = "remnic_state";
const MAX_OBSERVED_HASHES = 2000;
const MAX_SESSION_STATES = 50;
const MAX_CONTEXT_CHARS = 12000;
const TRUNCATION_NOTICE = "\n\n[Remnic context truncated]";
const SESSION_OWNED_FIELDS = new Set(["sessionKey", "namespace", "cwd"]);

type PiSessionState = {
  observedHashes: Set<string>;
  liveObservedReplayKeys: Map<string, number>;
  lastInjectedRecallKey: string;
};

export function createRemnicPiExtension(options: RemnicPiExtensionOptions = {}) {
  const config = options.config ?? loadConfig(options);
  const client = new RemnicClient(config);
  const sessionStates = new Map<string, PiSessionState>();

  return async function remnicPiExtension(pi: PiApi): Promise<void> {
    pi.on("session_start", async (_event, ctx) => {
      const { state } = getSessionState(ctx, sessionStates);
      restoreObservedState(ctx, state.observedHashes);
      if (!config.statusEnabled) return;
      await setStatus(ctx, client, config);
    });

    pi.on("context", async (event, ctx) => {
      if (!config.recallEnabled || !config.authToken) return;
      const recallTarget = latestUserRecallTarget(Array.isArray(event.messages) ? event.messages : []);
      if (!recallTarget) return;
      const { query } = recallTarget;
      const sessionKey = sessionKeyFromContext(ctx);
      const { state } = getSessionState(ctx, sessionStates);
      if (recallTarget.dedupeKey === state.lastInjectedRecallKey) return;

      try {
        const recalled = await client.recall(query, sessionKey, ctx.cwd);
        const context = trimContext(recalled.context ?? "", config.recallBudgetChars);
        if (!context) return;
        state.lastInjectedRecallKey = recallTarget.dedupeKey;
        return {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: `Remnic recalled context for this turn:\n\n${context}` }],
              remnicInjected: true,
              timestamp: Date.now(),
            },
            ...event.messages,
          ],
        };
      } catch (err) {
        notify(ctx, `Remnic recall unavailable: ${errorMessage(err)}`, "warning");
      }
    });

    pi.on("message_end", async (event, ctx) => {
      if (!config.observeEnabled || !isUserMessage(event.message)) return;
      const { state } = getSessionState(ctx, sessionStates);
      await observeMessages(ctx, client, [event.message], state.observedHashes, state.liveObservedReplayKeys);
    });

    pi.on("turn_end", async (event, ctx) => {
      if (!config.observeEnabled) return;
      const messages = [event.message, ...(Array.isArray(event.toolResults) ? event.toolResults : [])];
      const { state } = getSessionState(ctx, sessionStates);
      await observeMessages(ctx, client, messages, state.observedHashes, state.liveObservedReplayKeys);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const { sessionKey, state } = getSessionState(ctx, sessionStates);
      if (config.observeEnabled) {
        const branch = safeBranch(ctx);
        const branchMessages = branchMessagesWithEntryIdentity(branch);
        const unobservedBranchMessages = skipLiveObservedReplayMessages(ctx, branchMessages, state.liveObservedReplayKeys);
        if (unobservedBranchMessages.length > 0) await observeMessages(ctx, client, unobservedBranchMessages, state.observedHashes);
      }
      persistObservedState(pi, state.observedHashes);
      sessionStates.delete(sessionKey);
    });

    pi.on("session_before_compact", async (event, ctx) => {
      if (!config.compactionEnabled || !config.authToken) return;
      const sessionKey = sessionKeyFromContext(ctx);
      const preparation = event.preparation ?? {};
      try {
        await client.lcmCompactionFlush(sessionKey);
      } catch (err) {
        notify(ctx, `Remnic LCM flush failed: ${errorMessage(err)}`, "warning");
        return;
      }

      const tokensBefore = finiteTokenCount(preparation.tokensBefore);
      const tokensAfter = finiteTokenCount(preparation.tokensAfter);
      if (tokensBefore !== null && tokensAfter !== null) {
        try {
          await client.lcmCompactionRecord(sessionKey, tokensBefore, tokensAfter);
        } catch (err) {
          notify(ctx, `Remnic LCM compaction token record failed: ${errorMessage(err)}`, "warning");
        }
      }

      const summary = buildCompactionSummary(preparation);
      if (!summary.trim()) return;
      try {
        await client.contextCheckpoint(sessionKey, summary);
      } catch (err) {
        notify(ctx, `Remnic context checkpoint failed: ${errorMessage(err)}`, "warning");
      }
      const details = fileDetailsFromPreparation(preparation);
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            ...details,
            remnic: { version: 1, source: "pi" },
          },
        },
      };
    });

    registerCommands(pi, client, config);
    if (config.mcpToolsEnabled && config.authToken) {
      await registerMcpTools(pi, client, config);
    }
  };
}

export default async function remnicPiExtension(pi: PiApi): Promise<void> {
  await createRemnicPiExtension()(pi);
}

function registerCommands(pi: PiApi, client: RemnicClient, config: RemnicPiConfig): void {
  pi.registerCommand("remnic-status", {
    description: "Check Remnic daemon status",
    handler: commandHandler(async (_args, ctx) => {
      const health = await client.health();
      notify(ctx, `Remnic ${health.ok ? "healthy" : "unhealthy"} at ${config.remnicDaemonUrl}`, health.ok ? "success" : "warning");
    }),
  });

  pi.registerCommand("remnic-recall", {
    description: "Recall Remnic context for a query",
    handler: commandHandler(async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        notify(ctx, "Usage: /remnic-recall <query>", "warning");
        return;
      }
      const result = await client.recall(query, sessionKeyFromContext(ctx), ctx.cwd);
      notify(ctx, trimContext(result.context ?? "(no Remnic context)", MAX_CONTEXT_CHARS), "info");
    }),
  });

  pi.registerCommand("remnic-remember", {
    description: "Store a Remnic memory",
    handler: commandHandler(async (args, ctx) => {
      const content = args.trim();
      if (!content) {
        notify(ctx, "Usage: /remnic-remember <memory>", "warning");
        return;
      }
      await client.storeMemory(content, sessionKeyFromContext(ctx));
      notify(ctx, "Stored Remnic memory", "success");
    }),
  });

  pi.registerCommand("remnic-lcm-search", {
    description: "Search Remnic LCM archived Pi context",
    handler: commandHandler(async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        notify(ctx, "Usage: /remnic-lcm-search <query>", "warning");
        return;
      }
      const result = await client.lcmSearch(query, sessionKeyFromContext(ctx));
      notify(ctx, JSON.stringify(result, null, 2), "info");
    }),
  });

  pi.registerCommand("remnic-why", {
    description: "Explain the last Remnic recall",
    handler: commandHandler(async (_args, ctx) => {
      const result = await client.recallExplain(sessionKeyFromContext(ctx));
      notify(ctx, JSON.stringify(result, null, 2), "info");
    }),
  });

  pi.registerCommand("remnic-compact", {
    description: "Trigger Pi compaction with Remnic LCM coordination",
    handler: commandHandler(async (_args, ctx) => {
      ctx.compact?.();
      notify(ctx, "Compaction requested", "info");
    }),
  });
}

function commandHandler(handler: (args: string, ctx: any) => Promise<void>): (args: string, ctx: any) => Promise<void> {
  return async (args, ctx) => {
    try {
      await handler(args, ctx);
    } catch (err) {
      notify(ctx, `Remnic command failed: ${errorMessage(err)}`, "warning");
    }
  };
}

async function registerMcpTools(pi: PiApi, client: RemnicClient, config: RemnicPiConfig): Promise<void> {
  let tools: McpTool[] = [];
  try {
    tools = await client.mcpListTools();
  } catch {
    return;
  }
  for (const tool of tools) {
    if (!tool.name.startsWith("remnic.")) continue;
    const piToolName = tool.name.replace(/^remnic\./, "remnic_").replace(/[^a-zA-Z0-9_]/g, "_");
    pi.registerTool({
      name: piToolName,
      label: tool.name,
      description: tool.description ?? `Call ${tool.name}`,
      parameters: toPiToolParametersSchema(tool.inputSchema),
      async execute(_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
        const sessionKey = sessionKeyFromContext(ctx);
        const safeParams = stripSessionOwnedRuntimeFields(params ?? {}) as Record<string, unknown>;
        const result = await client.mcpTool(tool.name, {
          ...safeParams,
          sessionKey,
          namespace: config.namespace,
          cwd: ctx.cwd,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    });
  }
}

export function toPiToolParametersSchema(inputSchema: unknown): TSchema {
  return Type.Unsafe(stripSessionOwnedSchemaFields(inputSchema));
}

export function stripSessionOwnedSchemaFields(inputSchema: unknown): Record<string, unknown> {
  if (!isRecord(inputSchema)) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return stripSessionOwnedSchemaNode(inputSchema) as Record<string, unknown>;
}

function stripSessionOwnedSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripSessionOwnedSchemaNode(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  const schema: Record<string, unknown> = { ...value };
  if (isRecord(value.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(value.properties)) {
      if (SESSION_OWNED_FIELDS.has(key)) continue;
      properties[key] = stripSessionOwnedSchemaNode(property);
    }
    schema.properties = properties;
  }
  if (Array.isArray(value.required)) {
    schema.required = value.required.filter(
      (field) => typeof field !== "string" || !SESSION_OWNED_FIELDS.has(field),
    );
  }
  for (const key of ["items", "additionalProperties", "not"] as const) {
    if (isRecord(value[key])) {
      schema[key] = stripSessionOwnedSchemaNode(value[key]);
    }
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(value[key])) {
      schema[key] = value[key].map((entry) => stripSessionOwnedSchemaNode(entry));
    }
  }
  return schema;
}

export function stripSessionOwnedRuntimeFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripSessionOwnedRuntimeFields(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SESSION_OWNED_FIELDS.has(key)) continue;
    sanitized[key] = stripSessionOwnedRuntimeFields(child);
  }
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUserMessage(message: unknown): boolean {
  return isRecord(message) && message.role === "user";
}

function getSessionState(ctx: any, states: Map<string, PiSessionState>): { sessionKey: string; state: PiSessionState } {
  const sessionKey = sessionKeyFromContext(ctx);
  let state = states.get(sessionKey);
  if (!state) {
    state = {
      observedHashes: new Set<string>(),
      liveObservedReplayKeys: new Map<string, number>(),
      lastInjectedRecallKey: "",
    };
    states.set(sessionKey, state);
    pruneSessionStates(states);
  }
  return { sessionKey, state };
}

function pruneSessionStates(states: Map<string, PiSessionState>): void {
  while (states.size > MAX_SESSION_STATES) {
    const oldest = states.keys().next().value;
    if (typeof oldest !== "string") return;
    states.delete(oldest);
  }
}

export async function observeMessages(
  ctx: any,
  client: RemnicClient,
  rawMessages: unknown[],
  observedHashes: Set<string>,
  liveObservedReplayKeys?: Map<string, number>,
): Promise<void> {
  const sessionKey = sessionKeyFromContext(ctx);
  const messages: ObserveMessage[] = [];
  const pendingHashes = new Set<string>();
  for (const raw of rawMessages) {
    const message = toObserveMessage(raw);
    if (!message) continue;
    const hash = observedMessageDedupeKey(message, sessionKey);
    if (hash && (observedHashes.has(hash) || pendingHashes.has(hash))) continue;
    if (hash) pendingHashes.add(hash);
    messages.push(message);
  }
  if (messages.length === 0) return;
  try {
    await client.observe(sessionKey, ctx.cwd, messages);
    for (const hash of pendingHashes) rememberObservedHash(observedHashes, hash);
    if (liveObservedReplayKeys) {
      for (const message of messages) {
        rememberLiveObservedReplayKey(liveObservedReplayKeys, liveReplayKey(message, sessionKey));
      }
    }
  } catch (err) {
    notify(ctx, `Remnic observe failed: ${errorMessage(err)}`, "warning");
  }
}

export function buildCompactionSummary(preparation: any): string {
  const previousSummary = typeof preparation.previousSummary === "string"
    ? preparation.previousSummary.trim()
    : "";
  const messages = [
    ...(Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize : []),
    ...(Array.isArray(preparation.turnPrefixMessages) ? preparation.turnPrefixMessages : []),
  ];
  const transcript = summarizeMessages(messages, 24000);
  const details = fileDetailsFromPreparation(preparation);

  if (
    !previousSummary &&
    !transcript &&
    details.readFiles.length === 0 &&
    details.modifiedFiles.length === 0
  ) {
    return "";
  }

  const sections: string[] = [
    "## Remnic Pi Context Checkpoint",
    "",
    "This checkpoint was created by Remnic during Pi context compaction.",
  ];
  if (previousSummary) sections.push("", "## Previous Summary", previousSummary);
  if (transcript) sections.push("", "## Conversation Excerpt", transcript);
  if (details.readFiles.length > 0) sections.push("", "<read-files>", ...details.readFiles, "</read-files>");
  if (details.modifiedFiles.length > 0) sections.push("", "<modified-files>", ...details.modifiedFiles, "</modified-files>");
  return sections.join("\n");
}

function fileDetailsFromPreparation(preparation: any): { readFiles: string[]; modifiedFiles: string[] } {
  const fileOps = preparation?.fileOps;
  const read = fileOps?.read instanceof Set ? Array.from(fileOps.read).filter(isString) : [];
  const edited = fileOps?.edited instanceof Set ? Array.from(fileOps.edited).filter(isString) : [];
  const written = fileOps?.written instanceof Set ? Array.from(fileOps.written).filter(isString) : [];
  const modified = new Set([...edited, ...written]);
  return {
    readFiles: read.filter((file) => !modified.has(file)).sort(),
    modifiedFiles: Array.from(modified).sort(),
  };
}

function restoreObservedState(ctx: any, observedHashes: Set<string>): void {
  for (const entry of safeEntries(ctx)) {
    if (entry?.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
    const hashes = entry.data?.observedHashes;
    if (Array.isArray(hashes)) {
      for (const hash of hashes) {
        if (typeof hash === "string") rememberObservedHash(observedHashes, hash);
      }
    }
  }
}

function rememberObservedHash(observedHashes: Set<string>, hash: string): void {
  if (observedHashes.has(hash)) return;
  while (observedHashes.size >= MAX_OBSERVED_HASHES) {
    const oldest = observedHashes.keys().next().value;
    if (typeof oldest !== "string") break;
    observedHashes.delete(oldest);
  }
  observedHashes.add(hash);
}

function rememberLiveObservedReplayKey(liveObservedReplayKeys: Map<string, number>, key: string): void {
  liveObservedReplayKeys.set(key, (liveObservedReplayKeys.get(key) ?? 0) + 1);
}

function consumeLiveObservedReplayKey(liveObservedReplayKeys: Map<string, number>, key: string): boolean {
  const count = liveObservedReplayKeys.get(key) ?? 0;
  if (count <= 0) return false;
  if (count === 1) liveObservedReplayKeys.delete(key);
  else liveObservedReplayKeys.set(key, count - 1);
  return true;
}

function skipLiveObservedReplayMessages(
  ctx: any,
  rawMessages: unknown[],
  liveObservedReplayKeys: Map<string, number>,
): unknown[] {
  if (liveObservedReplayKeys.size === 0) return rawMessages;
  const sessionKey = sessionKeyFromContext(ctx);
  const unobserved: unknown[] = [];
  for (const raw of rawMessages) {
    const message = toObserveMessage(raw);
    if (message && consumeLiveObservedReplayKey(liveObservedReplayKeys, liveReplayKey(message, sessionKey))) {
      continue;
    }
    unobserved.push(raw);
  }
  return unobserved;
}

function liveReplayKey(message: ObserveMessage, sessionKey: string): string {
  return hashObservedMessage(message, sessionKey, "live-replay");
}

function persistObservedState(pi: PiApi, observedHashes: Set<string>): void {
  const observed = Array.from(observedHashes).slice(-MAX_OBSERVED_HASHES);
  pi.appendEntry(STATE_CUSTOM_TYPE, {
    observedHashes: observed,
    recordedAt: new Date().toISOString(),
  });
}

async function setStatus(ctx: any, client: RemnicClient, config: RemnicPiConfig): Promise<void> {
  try {
    await client.health();
    ctx.ui?.setStatus?.("remnic", `Remnic ${config.namespace ? `(${config.namespace})` : "ready"}`);
  } catch {
    ctx.ui?.setStatus?.("remnic", "Remnic offline");
  }
}

function safeEntries(ctx: any): any[] {
  try {
    const entries = ctx.sessionManager?.getEntries?.();
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function safeBranch(ctx: any): any[] {
  try {
    const branch = ctx.sessionManager?.getBranch?.();
    return Array.isArray(branch) ? branch : [];
  } catch {
    return [];
  }
}

function branchMessagesWithEntryIdentity(branch: any[]): unknown[] {
  const messages: unknown[] = [];
  for (const entry of branch) {
    const message = messageWithEntryIdentity(entry);
    if (message) messages.push(message);
  }
  return messages;
}

function messageWithEntryIdentity(entry: any): unknown | null {
  const message = entry?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return message ?? null;

  const source = isRecord(entry) ? entry : {};
  const enriched: Record<string, unknown> = { ...(message as Record<string, unknown>) };
  assignMissingIdentity(enriched, "entryId", source.id ?? source.entryId ?? source.entry_id);
  assignMissingIdentity(enriched, "timestamp", source.timestamp);
  assignMissingIdentity(enriched, "createdAt", source.createdAt ?? source.created_at);
  return enriched;
}

function assignMissingIdentity(target: Record<string, unknown>, field: string, value: unknown): void {
  if (target[field] !== undefined) return;
  if (typeof value === "string" && value.length > 0) {
    target[field] = value;
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    target[field] = value;
  }
}

function trimContext(value: string, budget: number): string {
  if (value.length <= budget) return value;
  if (budget <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, budget);
  return `${value.slice(0, budget - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`;
}

function notify(ctx: any, message: string, level: "info" | "success" | "warning" | "error"): void {
  if (ctx?.hasUI === false) return;
  ctx?.ui?.notify?.(message, level);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function finiteTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export { textFromMessage };
