export type LocalSessionRole = "user" | "assistant" | "tool" | "system" | "other";

export interface LocalSessionTurn {
  role: LocalSessionRole;
  content: string;
  timestamp?: string;
  sessionKey?: string;
  sourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface LocalSessionParseWarning {
  code: string;
  message: string;
  fileRef?: string;
  line?: number;
}

export interface LocalSessionParsedFile {
  turns: LocalSessionTurn[];
  warnings: LocalSessionParseWarning[];
}

export interface LocalSessionAdapterInput {
  content: string;
  fileName: string;
  fileExtension: string;
  fileRef: string;
}

export interface LocalSessionAdapterOptions {
  strict?: boolean;
}

export interface LocalSessionSourceAdapter {
  id: string;
  parseFile(
    input: LocalSessionAdapterInput,
    options?: LocalSessionAdapterOptions
  ): LocalSessionParsedFile | Promise<LocalSessionParsedFile>;
}

export interface RedactionRuleConfig {
  name: string;
  pattern: string;
  flags?: string;
  replacement?: string;
}

export interface RedactionConfig {
  disableDefaults?: boolean;
  rules?: RedactionRuleConfig[];
}

export interface CompiledRedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

export interface RedactionReport {
  applied: number;
  ruleNames: string[];
}

export interface SessionSummaryExcerpt {
  role: LocalSessionRole;
  text: string;
  timestamp?: string;
}

export interface SessionSummaryDraft {
  schemaVersion: 1;
  draftId: string;
  generatedAt: string;
  sourceAdapter: string;
  sourceSessionRef: string;
  sourceFileCount: number;
  sourceFileRefs: Array<{
    hash: string;
    extension: string;
  }>;
  firstTimestamp?: string;
  lastTimestamp?: string;
  turnCount: number;
  roles: Record<LocalSessionRole, number>;
  summary: string;
  redaction: {
    enabled: boolean;
    applied: number;
    ruleNames: string[];
  };
  excerpts?: SessionSummaryExcerpt[];
  metadata: {
    storesRawTranscript: false;
    storesLocalPaths: false;
    storesSourceSessionKey: false;
  };
}

export interface CollectLocalSessionSummariesOptions {
  inputDir: string;
  source?: string;
  strict?: boolean;
  redactionConfig?: RedactionConfig;
  includeRedactedExcerpts?: boolean;
  maxFiles?: number;
  maxSessions?: number;
  now?: Date;
}

export interface LocalSessionSummaryReport {
  generatedAt: string;
  source: string;
  filesScanned: number;
  filesParsed: number;
  turnsParsed: number;
  sessionsSummarized: number;
  warnings: LocalSessionParseWarning[];
  drafts: SessionSummaryDraft[];
  wroteFiles: string[];
}

export interface LocalSessionSummaryCliOptions extends CollectLocalSessionSummariesOptions {
  memoryDir?: string;
  output?: string;
  write?: boolean;
  redactionConfigPath?: string;
  stdout?: Pick<NodeJS.WritableStream, "write">;
}
