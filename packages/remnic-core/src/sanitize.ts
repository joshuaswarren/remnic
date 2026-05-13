const rx = (...parts: string[]): RegExp => new RegExp(parts.join(""), "i");

const INJECTION_PATTERNS: RegExp[] = [
  rx("ignore\\s+(all\\s+)?", "(previous|prior|above)", "\\s+(instructions?|prompts?|context)"),
  rx("forget\\s+", "(everything|all|previous|what)"),
  rx(
    "new\\s+(",
    "system",
    "\\s+)?",
    "prompt:",
  ),
  rx("\\[", "system", "\\]"),
  rx("<\\s*", "system", "\\s*>"),
  rx("you\\s+are\\s+now\\s+(?!called|named)"),
  rx("disregard\\s+(all\\s+)?", "(previous|prior)"),
  rx(
    "over",
    "ride\\s+(previous\\s+)?",
    "(instructions?|",
    "prompt)",
  ),
  rx("act\\s+as\\s+(?:an?\\s+)?(?:AI|assistant|ChatGPT|GPT|Claude|LLM)\\s+(?:without|that\\s+ignores)"),
  rx("do\\s+not\\s+(?:follow|obey)\\s+(?:previous|prior|your)\\s+", "instructions"),
  rx("pretend\\s+(?:you\\s+)?(?:have\\s+no|you\\s+don.?t\\s+have)\\s+(restrictions|guidelines|rules)"),
];

export type SanitizeResult = {
  clean: boolean;
  text: string;
  violations: string[];
};

const REDACTED_PLACEHOLDER = "[content removed: unsafe memory text]";

export function sanitizeMemoryContent(text: string): SanitizeResult {
  const source = typeof text === "string" ? text : "";
  const violations: string[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(source)) {
      violations.push(pattern.source);
    }
  }

  if (violations.length === 0) {
    return { clean: true, text: source, violations: [] };
  }

  return {
    clean: false,
    text: REDACTED_PLACEHOLDER,
    violations,
  };
}

export function isSafeMemoryContent(text: string): boolean {
  return sanitizeMemoryContent(text).clean;
}
