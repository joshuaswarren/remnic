/**
 * Shared adapter contract for benchmarks running against Remnic memory systems.
 */

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SearchResult {
  turnIndex: number;
  role: string;
  snippet: string;
  sessionId: string;
  score?: number;
}

export interface MemoryStats {
  totalMessages: number;
  totalSummaryNodes: number;
  maxDepth: number;
  maxTurnIndex?: number;
}

export interface BenchResponse {
  text: string;
  tokens: {
    input: number;
    output: number;
  };
  latencyMs: number;
  model: string;
}

export interface BenchResponder {
  respond(question: string, recalledText: string): Promise<BenchResponse>;
}

export interface BenchJudgeResult {
  score: number;
  tokens: {
    input: number;
    output: number;
  };
  latencyMs: number;
  model?: string;
}

export interface BenchJudge {
  score(question: string, predicted: string, expected: string): Promise<number>;
  scoreWithMetrics?(
    question: string,
    predicted: string,
    expected: string,
  ): Promise<BenchJudgeResult>;
}

export interface BenchMemoryAdapter {
  store(sessionId: string, messages: Message[]): Promise<void>;
  recall(sessionId: string, query: string, budgetChars?: number): Promise<string>;
  search(query: string, limit: number, sessionId?: string): Promise<SearchResult[]>;
  reset(sessionId?: string): Promise<void>;
  getStats(sessionId?: string): Promise<MemoryStats>;
  /** Wait for background summarization (e.g. LCM) to finish after store(). */
  drain?(): Promise<void>;
  destroy(): Promise<void>;
  responder?: BenchResponder;
  judge?: BenchJudge;
}

// Legacy aliases preserved while the old eval adapters finish migrating into
// the phase-1 bench package.
export type LlmJudge = BenchJudge;
export type MemorySystem = BenchMemoryAdapter;

export interface TaskScore {
  taskId: string;
  metrics: Record<string, number>;
  details?: Record<string, unknown>;
  latencyMs: number;
}

export interface LegacyBenchmarkMeta {
  name: string;
  version: string;
  description: string;
  category: "agentic" | "retrieval" | "conversational" | "ingestion";
  citation?: string;
}

export interface LegacyBenchmarkResult {
  meta: LegacyBenchmarkMeta;
  engramVersion: string;
  gitSha: string;
  timestamp: string;
  adapterMode: "direct" | "mcp";
  taskCount: number;
  scores: TaskScore[];
  aggregate: Record<string, number>;
  config: Record<string, unknown>;
  durationMs: number;
}

export interface LegacyBenchmarkRunner {
  meta: LegacyBenchmarkMeta;
  run(
    system: MemorySystem,
    options: { limit?: number; datasetDir: string },
  ): Promise<LegacyBenchmarkResult>;
}
