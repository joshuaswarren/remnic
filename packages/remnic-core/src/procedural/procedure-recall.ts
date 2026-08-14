/**
 * Intent-gated recall for active procedure memories (issue #519).
 */

import type { MemoryFile, PluginConfig } from "../types.js";
import type { StorageManager } from "../storage.js";
import { inferIntentFromText, intentCompatibilityScore, isTaskInitiationIntent } from "../intent.js";
import { isActiveMemoryStatus } from "../memory-lifecycle-ledger-utils.js";
import { canRecallToolScopedMemory } from "../tool-scoped-memory.js";
import { resolveSecurityCapabilities } from "../capabilities.js";
import { renderAuthorityBoundContent } from "../recall-context-composition.js";

function tokenOverlapScore(prompt: string, memoryText: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);
  const promptTokens = new Set(norm(prompt));
  const memTokens = new Set(norm(memoryText));
  if (promptTokens.size === 0 || memTokens.size === 0) return 0;
  let inter = 0;
  for (const t of promptTokens) {
    if (memTokens.has(t)) inter++;
  }
  const union = new Set([...promptTokens, ...memTokens]);
  return inter / Math.max(1, union.size);
}

function scoreProcedureForPrompt(
  m: MemoryFile,
  prompt: string,
  queryIntent: ReturnType<typeof inferIntentFromText>,
): number {
  const memText = `${m.content}\n${(m.frontmatter.tags ?? []).join(" ")}`;
  const jaccard = tokenOverlapScore(prompt, memText);
  const memIntent = inferIntentFromText(m.content.slice(0, 2000));
  const intentScore = intentCompatibilityScore(queryIntent, memIntent);
  return jaccard * 0.55 + intentScore * 0.45;
}

/**
 * Build markdown for the recall pipeline when procedural memory is enabled and
 * the prompt looks like task initiation.
 */
export async function buildProcedureRecallSection(
  storage: StorageManager,
  prompt: string,
  config: PluginConfig,
  options?: { partitionToolScoped?: boolean; requestingConnector?: string },
): Promise<string | null> {
  if (config.procedural?.enabled !== true) return null;
  const trimmed = typeof prompt === "string" ? prompt.trim() : "";
  if (!trimmed) return null;

  const queryIntent = inferIntentFromText(trimmed);
  if (!isTaskInitiationIntent(queryIntent)) return null;

  const maxN = Math.min(
    10,
    Math.max(
      1,
      typeof config.procedural.recallMaxProcedures === "number" &&
        Number.isFinite(config.procedural.recallMaxProcedures)
        ? Math.floor(config.procedural.recallMaxProcedures)
        // Safer-by-default fallback (issue #567 PR 3/5): must match
        // config.ts's canonical default (2). Cursor review on PR #607:
        // divergent fallbacks silently regressed the safer cap whenever
        // the config value was missing or non-finite at this call site.
        : 2,
    ),
  );

  const all = await storage.readAllMemories();
  const scored = all
    .filter(
      (m) =>
        m.frontmatter.category === "procedure" &&
        isActiveMemoryStatus(m.frontmatter.status) &&
        (options?.partitionToolScoped !== true ||
          canRecallToolScopedMemory(m.frontmatter, options.requestingConnector)),
    )
    .map((m) => ({ m, score: scoreProcedureForPrompt(m, trimmed, queryIntent) }))
    .filter((x) => x.score > 0.04)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxN);

  if (scored.length === 0) return null;

  // #1955: procedure bodies are model-visible instructions by nature — an
  // untrusted-origin procedure must render inside the data-only authority
  // fence like every other recall surface.
  const security = resolveSecurityCapabilities(config);
  const blocks = scored.map(({ m, score }) => {
    const id = m.frontmatter.id;
    const flat = m.content.replace(/\s+/g, " ").trim();
    const preview = flat.slice(0, 320);
    const suffix = flat.length > 320 ? "…" : "";
    const body = renderAuthorityBoundContent(`${preview}${suffix}`, m.frontmatter.origin, {
      enabled: security.originAuthority,
      untrustedOrigins: config.untrustedOrigins,
    });
    return `### ${id} (match ${score.toFixed(2)})\n\n${body}`;
  });

  return `## Relevant procedures\n\n${blocks.join("\n\n")}`;
}
