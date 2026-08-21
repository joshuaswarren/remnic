export type CompatLevel = "ok" | "warn" | "error";

export interface CompatCheckResult {
  id: string;
  title: string;
  level: CompatLevel;
  message: string;
  remediation?: string;
  metadata?: Record<string, unknown>;
}

export interface CompatSummary {
  ok: number;
  warn: number;
  error: number;
}

export interface CompatReport {
  generatedAt: string;
  checks: CompatCheckResult[];
  summary: CompatSummary;
}

export interface CompatRunner {
  commandExists(command: string): Promise<boolean>;
}

export interface CompatCheckOptions {
  repoRoot: string;
  runner?: CompatRunner;
  now?: Date;
  currentNodeVersion?: string;
}
