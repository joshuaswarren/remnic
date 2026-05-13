import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";
import type { MemoryFile, PluginConfig } from "./types.js";
import { discoverMemoryExtensions, renderExtensionsFooter, resolveExtensionsRoot } from "./memory-extension-host/index.js";

const PROMPT_RELATIVE_PATH = path.join("prompts", "day_summary.prompt.md");

// Embedded fallback prompt for packaged/plugin-install builds where
// prompts/day_summary.prompt.md may not be present in the runtime bundle.
const EMBEDDED_DAY_SUMMARY_PROMPT = `# Baseline day-summary prompt

You are writing an Engram end-of-day summary.

Your job:
- compress the day into a short, useful recap
- prioritize concrete events, decisions, mood/energy signals, and open loops
- include a few practical next actions for tomorrow
- avoid hype, fluff, therapy-speak, and invented facts

Output JSON with these keys:
- \`summary\` — one short paragraph
- \`bullets\` — 2 to 5 bullets with the most important moments
- \`next_actions\` — 1 to 3 concrete actions
- \`risks_or_open_loops\` — 0 to 3 things that still need attention

Rules:
- stay grounded in the input only
- if the day was mixed, say so plainly
- do not overstate confidence or importance
- prefer specific verbs over vague abstractions

Brevity:
- keep the summary under 90 words
- keep bullets short and information-dense
- omit anything that does not change what tomorrow should care about

Structure:
- \`summary\` should be one paragraph only
- \`bullets\` should contain the most important moments, not generic restatements
- \`next_actions\` and \`risks_or_open_loops\` should be distinct and non-overlapping

Risk:
- explicitly surface unresolved blockers, dependencies, or fragile assumptions
- do not bury open loops inside the summary if they deserve separate attention

Tone:
- sound like a clear internal daily note, not a report template
- stay natural and direct while remaining compact`;

function candidateRoots(): string[] {
  const currentFile = fileURLToPath(import.meta.url);
  const here = path.dirname(currentFile);
  const candidates = [path.resolve(here, ".."), path.resolve(here, "..", "..")];

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

async function resolvePromptPath(): Promise<string | null> {
  const { existsSync } = await import("node:fs");
  for (const root of candidateRoots()) {
    const candidate = path.join(root, PROMPT_RELATIVE_PATH);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function loadDaySummaryPrompt(): Promise<string> {
  const promptPath = await resolvePromptPath();
  if (promptPath) {
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(promptPath, "utf-8");
      // CRLF-compatible regex: allow \r\n or \n line endings
      const match = raw.match(/```(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)\r?\n```/);
      if (match?.[1]) {
        return match[1].trim();
      }
      log.warn("day summary prompt file does not contain a fenced prompt block; using embedded fallback");
    } catch (err) {
      log.warn(`day summary prompt file read failed; using embedded fallback: ${err}`);
    }
  }
  return EMBEDDED_DAY_SUMMARY_PROMPT;
}

export function formatDaySummaryMemories(memories: string | MemoryFile[]): string {
  if (typeof memories === "string") {
    return memories.trim();
  }

  return memories
    .map((memory) => {
      const category = memory.frontmatter.category || "fact";
      const created = memory.frontmatter.created || "unknown";
      return `[${memory.frontmatter.id}] (${category}, ${created})\n${memory.content}`;
    })
    .join("\n\n")
    .trim();
}

/**
 * Build a one-line extension footer for day-summary and summary-snapshot contexts.
 * Returns "" when extensions are disabled or none are found.
 */
export async function buildExtensionsFooterForSummary(
  config: PluginConfig,
): Promise<string> {
  if (!config.memoryExtensionsEnabled) return "";
  const root = resolveExtensionsRoot(config);
  const extensions = await discoverMemoryExtensions(root, log);
  if (extensions.length === 0) return "";
  return renderExtensionsFooter(extensions);
}
