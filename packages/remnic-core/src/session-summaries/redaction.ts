import type { CompiledRedactionRule, RedactionConfig, RedactionReport } from "./types.js";

export const DEFAULT_REDACTION_RULES: readonly CompiledRedactionRule[] = [
  {
    name: "secret-token",
    pattern:
      /(?<![A-Za-z0-9_])(?:sk-[A-Za-z0-9_-]{12,}|sk-proj-[A-Za-z0-9_-]{12,}|(?:"authorization"|'authorization'|authorization)\s*[:=]\s*(?:"[A-Za-z][A-Za-z0-9._-]*\s+[^"\r\n]*"|'[A-Za-z][A-Za-z0-9._-]*\s+[^'\r\n]*'|[A-Za-z][A-Za-z0-9._-]*\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;]+))|(?:"(?:[A-Za-z0-9]+[_-]+)*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password)"|'(?:[A-Za-z0-9]+[_-]+)*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password)'|(?:[A-Za-z0-9]+[_-]+)*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password))\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"',;]+))/gi,
    replacement: "[REDACTED_SECRET]",
  },
  {
    name: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    name: "private-ip",
    pattern:
      /\b(?:(?:10|127)\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})\b/g,
    replacement: "[REDACTED_PRIVATE_IP]",
  },
  {
    name: "url",
    pattern: /\bhttps?:\/\/[^\s"'<>)]*/gi,
    replacement: "[REDACTED_URL]",
  },
  {
    name: "home-relative-posix-spaced-path",
    pattern:
      /~\/(?:[^/\s"',;<>]+(?: [^/\s"',;<>]+)*\/)*[^/\s"',;<>]+(?: (?!(?:before|after|then|and|or)\b)[^/\s"',;<>]+)+\.[^/\s"',;<>]+?(?=$|[\s"',;<>)]|[.,](?:\s|$))/g,
    replacement: "[REDACTED_PATH]",
  },
  {
    name: "home-relative-posix-spaced-extensionless-path",
    pattern:
      /~\/(?:[^/\s"',;<>]+(?: [^/\s"',;<>]+)*\/)*[^/\s"',;<>]+(?: (?!(?:before|after|then|and(?=\s+[a-z])|or(?=\s+[a-z]))\b)[^/\s"',;<>]+)+?(?=$|["'<>)](?!\/)|[,;.]|\s+(?:before|after|then|and(?=\s+(?:[a-z]|[~/"']|$))|or(?=\s+(?:[a-z]|[~/"']|$)))\b)/g,
    replacement: "[REDACTED_PATH]",
  },
  {
    name: "home-relative-posix-path",
    pattern: /~\/(?:[^/\s"',;<>]+(?: [^/\s"',;<>]+)*\/)*[^/\s"',;<>]+?(?=$|[\s"',;<>)]|[.,](?:\s|$))/g,
    replacement: "[REDACTED_PATH]",
  },
  {
    name: "absolute-posix-spaced-path",
    pattern:
      /\/(?:[^/\s"',;<>]+(?: [^/\s"',;<>]+)*\/)*[^/\s"',;<>]+(?: (?!(?:before|after|then|and|or)\b)[^/\s"',;<>]+)+\.[^/\s"',;<>]+?(?=$|[\s"',;<>)]|[.,](?:\s|$))/g,
    replacement: "[REDACTED_PATH]",
  },
  {
    name: "absolute-posix-spaced-extensionless-path",
    pattern:
      /\/(?:[^/\s"',;<>]+(?: [^/\s"',;<>]+)*\/)*[^/\s"',;<>]+(?: (?!(?:before|after|then|and(?=\s+[a-z])|or(?=\s+[a-z]))\b)[^/\s"',;<>]+)+?(?=$|["'<>)](?!\/)|[,;.]|\s+(?:before|after|then|and(?=\s+(?:[a-z]|[~/"']|$))|or(?=\s+(?:[a-z]|[~/"']|$)))\b)/g,
    replacement: "[REDACTED_PATH]",
  },
  {
    name: "absolute-posix-path",
    pattern: /\/(?:[^/\s"',;<>]+(?: [^/\s"',;<>]+)*\/)*[^/\s"',;<>]+?(?=$|[\s"',;<>)]|[.,](?:\s|$))/g,
    replacement: "[REDACTED_PATH]",
  },
  {
    name: "absolute-windows-spaced-path",
    pattern:
      /\b[A-Za-z]:\\(?:[^\\/:*?"<>|,;\r\n]+\\)*[^\\/:*?"<>|,;\s\r\n]+(?: [^\\/:*?"<>|,;\s\r\n]+)+\.[A-Za-z0-9_-]+/g,
    replacement: "[REDACTED_PATH]",
  },
  {
    name: "absolute-windows-spaced-extensionless-path",
    pattern:
      /\b[A-Za-z]:\\(?:[^\\/:*?"<>|,;\r\n]+\\)*[^\\/:*?"<>|,;\s\r\n]+(?: [^\\/:*?"<>|,;\s\r\n]+)+(?=$|["'<>)](?!\\)|[,;.]|\s+(?:before|after|then|and|or)\b)/gi,
    replacement: "[REDACTED_PATH]",
  },
  {
    name: "absolute-windows-path",
    pattern: /\b[A-Za-z]:\\(?:[^\\/:*?"<>|,;\r\n]+\\)*[^\\/:*?"<>|,;\s\r\n]+/g,
    replacement: "[REDACTED_PATH]",
  },
  {
    name: "unc-windows-spaced-path",
    pattern:
      /\\\\[^\\/:*?"<>|,;\s\r\n]+\\[^\\/:*?"<>|,;\r\n]+\\(?:[^\\/:*?"<>|,;\r\n]+\\)*[^\\/:*?"<>|,;\s\r\n]+(?: [^\\/:*?"<>|,;\s\r\n]+)+\.[A-Za-z0-9_-]+/g,
    replacement: "[REDACTED_PATH]",
  },
  {
    name: "unc-windows-spaced-extensionless-path",
    pattern:
      /\\\\[^\\/:*?"<>|,;\s\r\n]+\\[^\\/:*?"<>|,;\r\n]+\\(?:[^\\/:*?"<>|,;\r\n]+\\)*[^\\/:*?"<>|,;\s\r\n]+(?: [^\\/:*?"<>|,;\s\r\n]+)+(?=$|["'<>)](?!\\)|[,;.]|\s+(?:before|after|then|and|or)\b)/gi,
    replacement: "[REDACTED_PATH]",
  },
  {
    name: "unc-windows-share-root",
    pattern: /\\\\[^\\/:*?"<>|,;\s\r\n]+\\[^\\/:*?"<>|,;\s\r\n]+(?=$|[\s"',;<>)]|[.,](?:\s|$))/g,
    replacement: "[REDACTED_PATH]",
  },
  {
    name: "unc-windows-path",
    pattern: /\\\\[^\\/:*?"<>|,;\s\r\n]+\\[^\\/:*?"<>|,;\r\n]+\\(?:[^\\/:*?"<>|,;\r\n]+\\)*[^\\/:*?"<>|,;\s\r\n]+/g,
    replacement: "[REDACTED_PATH]",
  },
];

function cloneRedactionRule(rule: CompiledRedactionRule): CompiledRedactionRule {
  return {
    name: rule.name,
    pattern: new RegExp(rule.pattern.source, rule.pattern.flags),
    replacement: rule.replacement,
  };
}

export function compileRedactionRules(config: RedactionConfig = {}): CompiledRedactionRule[] {
  const rules: CompiledRedactionRule[] =
    config.disableDefaults === true ? [] : DEFAULT_REDACTION_RULES.map(cloneRedactionRule);
  const customRules = config.rules ?? [];
  if (!Array.isArray(customRules)) {
    throw new Error("redaction rules must be an array");
  }
  for (const rule of customRules) {
    if (!rule || typeof rule !== "object") {
      throw new Error("redaction rule must be an object");
    }
    if (typeof rule.name !== "string" || rule.name.trim().length === 0) {
      throw new Error("redaction rule name must be a non-empty string");
    }
    if (typeof rule.pattern !== "string" || rule.pattern.length === 0) {
      throw new Error(`redaction rule '${rule.name}' pattern must be non-empty`);
    }
    const flags = rule.flags ?? "g";
    rules.push({
      name: rule.name.trim(),
      pattern: new RegExp(rule.pattern, flags.includes("g") ? flags : `${flags}g`),
      replacement: rule.replacement ?? `[REDACTED_${rule.name.trim().toUpperCase()}]`,
    });
  }
  return rules;
}

export function redactSessionSummaryText(
  text: string,
  rules: readonly CompiledRedactionRule[]
): { text: string; report: RedactionReport } {
  let redacted = text;
  let applied = 0;
  const ruleNames = new Set<string>();

  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    const matches = redacted.match(rule.pattern);
    if (!matches || matches.length === 0) continue;
    applied += matches.length;
    ruleNames.add(rule.name);
    redacted = redacted.replace(rule.pattern, rule.replacement);
  }

  return {
    text: redacted,
    report: {
      applied,
      ruleNames: [...ruleNames].sort(),
    },
  };
}
