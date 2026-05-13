declare module "openclaw/plugin-sdk" {
  export interface OpenClawLogger {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  }

  // ---- Typed hook event/context interfaces (new SDK) ----

  export interface PluginHookAgentContext {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    messageProvider?: string;
    trigger?: string;
    channelId?: string;
  }

  export interface PluginHookGatewayContext {
    port?: number;
  }

  export interface PluginHookBeforePromptBuildEvent {
    prompt?: string;
    messages?: Array<Record<string, unknown>>;
  }

  export interface PluginHookBeforeAgentStartEvent {
    prompt?: string;
    messages?: Array<Record<string, unknown>>;
  }

  export interface PluginHookAgentEndEvent {
    messages?: Array<Record<string, unknown>>;
    success?: boolean;
    error?: unknown;
    durationMs?: number;
  }

  export interface PluginHookBeforeCompactionEvent {
    messageCount?: number;
    compactingCount?: number;
    tokenCount?: number;
    messages?: Array<Record<string, unknown>>;
    sessionFile?: string;
  }

  export interface PluginHookAfterCompactionEvent {
    messageCount?: number;
    compactedCount?: number;
    tokenCount?: number;
    sessionFile?: string;
    sessionKey?: string;
  }

  export interface PluginHookBeforeResetEvent {
    sessionFile?: string;
    messages?: Array<Record<string, unknown>>;
    reason?: string;
  }

  export interface PluginHookGatewayStartEvent {
    port?: number;
  }

  export interface PluginHookBeforeToolCallEvent {
    toolName?: string;
    toolInput?: Record<string, unknown>;
    sessionKey?: string;
  }

  export interface PluginHookAfterToolCallEvent {
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: unknown;
    sessionKey?: string;
    durationMs?: number;
  }

  export interface PluginHookLlmInputEvent {
    provider?: string;
    model?: string;
    messages?: Array<Record<string, unknown>>;
    sessionKey?: string;
  }

  export interface PluginHookLlmOutputEvent {
    provider?: string;
    model?: string;
    response?: Record<string, unknown>;
    sessionKey?: string;
    durationMs?: number;
    tokenUsage?: { input?: number; output?: number };
  }

  export interface PluginHookSessionEvent {
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
  }

  export interface PluginHookSubagentSpawningEvent {
    parentSessionKey?: string;
    subagentId?: string;
    purpose?: string;
  }

  export interface PluginHookSubagentEndedEvent {
    parentSessionKey?: string;
    subagentId?: string;
    success?: boolean;
    durationMs?: number;
  }

  // ---- Memory prompt section builder (new SDK) ----

  export interface MemoryPromptSectionBuilder {
    id: string;
    label?: string;
    build: (context: {
      prompt: string;
      sessionKey: string;
      agentId?: string;
      workspaceDir?: string;
    }) => Promise<string | null | undefined> | string | null | undefined;
  }

  // ---- Memory capability types (new SDK >=2026.4.5) ----

  export type MemoryPluginPublicArtifactContentType = "markdown" | "json" | "text";

  export interface MemoryPluginPublicArtifact {
    kind: string;
    workspaceDir: string;
    relativePath: string;
    absolutePath: string;
    agentIds: string[];
    contentType: MemoryPluginPublicArtifactContentType;
  }

  export interface MemoryPluginPublicArtifactsProvider {
    listArtifacts(params: { cfg: unknown }): Promise<MemoryPluginPublicArtifact[]>;
  }

  export interface MemoryPluginCapability {
    promptBuilder?: MemoryPromptSectionBuilder["build"] | ((...args: any[]) => any);
    flushPlanResolver?: (...args: any[]) => any;
    runtime?: Record<string, unknown>;
    publicArtifacts?: MemoryPluginPublicArtifactsProvider;
  }

  export interface MemoryCorpusSearchResult {
    corpus: string;
    path: string;
    title?: string;
    kind?: string;
    score: number;
    snippet: string;
    id?: string;
    startLine?: number;
    endLine?: number;
    citation?: string;
    source?: string;
    provenanceLabel?: string;
    sourceType?: string;
    sourcePath?: string;
    updatedAt?: string;
  }

  export interface MemoryCorpusGetResult {
    corpus: string;
    path: string;
    title?: string;
    kind?: string;
    content: string;
    fromLine: number;
    lineCount: number;
    id?: string;
    provenanceLabel?: string;
    sourceType?: string;
    sourcePath?: string;
    updatedAt?: string;
  }

  export interface MemoryCorpusSupplement {
    id?: string;
    label?: string;
    search(params: {
      query: string;
      maxResults?: number;
      agentSessionKey?: string;
    }): Promise<MemoryCorpusSearchResult[]>;
    get(params: {
      lookup: string;
      fromLine?: number;
      lineCount?: number;
      agentSessionKey?: string;
    }): Promise<MemoryCorpusGetResult | null>;
  }

  // ---- Runtime namespace (new SDK) ----

  export interface OpenClawRuntime {
    version?: string;
    agent?: {
      id?: string;
      workspaceDir?: string;
      session?: Record<string, unknown>;
    };
    [key: string]: unknown;
  }

  // ---- Hook name union ----

  export type OpenClawHookName =
    | "gateway_start"
    | "gateway_stop"
    | "before_model_resolve"
    | "before_prompt_build"
    | "before_agent_start"
    | "agent_end"
    | "before_compaction"
    | "after_compaction"
    | "before_reset"
    | "llm_input"
    | "llm_output"
    | "before_tool_call"
    | "after_tool_call"
    | "tool_result_persist"
    | "before_message_write"
    | "message_received"
    | "message_sending"
    | "message_sent"
    | "inbound_claim"
    | "session_start"
    | "session_end"
    | "subagent_spawning"
    | "subagent_delivery_target"
    | "subagent_spawned"
    | "subagent_ended"
    | string;

  // ---- Plugin API ----

  export interface OpenClawPluginApi {
    logger: OpenClawLogger;
    /** Plugin-specific config block from openclaw.json */
    pluginConfig?: Record<string, unknown>;
    /** Gateway config snapshot (models/providers/agents defaults) */
    config?: unknown;
    on: (
      hook: OpenClawHookName,
      handler: (...args: any[]) => any,
    ) => void;

    registerService: (spec: {
      id: string;
      start?: () => Promise<void> | void;
      stop?: () => Promise<void> | void;
    }) => void;
    registerTool?: (spec: Record<string, unknown>) => void;

    // ---- New SDK methods (may not exist on older runtimes) ----

    /** Register a memory prompt section builder (new SDK >=2026.3.22).
     *  Gateway <=2026.3.22 expects a bare function; future versions may
     *  accept the structured MemoryPromptSectionBuilder object. */
    registerMemoryPromptSection?: (builder: MemoryPromptSectionBuilder | MemoryPromptSectionBuilder["build"]) => void;

    /** Register slash commands when supported by the runtime. */
    registerCommand?: (spec: Record<string, unknown>) => void;

    /** Register the full memory capability for this memory plugin (exclusive slot).
     *  New SDK >=2026.4.5. Replaces the deprecated split registration methods
     *  (registerMemoryPromptSection, registerMemoryFlushPlan, registerMemoryRuntime). */
    registerMemoryCapability?: (capability: MemoryPluginCapability) => void;

    /** Register the active memory runtime adapter on split-surface SDKs. */
    registerMemoryRuntime?: (runtime: Record<string, unknown>) => void;

    /** Register the pre-compaction memory flush plan on split-surface SDKs. */
    registerMemoryFlushPlan?: (resolver: (...args: any[]) => any) => void;

    /** Register an additive memory corpus supplement. */
    registerMemoryCorpusSupplement?: (supplement: MemoryCorpusSupplement | Record<string, unknown>) => void;

    /** Register an additive memory prompt supplement. */
    registerMemoryPromptSupplement?: (builder: MemoryPromptSectionBuilder["build"] | ((...args: any[]) => any)) => void;

    /** Registration mode: "full" | "discovery" | "tool-discovery" | "setup-only" | "setup-runtime" | "cli-metadata" (new SDK >=2026.3.22) */
    registrationMode?:
      | "full"
      | "discovery"
      | "tool-discovery"
      | "setup-only"
      | "setup-runtime"
      | "cli-metadata";

    /** Runtime namespace (new SDK >=2026.3.22) */
    runtime?: OpenClawRuntime;
  }
}

declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

  export interface PluginEntryDefinition {
    id: string;
    name: string;
    description?: string;
    kind?: "memory" | "context-engine" | string;
    register: (api: OpenClawPluginApi) => void;
  }

  export function definePluginEntry(def: PluginEntryDefinition): PluginEntryDefinition;
}

declare module "openclaw/plugin-sdk/memory-core" {
  export { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk";
}
