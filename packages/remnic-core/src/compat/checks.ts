import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { CompatCheckOptions, CompatCheckResult, CompatReport, CompatRunner } from "./types.js";
import { compareVersions } from "../version-utils.js";
import { launchProcess } from "../runtime/child-process.js";

const REQUIRED_HOOKS_LEGACY = ["before_agent_start", "agent_end"];
const REQUIRED_HOOKS_NEW = ["before_prompt_build", "agent_end"];
const OPENCLAW_REMNIC_PLUGIN_ID = "openclaw-remnic";
const OPENCLAW_REMNIC_LEGACY_PLUGIN_ID = "openclaw-engram";

function isSafeCommandToken(command: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(command);
}

const defaultRunner: CompatRunner = {
  async commandExists(command: string): Promise<boolean> {
    if (!isSafeCommandToken(command)) return false;
    const binary = process.platform === "win32" ? "where" : "which";
    const args = [command];
    return new Promise<boolean>((resolve) => {
      const child = launchProcess(binary, args, { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
  },
};

function summarize(checks: CompatCheckResult[]): { ok: number; warn: number; error: number } {
  const out = { ok: 0, warn: 0, error: 0 };
  for (const check of checks) {
    out[check.level] += 1;
  }
  return out;
}

function stripCommentsAndStrings(source: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      out.push(" ", " ");
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < source.length) {
        const c = source[i];
        const n = source[i + 1];
        out.push(c === "\n" ? "\n" : " ");
        i += 1;
        if (c === "*" && n === "/") {
          out.push(" ");
          i += 1;
          break;
        }
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out.push(" ");
      i += 1;
      while (i < source.length) {
        const c = source[i];
        if (c === "\\") {
          out.push(" ");
          i += 1;
          if (i < source.length) {
            out.push(source[i] === "\n" ? "\n" : " ");
            i += 1;
          }
          continue;
        }
        out.push(c === "\n" ? "\n" : " ");
        i += 1;
        if (c === quote) break;
      }
      continue;
    }

    out.push(ch);
    i += 1;
  }
  return out.join("");
}

function parseHookRegistrations(source: string): Set<string> {
  const hooks = new Set<string>();
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < source.length) {
        if (source[i] === "*" && source[i + 1] === "/") {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (source.startsWith("api.on", i) && (i === 0 || !/[a-zA-Z0-9_$\.]/.test(source[i - 1]))) {
      let j = i + "api.on".length;
      while (j < source.length && /\s/.test(source[j])) j += 1;
      if (source[j] !== "(") {
        i += 1;
        continue;
      }

      j += 1;
      while (j < source.length && /\s/.test(source[j])) j += 1;
      const quote = source[j];
      if (quote !== '"' && quote !== "'") {
        i += 1;
        continue;
      }

      j += 1;
      const start = j;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === "\\") {
          j += 2;
        } else {
          j += 1;
        }
      }
      if (j < source.length) {
        const hook = source.slice(start, j);
        if (/^[a-z_]+$/.test(hook)) hooks.add(hook);
        i = j + 1;
        continue;
      }
    }

    i += 1;
  }

  return hooks;
}

function hasServiceStartRegistration(source: string): boolean {
  let i = 0;
  while (i < source.length) {
    const callIndex = source.indexOf("api.registerService", i);
    if (callIndex === -1) return false;
    if (callIndex > 0 && /[a-zA-Z0-9_$\.]/.test(source[callIndex - 1])) {
      i = callIndex + 1;
      continue;
    }

    let cursor = callIndex + "api.registerService".length;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] !== "(") {
      i = callIndex + 1;
      continue;
    }

    cursor += 1;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] !== "{") {
      i = callIndex + 1;
      continue;
    }

    if (objectLiteralHasTopLevelStart(source, cursor)) return true;
    i = cursor + 1;
  }
  return false;
}

function objectLiteralHasTopLevelStart(source: string, objectStart: number): boolean {
  let depth = 0;
  let i = objectStart;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return false;
      i += 1;
      continue;
    }
    if (depth === 1 && source.startsWith("start", i)) {
      const before = source[i - 1];
      const after = source[i + "start".length];
      if (
        (!before || !/[a-zA-Z0-9_$]/.test(before)) &&
        (!after || !/[a-zA-Z0-9_$]/.test(after))
      ) {
        let cursor = i + "start".length;
        while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
        if (source[cursor] === ":" || source[cursor] === "(") return true;
      }
    }
    i += 1;
  }
  return false;
}

function hasCliRegistration(source: string): boolean {
  return /registerCli\s*\([^)]*\borchestrator\b[^)]*\)/m.test(source);
}

function parseCurrentNodeVersion(raw: string): [number, number, number] | null {
  const normalized = raw.startsWith("v") ? raw.slice(1) : raw;
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

type NodeEngineEvaluation =
  | { status: "satisfied" }
  | { status: "unsatisfied" }
  | { status: "unsupported"; reason: string };

type ComparatorOperator = ">" | ">=" | "<" | "<=" | "=";

interface ParsedRangeVersion {
  version: [number, number, number];
  specifiedParts: number;
}

function parseRangeVersion(raw: string): ParsedRangeVersion | null {
  const match = raw.trim().match(/^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i);
  if (!match) return null;

  const minor = match[2];
  const patch = match[3];
  if (minor && /^(x|\*)$/i.test(minor)) {
    return { version: [Number(match[1]), 0, 0], specifiedParts: 1 };
  }
  if (patch && /^(x|\*)$/i.test(patch)) {
    return {
      version: [Number(match[1]), Number(minor ?? 0), 0],
      specifiedParts: 2,
    };
  }

  return {
    version: [Number(match[1]), Number(minor ?? 0), Number(patch ?? 0)],
    specifiedParts: patch ? 3 : minor ? 2 : 1,
  };
}

function upperBoundForPartial(
  parsed: ParsedRangeVersion,
): [number, number, number] | null {
  if (parsed.specifiedParts === 1) {
    return [parsed.version[0] + 1, 0, 0];
  }
  if (parsed.specifiedParts === 2) {
    return [parsed.version[0], parsed.version[1] + 1, 0];
  }
  return null;
}

function upperBoundForCaret(
  parsed: ParsedRangeVersion,
): [number, number, number] {
  const [major, minor, patch] = parsed.version;
  if (parsed.specifiedParts === 1) {
    return [major + 1, 0, 0];
  }
  if (major > 0) return [major + 1, 0, 0];
  if (parsed.specifiedParts === 2) {
    return [0, minor + 1, 0];
  }
  if (minor > 0) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

function upperBoundForTilde(
  parsed: ParsedRangeVersion,
): [number, number, number] {
  const [major, minor] = parsed.version;
  if (parsed.specifiedParts === 1) {
    return [major + 1, 0, 0];
  }
  return [major, minor + 1, 0];
}

function compareWithOperator(
  current: [number, number, number],
  operator: ComparatorOperator,
  target: [number, number, number],
): boolean {
  const comparison = compareVersions(current, target);
  switch (operator) {
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case "=":
      return comparison === 0;
  }
}

function evaluateComparatorToken(
  token: string,
  current: [number, number, number],
): NodeEngineEvaluation {
  const trimmed = token.trim();
  if (!trimmed || trimmed === "*" || /^x$/i.test(trimmed)) {
    return { status: "satisfied" };
  }

  const shorthand = trimmed.match(/^([~^])\s*(.+)$/);
  if (shorthand) {
    const parsed = parseRangeVersion(shorthand[2]);
    if (!parsed) {
      return {
        status: "unsupported",
        reason: `unsupported node engine comparator "${trimmed}"`,
      };
    }
    const upper = shorthand[1] === "^"
      ? upperBoundForCaret(parsed)
      : upperBoundForTilde(parsed);
    return compareWithOperator(current, ">=", parsed.version)
      && compareWithOperator(current, "<", upper)
      ? { status: "satisfied" }
      : { status: "unsatisfied" };
  }

  const comparator = trimmed.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!comparator) {
    return {
      status: "unsupported",
      reason: `unsupported node engine comparator "${trimmed}"`,
    };
  }
  const operator = (comparator[1] ?? "=") as ComparatorOperator;
  const parsed = parseRangeVersion(comparator[2]);
  if (!parsed) {
    return {
      status: "unsupported",
      reason: `unsupported node engine comparator "${trimmed}"`,
    };
  }

  if (!comparator[1]) {
    const upper = upperBoundForPartial(parsed);
    if (upper) {
      return compareWithOperator(current, ">=", parsed.version)
        && compareWithOperator(current, "<", upper)
        ? { status: "satisfied" }
        : { status: "unsatisfied" };
    }
  }

  const partialUpper = upperBoundForPartial(parsed);
  if (partialUpper) {
    switch (operator) {
      case "=":
        return compareWithOperator(current, ">=", parsed.version)
          && compareWithOperator(current, "<", partialUpper)
          ? { status: "satisfied" }
          : { status: "unsatisfied" };
      case ">=":
        return compareWithOperator(current, ">=", parsed.version)
          ? { status: "satisfied" }
          : { status: "unsatisfied" };
      case ">":
        return compareWithOperator(current, ">=", partialUpper)
          ? { status: "satisfied" }
          : { status: "unsatisfied" };
      case "<=":
        return compareWithOperator(current, "<", partialUpper)
          ? { status: "satisfied" }
          : { status: "unsatisfied" };
      case "<":
        return compareWithOperator(current, "<", parsed.version)
          ? { status: "satisfied" }
          : { status: "unsatisfied" };
    }
  }

  return compareWithOperator(current, operator, parsed.version)
    ? { status: "satisfied" }
    : { status: "unsatisfied" };
}

function tokenizeRangeAlternative(alternative: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < alternative.length) {
    while (i < alternative.length && /\s/.test(alternative[i])) i += 1;
    if (i >= alternative.length) break;

    let operator = "";
    const ch = alternative[i];
    if (ch === ">" || ch === "<") {
      operator = ch;
      i += 1;
      if (alternative[i] === "=") {
        operator += "=";
        i += 1;
      }
    } else if (ch === "=" || ch === "^" || ch === "~") {
      operator = ch;
      i += 1;
    }

    while (i < alternative.length && /\s/.test(alternative[i])) i += 1;
    const versionStart = i;
    while (i < alternative.length && !/\s/.test(alternative[i])) i += 1;
    const version = alternative.slice(versionStart, i);
    tokens.push(`${operator}${version}`);
  }

  return tokens;
}

function evaluateHyphenRange(
  alternative: string,
  current: [number, number, number],
): NodeEngineEvaluation | null {
  const match = alternative.match(/^(.+?)\s+-\s+(.+)$/);
  if (!match) return null;

  const lower = parseRangeVersion(match[1]);
  const upper = parseRangeVersion(match[2]);
  if (!lower || !upper) {
    return {
      status: "unsupported",
      reason: `unsupported node engine hyphen range "${alternative}"`,
    };
  }

  const lowerSatisfied = compareWithOperator(current, ">=", lower.version);
  const upperBound = upperBoundForPartial(upper);
  const upperSatisfied = upperBound
    ? compareWithOperator(current, "<", upperBound)
    : compareWithOperator(current, "<=", upper.version);
  return lowerSatisfied && upperSatisfied
    ? { status: "satisfied" }
    : { status: "unsatisfied" };
}

function evaluateNodeEngineRange(
  rawRange: string | undefined,
  currentVersion: [number, number, number],
): NodeEngineEvaluation {
  if (!rawRange || rawRange.trim().length === 0) {
    return { status: "unsupported", reason: "missing node engine range" };
  }

  const alternatives = rawRange.split("||").map((part) => part.trim()).filter(Boolean);
  if (alternatives.length === 0) {
    return { status: "unsupported", reason: "missing node engine range" };
  }

  let firstUnsupported: string | undefined;
  let hasUnsatisfiedAlternative = false;
  for (const alternative of alternatives) {
    const hyphenResult = evaluateHyphenRange(alternative, currentVersion);
    if (hyphenResult) {
      if (hyphenResult.status === "satisfied") {
        return { status: "satisfied" };
      }
      if (hyphenResult.status === "unsupported") {
        firstUnsupported ??= hyphenResult.reason;
      } else {
        hasUnsatisfiedAlternative = true;
      }
      continue;
    }

    const tokens = tokenizeRangeAlternative(alternative).filter(Boolean);
    if (tokens.length === 0) continue;
    let alternativeSatisfied = true;
    for (const token of tokens) {
      const result = evaluateComparatorToken(token, currentVersion);
      if (result.status === "unsupported") {
        firstUnsupported ??= result.reason;
        alternativeSatisfied = false;
        break;
      }
      if (result.status === "unsatisfied") {
        hasUnsatisfiedAlternative = true;
        alternativeSatisfied = false;
        break;
      }
    }
    if (alternativeSatisfied) {
      return { status: "satisfied" };
    }
  }

  if (hasUnsatisfiedAlternative) {
    return { status: "unsatisfied" };
  }
  if (firstUnsupported) {
    return { status: "unsupported", reason: firstUnsupported };
  }
  return { status: "unsatisfied" };
}

function hasMemoryPromptSectionRegistration(source: string): boolean {
  const apiReceiver = String.raw`(?:\bapi|\(\s*api\s*\)|\(\s*api\s+as\s+[^)]+\)|\(\s*<[^>]+>\s*api\s*\))`;
  return new RegExp(
    `${apiReceiver}\\s*\\??\\.\\s*registerMemoryPromptSection\\s*(?:\\?\\.)?\\s*\\(`,
  ).test(source);
}

export async function runCompatChecks(options: CompatCheckOptions): Promise<CompatReport> {
  const checks: CompatCheckResult[] = [];
  const runner = options.runner ?? defaultRunner;
  const pluginJsonPath = path.join(options.repoRoot, "openclaw.plugin.json");
  const packageJsonPath = path.join(options.repoRoot, "package.json");
  const indexPath = path.join(options.repoRoot, "src", "index.ts");

  let pluginRaw = "";
  let pluginManifestPresent = false;
  try {
    pluginRaw = await readFile(pluginJsonPath, "utf-8");
    pluginManifestPresent = true;
    checks.push({
      id: "plugin-manifest-present",
      title: "Plugin manifest present",
      level: "ok",
      message: "Found openclaw.plugin.json",
    });
  } catch {
    checks.push({
      id: "plugin-manifest-present",
      title: "Plugin manifest present",
      level: "error",
      message: "openclaw.plugin.json is missing",
      remediation: "Restore openclaw.plugin.json at repo root with plugin metadata.",
    });
  }

  if (pluginManifestPresent) {
    try {
      const plugin = JSON.parse(pluginRaw) as { id?: string; kind?: string };
      const isValidId = plugin.id === OPENCLAW_REMNIC_PLUGIN_ID || plugin.id === OPENCLAW_REMNIC_LEGACY_PLUGIN_ID;
      if (isValidId && plugin.kind === "memory") {
        checks.push({
          id: "plugin-manifest-shape",
          title: "Plugin manifest ID and kind",
          level: "ok",
          message: "Plugin manifest id/kind match expected values.",
        });
      } else {
        checks.push({
          id: "plugin-manifest-shape",
          title: "Plugin manifest ID and kind",
          level: "error",
          message: `Unexpected manifest values (id=${String(plugin.id)}, kind=${String(plugin.kind)})`,
          remediation: `Set manifest id=${OPENCLAW_REMNIC_PLUGIN_ID} (or ${OPENCLAW_REMNIC_LEGACY_PLUGIN_ID} for the shim) and kind=memory.`,
        });
      }
    } catch {
      checks.push({
        id: "plugin-manifest-shape",
        title: "Plugin manifest ID and kind",
        level: "error",
        message: "openclaw.plugin.json is not valid JSON",
        remediation: "Fix JSON syntax in openclaw.plugin.json.",
      });
    }
  }

  let packageRaw = "";
  let packageJsonPresent = false;
  try {
    packageRaw = await readFile(packageJsonPath, "utf-8");
    packageJsonPresent = true;
  } catch {
    checks.push({
      id: "package-json-present",
      title: "package.json present",
      level: "error",
      message: "package.json is missing",
      remediation: "Restore package.json at repo root.",
    });
  }

  if (packageJsonPresent) {
    try {
      const pkg = JSON.parse(packageRaw) as {
        openclaw?: { plugin?: string; extensions?: string[] };
        engines?: { node?: string };
      };
      const pluginPathOk = pkg.openclaw?.plugin === "./openclaw.plugin.json";
      const extOk = Array.isArray(pkg.openclaw?.extensions)
        && pkg.openclaw?.extensions.includes("./dist/index.js");
      if (pluginPathOk && extOk) {
        checks.push({
          id: "package-openclaw-exports",
          title: "package.json OpenClaw export wiring",
          level: "ok",
          message: "package.json openclaw.plugin/extensions wiring looks valid.",
        });
      } else {
        checks.push({
          id: "package-openclaw-exports",
          title: "package.json OpenClaw export wiring",
          level: "error",
          message: "package.json openclaw plugin/extension wiring is missing or invalid.",
          remediation: "Set openclaw.plugin to ./openclaw.plugin.json and include ./dist/index.js in openclaw.extensions.",
        });
      }

      const currentNode = options.currentNodeVersion ?? process.version;
      const currentVersion = parseCurrentNodeVersion(currentNode);
      const engineEvaluation: NodeEngineEvaluation = currentVersion
        ? evaluateNodeEngineRange(pkg.engines?.node, currentVersion)
        : { status: "unsupported", reason: "unable to parse current Node version" };
      if (engineEvaluation.status === "unsupported") {
        checks.push({
          id: "node-version-compat",
          title: "Node runtime compatibility",
          level: "warn",
          message: `Unable to evaluate node engine/current version: ${engineEvaluation.reason}.`,
          remediation: "Confirm Node version meets package.json engines.node requirement.",
          metadata: { enginesNode: pkg.engines?.node, currentNode },
        });
      } else if (engineEvaluation.status === "satisfied") {
        checks.push({
          id: "node-version-compat",
          title: "Node runtime compatibility",
          level: "ok",
          message: `Current Node ${currentNode} satisfies engines requirement ${pkg.engines?.node}.`,
        });
      } else {
        checks.push({
          id: "node-version-compat",
          title: "Node runtime compatibility",
          level: "error",
          message: `Current Node ${currentNode} does not satisfy engines requirement ${pkg.engines?.node}.`,
          remediation: "Upgrade Node runtime to meet package.json engines.node minimum.",
        });
      }
    } catch {
      checks.push({
        id: "package-json-parse",
        title: "package.json parse",
        level: "error",
        message: "package.json is not valid JSON",
        remediation: "Fix JSON syntax in package.json.",
      });
    }
  }

  try {
    await access(indexPath);
    const indexRaw = await readFile(indexPath, "utf-8");
    const structuralSource = stripCommentsAndStrings(indexRaw);
    const hooks = parseHookRegistrations(indexRaw);
    const missingLegacy = REQUIRED_HOOKS_LEGACY.filter((hook) => !hooks.has(hook));
    const missingNew = REQUIRED_HOOKS_NEW.filter((hook) => !hooks.has(hook));
    // registerMemoryPromptSection is a valid alternative to the recall hook only
    // when it is registered on the OpenClaw plugin API object.
    const hasMemoryPromptSection = hasMemoryPromptSectionRegistration(structuralSource);
    const missingLegacyAdj = hasMemoryPromptSection
      ? missingLegacy.filter((h) => h !== "before_agent_start")
      : missingLegacy;
    const missingNewAdj = hasMemoryPromptSection
      ? missingNew.filter((h) => h !== "before_prompt_build")
      : missingNew;
    // Accept whichever hook set has fewer missing entries
    const missingHooks = missingNewAdj.length <= missingLegacyAdj.length ? missingNewAdj : missingLegacyAdj;
    const hasGatewayStartHook = hooks.has("gateway_start");
    const hasServiceStart = hasServiceStartRegistration(structuralSource);
    if (missingHooks.length === 0 && (hasGatewayStartHook || hasServiceStart)) {
      checks.push({
        id: "hook-registration-core",
        title: "Core hook registration",
        level: "ok",
        message: "Core recall/extraction hooks and startup wiring are registered in src/index.ts.",
      });
    } else {
      const missingParts: string[] = [];
      if (missingHooks.length > 0) {
        missingParts.push(`hooks: ${missingHooks.join(", ")}`);
      }
      if (!hasGatewayStartHook && !hasServiceStart) {
        missingParts.push("startup wiring: gateway_start hook or api.registerService({ start })");
      }
      checks.push({
        id: "hook-registration-core",
        title: "Core hook registration",
        level: "error",
        message: `Missing expected registration(s): ${missingParts.join("; ")}`,
        remediation: "Ensure src/index.ts registers before_prompt_build (or before_agent_start) and agent_end, plus either gateway_start or api.registerService({ start }).",
      });
    }

    const cliWired = hasCliRegistration(structuralSource);
    checks.push({
      id: "cli-registration",
      title: "CLI registration wiring",
      level: cliWired ? "ok" : "warn",
      message: cliWired
        ? "CLI registration is wired in plugin bootstrap."
        : "CLI registration call not found in src/index.ts.",
      remediation: cliWired ? undefined : "Call registerCli(api, orchestrator) during plugin registration.",
    });
  } catch {
    checks.push({
      id: "hook-registration-core",
      title: "Core hook registration",
      level: "error",
      message: "src/index.ts is missing; cannot validate hook wiring.",
      remediation: "Restore src/index.ts and register required hooks.",
    });
  }

  const qmdAvailable = await runner.commandExists("qmd");
  checks.push({
    id: "qmd-binary-availability",
    title: "QMD binary availability",
    level: qmdAvailable ? "ok" : "warn",
    message: qmdAvailable
      ? "qmd binary is available in PATH."
      : "qmd binary is not available in PATH.",
    remediation: qmdAvailable ? undefined : "Install qmd or configure qmdPath in plugin config.",
  });

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    checks,
    summary: summarize(checks),
  };
}
