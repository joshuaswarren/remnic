import type { EngramAccessRecallResponse } from "./access-service.js";
import type { ActionConfidenceRequest } from "./access-schema.js";
import type { RecallXrayResult, RecallXraySnapshot } from "./recall-xray.js";
import type { ActionConfidenceResult } from "./action-confidence.js";
import type { RetrievedMemoryProvenance } from "./memory-provenance.js";

export const REMNIC_CHATGPT_MEMORY_INSPECTOR_TOOL =
  "engram.chatgpt_memory_inspector" as const;
export const REMNIC_CHATGPT_MEMORY_INSPECTOR_CANONICAL_TOOL =
  "remnic.chatgpt_memory_inspector" as const;
export const REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI =
  "ui://remnic/memory-inspector.v1.html" as const;
export const REMNIC_CHATGPT_MEMORY_INSPECTOR_MIME_TYPE =
  "text/html;profile=mcp-app" as const;

export interface RemnicChatGptMemoryInspectorInput {
  query: string;
  sessionKey?: string;
  namespace?: string;
  currentContextScopes?: string[];
}

export interface RemnicChatGptMemoryCard {
  id: string;
  path?: string;
  category?: string;
  status?: string;
  preview?: string;
  servedBy?: string;
  score?: number;
  source?: string;
  scope?: string;
  retrievalReason?: string;
  confidence?: number;
  stale?: boolean;
  corrected?: boolean;
  safeToUse?: boolean;
  safety?: string;
  safetyReasons: string[];
  userContextScopes: string[];
}

export interface RemnicChatGptMemoryInspectorResult {
  app: {
    name: "Remnic Memory Inspector";
    resourceUri: typeof REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI;
    archetype: "vanilla-widget";
  };
  query: string;
  sessionKey?: string;
  namespace: string;
  safeRecallPreview: string;
  memoryCount: number;
  memoryIds: string[];
  memories: RemnicChatGptMemoryCard[];
  actionConfidence: ActionConfidenceResult;
  affordances: Array<{
    id: "why" | "correct" | "forget" | "scope";
    label: string;
    followUpPrompt: string;
  }>;
  guidance: {
    correctionTool: "remnic.suggestion_submit";
    forgetTool: "remnic.memory_action_apply";
    scopeTool: "remnic.memory_action_apply";
    note: string;
  };
}

export function buildChatGptMemoryInspectorActionRequest(
  input: RemnicChatGptMemoryInspectorInput,
  recall: EngramAccessRecallResponse,
  xray: RecallXraySnapshot | null,
): ActionConfidenceRequest {
  const provenances = xray === null
    ? recall.results.map(missingRecallProvenance)
    : xray.results.map((result) => result.provenance ?? missingProvenance(result));
  const hasUnsafeOrMissingProvenance = provenances.some(
    (provenance) => provenance.safeToUse === false || provenance.safety === "blocked",
  ) || provenances.length < recall.count;

  const request: ActionConfidenceRequest = {
    intendedAction: `Use Remnic memory to answer: ${input.query}`,
    risk: "medium",
    contextReadiness:
      recall.count > 0 && !hasUnsafeOrMissingProvenance ? "sufficient" : "partial",
    retrievedMemories: provenances.map((provenance) => ({
      source: provenance.source,
      created: provenance.created,
      updated: provenance.updated,
      scope: provenance.scope,
      userContextScopes: provenance.userContextScopes,
      retrievalReason: provenance.retrievalReason,
      confidence: provenance.confidence,
      stale: provenance.stale,
      corrected: provenance.corrected,
      correctionState: provenance.correctionState,
      safeToUse: provenance.safeToUse,
      safety: provenance.safety,
      safetyReasons: provenance.safetyReasons,
    })),
  };
  const confidence = provenances.length > 0
    ? average(provenances.map((provenance) => provenance.confidence ?? 0.5))
    : undefined;
  if (confidence !== undefined) request.confidence = confidence;
  if (input.currentContextScopes !== undefined) {
    request.currentContextScopes = input.currentContextScopes;
  }
  return request;
}

export function buildChatGptMemoryInspectorResult(
  input: RemnicChatGptMemoryInspectorInput,
  recall: EngramAccessRecallResponse,
  xray: RecallXraySnapshot | null,
  actionConfidence: ActionConfidenceResult,
): RemnicChatGptMemoryInspectorResult {
  const xrayUnavailable = xray === null;
  const xrayById = new Map<string, RecallXrayResult>();
  const xrayByPath = new Map<string, RecallXrayResult>();
  for (const result of xray?.results ?? []) {
    xrayById.set(result.memoryId, result);
    xrayByPath.set(result.path, result);
  }
  const matchXrayResult = (summary: EngramAccessRecallResponse["results"][number]) =>
    (summary.path ? xrayByPath.get(summary.path) : undefined)
    ?? xrayById.get(summary.id);
  const matchedXrayResults = recall.results.map(matchXrayResult);

  const memories = recall.results.slice(0, 8).map((summary) => {
    const xrayResult = matchXrayResult(summary);
    const provenance = xrayResult?.provenance;
    const unverified = !xrayUnavailable && provenance === undefined;
    const blocked = provenance?.safety === "blocked";
    const preview = xrayUnavailable
      ? "Preview withheld: X-ray provenance was unavailable for this recall."
      : unverified
        ? "Preview withheld: X-ray provenance was missing for this memory."
      : blocked
        ? "Preview withheld: this memory is blocked in the current context."
        : summary.preview;
    return {
      id: summary.id,
      path: summary.path,
      category: summary.category,
      status: summary.status,
      preview,
      servedBy: xrayResult?.servedBy,
      score: xrayResult?.scoreDecomposition.final,
      source: provenance?.source,
      scope: provenance?.scope,
      retrievalReason: provenance?.retrievalReason,
      confidence: provenance?.confidence,
      stale: provenance?.stale,
      corrected: provenance?.corrected,
      safeToUse: provenance?.safeToUse ?? (unverified ? false : undefined),
      safety: provenance?.safety ?? (unverified ? "blocked" : undefined),
      safetyReasons: provenance?.safetyReasons
        ?? (unverified ? ["X-ray provenance was missing for this memory."] : []),
      userContextScopes: provenance?.userContextScopes ?? [],
    };
  });
  const blockedCount = matchedXrayResults
    .filter((result) => result?.provenance?.safety === "blocked")
    .length;
  const missingProvenanceCount = xrayUnavailable
    ? 0
    : matchedXrayResults
      .filter((result) => result?.provenance === undefined)
    .length;
  const safeRecallPreview = xrayUnavailable
    ? "Recall preview withheld: X-ray provenance was unavailable, so memory safety could not be verified."
    : blockedCount > 0 || missingProvenanceCount > 0
      ? formatUnsafeRecallPreview(blockedCount, missingProvenanceCount)
      : truncate(recall.context, 1_500);

  const primaryMemoryId = memories[0]?.id ?? "<memory-id>";
  return {
    app: {
      name: "Remnic Memory Inspector",
      resourceUri: REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_URI,
      archetype: "vanilla-widget",
    },
    query: recall.query || input.query,
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    namespace: recall.namespace,
    safeRecallPreview,
    memoryCount: recall.count,
    memoryIds: recall.memoryIds,
    memories,
    actionConfidence,
    affordances: [
      {
        id: "why",
        label: "Why retrieved",
        followUpPrompt:
          `Explain why Remnic retrieved memory ${primaryMemoryId} for "${input.query}" using its provenance, score, safety, and retrieval reason.`,
      },
      {
        id: "correct",
        label: "Correct",
        followUpPrompt:
          `Help me correct memory ${primaryMemoryId}. Draft a replacement or correction and use remnic.suggestion_submit with dryRun first.`,
      },
      {
        id: "forget",
        label: "Forget",
        followUpPrompt:
          `Help me forget or quarantine memory ${primaryMemoryId}. Ask me to confirm before using any destructive or persistent Remnic action.`,
      },
      {
        id: "scope",
        label: "Scope",
        followUpPrompt:
          `Help me scope memory ${primaryMemoryId} so it is only used in the right context. Prefer a dry-run Remnic action before any persistent change.`,
      },
    ],
    guidance: {
      correctionTool: "remnic.suggestion_submit",
      forgetTool: "remnic.memory_action_apply",
      scopeTool: "remnic.memory_action_apply",
      note:
        "The demo only proposes correction, forget, and scoping flows. The widget sends follow-up prompts; persistent changes still require an explicit tool call and user confirmation.",
    },
  };
}

export const REMNIC_CHATGPT_MEMORY_INSPECTOR_WIDGET_HTML = `
<div id="root" class="remnic-app">Loading Remnic memory inspector...</div>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f8faf8;
    --panel: #ffffff;
    --text: #17201b;
    --muted: #56635b;
    --line: #d8e0da;
    --accent: #2f7d57;
    --warn: #9a5b14;
    --bad: #9c2b2b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101512;
      --panel: #18201b;
      --text: #edf4ef;
      --muted: #a8b6ad;
      --line: #304036;
      --accent: #75c79a;
      --warn: #e0ad63;
      --bad: #f08a8a;
    }
  }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .remnic-app { padding: 14px; display: grid; gap: 12px; }
  .header, .section, .memory { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
  .title { font-size: 16px; font-weight: 650; margin: 0; }
  .muted { color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
  .pill { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; margin: 2px 4px 2px 0; color: var(--muted); }
  .safe { color: var(--accent); }
  .review { color: var(--warn); }
  .blocked { color: var(--bad); }
  .memory { display: grid; gap: 8px; }
  .memory-title { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; font-weight: 650; }
  .preview { white-space: pre-wrap; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  button { border: 1px solid var(--line); background: transparent; color: var(--text); border-radius: 6px; padding: 6px 9px; font: inherit; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; color: var(--muted); }
</style>
<script>
  const root = document.getElementById("root");

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }

  function statusClass(value) {
    if (value === "blocked" || value === false) return "blocked";
    if (value === "requires-review") return "review";
    return "safe";
  }

  function followUp(prompt) {
    if (window.openai?.sendFollowUpMessage) {
      window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true });
      return;
    }
    window.parent.postMessage({
      jsonrpc: "2.0",
      method: "ui/message",
      params: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    }, "*");
  }

  function actionButtons(actions) {
    return (actions ?? []).map((action) =>
      '<button type="button" data-prompt="' + escapeHtml(action.followUpPrompt) + '">' +
      escapeHtml(action.label) +
      '</button>'
    ).join("");
  }

  function render(payload) {
    const data = payload?.structuredContent ?? payload ?? window.openai?.toolOutput ?? {};
    const confidence = data.actionConfidence ?? {};
    const memories = Array.isArray(data.memories) ? data.memories : [];
    root.innerHTML = [
      '<section class="header">',
        '<p class="title">Remnic Memory Inspector</p>',
        '<div class="muted">' + escapeHtml(data.query ?? "No query") + '</div>',
        '<div class="grid">',
          '<div><strong>Namespace</strong><br><span class="muted">' + escapeHtml(data.namespace ?? "default") + '</span></div>',
          '<div><strong>Decision</strong><br><span class="' + statusClass(confidence.decision) + '">' + escapeHtml(confidence.decision ?? "unknown") + '</span></div>',
          '<div><strong>Memories</strong><br><span class="muted">' + escapeHtml(data.memoryCount ?? memories.length) + '</span></div>',
        '</div>',
      '</section>',
      '<section class="section">',
        '<strong>Safe recall preview</strong>',
        '<pre>' + escapeHtml(data.safeRecallPreview ?? "") + '</pre>',
      '</section>',
      '<section class="section actions">',
        actionButtons(data.affordances),
      '</section>',
      memories.map((memory) => [
        '<article class="memory">',
          '<div class="memory-title"><span>' + escapeHtml(memory.id) + '</span><span class="' + statusClass(memory.safety) + '">' + escapeHtml(memory.safety ?? "safe") + '</span></div>',
          '<div class="preview">' + escapeHtml(memory.preview ?? "") + '</div>',
          '<div>',
            '<span class="pill">source ' + escapeHtml(memory.source ?? "unknown") + '</span>',
            '<span class="pill">scope ' + escapeHtml(memory.scope ?? "unknown") + '</span>',
            '<span class="pill">reason ' + escapeHtml(memory.retrievalReason ?? memory.servedBy ?? "unknown") + '</span>',
            '<span class="pill">confidence ' + escapeHtml(memory.confidence ?? "n/a") + '</span>',
          '</div>',
          '<div class="muted">' + escapeHtml((memory.safetyReasons ?? []).join("; ")) + '</div>',
        '</article>',
      ].join("")).join(""),
    ].join("");

    root.querySelectorAll("button[data-prompt]").forEach((button) => {
      button.addEventListener("click", () => followUp(button.getAttribute("data-prompt") ?? ""));
    });
  }

  render(window.openai?.toolOutput);

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "ui/notifications/tool-result") {
      render(message.params);
    }
  }, { passive: true });

  window.addEventListener("openai:set_globals", (event) => {
    render(event.detail?.globals?.toolOutput ?? window.openai?.toolOutput);
  }, { passive: true });
</script>
`.trim();

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function missingProvenance(result: RecallXrayResult): RetrievedMemoryProvenance {
  return {
    source: "unknown",
    scope: "unknown",
    userContextScopes: [],
    retrievalReason: `X-ray provenance missing for ${result.memoryId || result.path}`,
    confidence: 0,
    stale: false,
    corrected: false,
    correctionState: "none",
    safeToUse: false,
    safety: "blocked",
    safetyReasons: ["X-ray provenance was missing for this memory."],
  };
}

function missingRecallProvenance(
  summary: EngramAccessRecallResponse["results"][number],
): RetrievedMemoryProvenance {
  return {
    source: "unknown",
    scope: "unknown",
    userContextScopes: [],
    retrievalReason: `X-ray provenance unavailable for ${summary.id || summary.path}`,
    confidence: 0,
    stale: false,
    corrected: false,
    correctionState: "none",
    safeToUse: false,
    safety: "blocked",
    safetyReasons: ["X-ray provenance was unavailable for this recall."],
  };
}

function formatUnsafeRecallPreview(
  blockedCount: number,
  missingProvenanceCount: number,
): string {
  const reasons: string[] = [];
  if (blockedCount > 0) {
    reasons.push(`${blockedCount} retrieved ${memoryNoun(blockedCount)} ${isAre(blockedCount)} blocked`);
  }
  if (missingProvenanceCount > 0) {
    reasons.push(
      `${missingProvenanceCount} retrieved ${memoryNoun(missingProvenanceCount)} ${isAre(missingProvenanceCount)} missing X-ray provenance`,
    );
  }
  return `Recall preview withheld: ${joinReasons(reasons)} in the current context.`;
}

function memoryNoun(count: number): string {
  return count === 1 ? "memory" : "memories";
}

function isAre(count: number): string {
  return count === 1 ? "is" : "are";
}

function joinReasons(reasons: string[]): string {
  if (reasons.length <= 1) return reasons[0] ?? "memory safety could not be verified";
  return `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
