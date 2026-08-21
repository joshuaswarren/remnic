// Type declarations for the plain-JS AMB Remnic bridge runtime (remnic-bridge.mjs).
// Hand-authored to give the test call sites real parameter/return types.

export interface AmbDocument {
  id?: string | number;
  user_id?: string | number | null;
  timestamp?: string;
  content?: string;
  [key: string]: unknown;
}

export interface AmbMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

export interface AmbRecallDocument {
  id: string;
  content: string;
  user_id: string | null;
}

export interface AmbRecallOptions {
  asOf?: string;
}

export interface AmbRetrieveResult {
  documents: AmbRecallDocument[];
  raw_response: {
    session_count: number;
    returned_chars: number;
    query_timestamp: string | null;
    user_id: string | null;
    session_budget_chars?: number;
  };
}

export interface RemnicAmbAdapter {
  reset(): Promise<void> | void;
  store(sessionId: string, messages: AmbMessage[]): Promise<void> | void;
  recall(
    sessionId: string,
    query: string,
    budgetChars: number,
    options?: AmbRecallOptions,
  ): Promise<string> | string;
  destroy(): Promise<void> | void;
  drain?(): Promise<void> | void;
}

export interface RemnicAmbBridgeOptions {
  sessionPrefix?: string;
  recallBudgetChars?: number;
  groupDocumentsByUser?: boolean;
  resetBeforeIngest?: boolean;
  drainAfterIngest?: boolean;
  sessionIndexPath?: string;
}

export interface RemnicAmbRetrieveArgs {
  query: string;
  k?: number;
  user_id?: string | number | null;
  query_timestamp?: string;
}

export interface AmbInternalProviderOptions {
  runtimeProfile: string;
  internalProvider: string;
  internalModel: string;
  internalBaseUrl?: string;
  internalApiKey?: string;
  internalCodexReasoningEffort?: string;
  requestTimeout?: number;
  internalDisableThinking?: boolean;
}

export interface AmbBenchRuntimeProfile {
  effectiveRemnicConfig: Record<string, unknown>;
  internalProvider?: Record<string, unknown> | null;
  adapterOptions?: { drainTimeoutMs?: number };
}

export interface AmbBenchModule {
  resolveBenchRuntimeProfile?(
    options: AmbInternalProviderOptions,
  ): Promise<AmbBenchRuntimeProfile> | AmbBenchRuntimeProfile;
  createRemnicAdapter?(...args: unknown[]): unknown;
  [key: string]: unknown;
}

export interface AmbAdapterOptionsResult {
  configOverrides: Record<string, unknown>;
  internalProvider: Record<string, unknown> | null;
  drainTimeoutMs?: number;
}

export declare function resolveAmbReplaySourceValidAtMode(
  env?: Record<string, string | undefined>,
): "historical" | "batch";

export declare function buildAmbSessionId(
  document: AmbDocument,
  index: number,
  prefix?: string,
): string;

export declare function buildAmbStorageSessionId(
  document: AmbDocument,
  index: number,
  prefix?: string,
  options?: { groupDocumentsByUser?: boolean },
): string;

export declare function buildAmbMessages(document: AmbDocument): AmbMessage[];

export declare function buildAmbRecallDocuments(
  recalledText: string,
  args?: { k?: number; user_id?: string | number | null },
): AmbRecallDocument[];

export declare function ambRecallBudgetForSessionCount(
  totalBudgetChars: number,
  sessionCount: number,
): number;

export declare function joinAmbRecallChunks(
  chunks: string[],
  budgetChars: number,
): string;

export declare function buildAmbRecallQuery(
  query: string,
  queryTimestamp?: string,
): string;

export declare function loadRemnicAmbConfig(
  env?: Record<string, string | undefined>,
): Promise<Record<string, unknown>>;

export declare function buildRemnicAmbAdapterOptions(
  benchModule: AmbBenchModule,
  env?: Record<string, string | undefined>,
): Promise<AmbAdapterOptionsResult>;

export declare function parseJsonlBridgeRequest(line: string): Record<string, unknown>;

export declare class RemnicAmbBridge {
  constructor(adapter: RemnicAmbAdapter, options: RemnicAmbBridgeOptions);
  reset(): Promise<void>;
  recordSession(sessionId: string, userId: string): void;
  loadSessionIndex(): Promise<void>;
  persistSessionIndex(): Promise<void>;
  ingest(documents: AmbDocument[]): Promise<void>;
  retrieve(args: RemnicAmbRetrieveArgs): Promise<AmbRetrieveResult>;
  cleanup(): Promise<void>;
}
