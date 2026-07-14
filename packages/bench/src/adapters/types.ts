/**
 * Shared adapter contract for benchmarks running against Remnic memory systems.
 */

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  /** Optional source timestamp for benchmarks with historical query times. */
  timestamp?: string;
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

export interface BenchPhaseControl {
  signal?: AbortSignal;
}

export type BenchRecallSupportStatus =
  | "supported"
  | "weak"
  | "empty"
  | "unavailable"
  | "backend_failure";

/**
 * Answer-time support signal for the exact recall text supplied to the
 * responder. `weak` is intentionally explicit: callers must not infer it from
 * a zero-hit auxiliary search when `recalledText` contains evidence from other
 * retrieval tiers.
 */
export interface BenchRecallSupportAssessment {
  status: BenchRecallSupportStatus;
  reason?: string;
  evidenceCount?: number;
  maxScore?: number;
  supportThreshold?: number;
}

export interface BenchRecallSupportRequest {
  query: string;
  recalledText: string;
  sessionIds: readonly string[];
}

export interface BenchResponder {
  respond(
    question: string,
    recalledText: string,
    control?: BenchPhaseControl,
  ): Promise<BenchResponse>;
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

export interface MemCorrectJudgeRequest {
  taskId: string;
  query: string;
  retiredContent: string[];
  correctedContent: string[];
  postCorrectionRecall: string[];
  postMaintenanceRecall: string[];
  postReingestRecall: string[];
}

export interface MemCorrectJudgeResult extends BenchJudgeResult {
  decision: "pass" | "partial" | "fail";
  reason: string;
  rubricVersion: string;
}

export interface BenchJudge {
  score(
    question: string,
    predicted: string,
    expected: string,
    control?: BenchPhaseControl,
  ): Promise<number>;
  scoreWithMetrics?(
    question: string,
    predicted: string,
    expected: string,
    control?: BenchPhaseControl,
  ): Promise<BenchJudgeResult>;
  /**
   * Run a benchmark-supplied yes/no judging prompt directly and return a
   * normalized 0/1 score. Published benchmarks such as LongMemEval define
   * their own evaluator prompt; routing those through the scalar generic
   * judge prompt would change the metric contract.
   */
  scoreBinaryPrompt?(
    prompt: string,
    control?: BenchPhaseControl,
  ): Promise<BenchJudgeResult>;
  judgeMemCorrectCorrectionAcceptance?(
    request: MemCorrectJudgeRequest,
    control?: BenchPhaseControl,
  ): Promise<MemCorrectJudgeResult>;
  judgeMemCorrectStaleMemoryHarm?(
    request: MemCorrectJudgeRequest,
    control?: BenchPhaseControl,
  ): Promise<MemCorrectJudgeResult>;
}

export interface BenchMemoryAdapter {
  store(
    sessionId: string,
    messages: Message[],
    control?: BenchPhaseControl,
  ): Promise<void>;
  recall(
    sessionId: string,
    query: string,
    budgetChars?: number,
    options?: BenchRecallOptions,
    control?: BenchPhaseControl,
  ): Promise<string>;
  /**
   * Optionally assess support using the exact, final recall context that will
   * be sent to the responder. Implementations may return `weak` only from
   * explicit evidence-confidence signals derived from that context.
   */
  assessRecallSupport?(
    request: BenchRecallSupportRequest,
    control?: BenchPhaseControl,
  ): Promise<BenchRecallSupportAssessment>;
  search(
    query: string,
    limit: number,
    sessionId?: string,
    control?: BenchPhaseControl,
  ): Promise<SearchResult[]>;
  /**
   * Optional explicit-correction surface (issue #1584 plan item 2a). Routes a
   * natural-language correction through the system's correction contract
   * (plan + confirmed apply) instead of a plain turn store. Resolves
   * `{ applied: false }` when the planner produced no applicable actions so
   * the caller can fall back to the turn path. Adapters without an explicit
   * correction surface omit this method entirely.
   */
  correct?(
    sessionId: string,
    text: string,
    at?: string,
    control?: BenchPhaseControl,
  ): Promise<{ applied: boolean }>;
  reset(sessionId?: string, control?: BenchPhaseControl): Promise<void>;
  getStats(sessionId?: string, control?: BenchPhaseControl): Promise<MemoryStats>;
  /** Wait for background summarization (e.g. LCM) to finish after store(). */
  drain?(control?: BenchPhaseControl): Promise<void>;
  destroy(): Promise<void>;
  responder?: BenchResponder;
  judge?: BenchJudge;
}

export interface BenchRecallOptions {
  /** Optional historical recall timestamp for benchmarks that expose query time. */
  asOf?: string;
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
