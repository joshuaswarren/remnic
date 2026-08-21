/**
 * Procedural memory types (issue #519).
 * Bodies use ordered "## Step N" sections; machine fields live in frontmatter / structuredAttributes.
 */

export interface ProcedureStep {
  order: number;
  intent: string;
  toolCall?: {
    kind: string;
    signature: string;
  };
  expectedOutcome?: string;
  optional?: boolean;
}

/** Normalize loose extraction JSON into ProcedureStep records. */
export function normalizeProcedureSteps(raw: unknown): ProcedureStep[] {
  if (!Array.isArray(raw)) return [];
  const out: ProcedureStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const intent = typeof o.intent === "string" ? o.intent.trim() : "";
    if (!intent) continue;
    const orderRaw = o.order;
    const order =
      typeof orderRaw === "number" && Number.isFinite(orderRaw)
        ? Math.max(1, Math.floor(orderRaw))
        : i + 1;
    let toolCall: ProcedureStep["toolCall"];
    const tc = o.toolCall;
    if (tc && typeof tc === "object" && !Array.isArray(tc)) {
      const t = tc as Record<string, unknown>;
      const kind = typeof t.kind === "string" ? t.kind.trim() : "";
      const signature = typeof t.signature === "string" ? t.signature.trim() : "";
      if (kind && signature) {
        toolCall = { kind, signature };
      }
    }
    const expectedOutcome =
      typeof o.expectedOutcome === "string" && o.expectedOutcome.trim()
        ? o.expectedOutcome.trim()
        : undefined;
    const optional = o.optional === true ? true : undefined;
    out.push({ order, intent, toolCall, expectedOutcome, optional });
  }
  return out;
}

/** Title line plus serialized steps for storage.writeMemory body. */
export function buildProcedurePersistBody(title: string, procedureSteps: unknown): string {
  const head = typeof title === "string" ? title.trim() : "";
  const steps = normalizeProcedureSteps(procedureSteps);
  if (steps.length === 0) return head;
  return `${head}\n\n${buildProcedureMarkdownBody(steps)}`.trimEnd() + "\n";
}

/** Serialize steps into markdown body (human-editable). */
export function buildProcedureMarkdownBody(steps: ProcedureStep[]): string {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  const lines: string[] = [];
  for (const step of sorted) {
    const n = Number.isFinite(step.order) ? Math.max(1, Math.floor(step.order)) : 1;
    lines.push(`## Step ${n}`);
    lines.push("");
    lines.push(step.intent.trim());
    if (step.toolCall?.kind && step.toolCall.signature) {
      lines.push("");
      lines.push(`- Tool: \`${step.toolCall.kind}\` — ${step.toolCall.signature}`);
    }
    if (step.expectedOutcome?.trim()) {
      lines.push("");
      lines.push(`- Expected: ${step.expectedOutcome.trim()}`);
    }
    if (step.optional === true) {
      lines.push("");
      lines.push("- Optional: true");
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

const STEP_HEADER_RE = /^##\s+Step\s+(\d+)\s*$/im;

/**
 * Best-effort parse of "## Step N" blocks into ProcedureStep records.
 * Returns null when no step headers are found.
 */
export function parseProcedureStepsFromBody(content: string): ProcedureStep[] | null {
  const text = content.replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  const matches = [...text.matchAll(new RegExp(STEP_HEADER_RE.source, "gim"))];
  if (matches.length === 0) return null;

  const steps: ProcedureStep[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const order = Number.parseInt(m[1] ?? "1", 10);
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const block = text.slice(start, end).trim();
    const lines = block.split("\n").map((l) => l.trim());
    const intentLines = lines.filter(
      (l) => l.length > 0 && !l.startsWith("- Tool:") && !l.startsWith("- Expected:") && !l.startsWith("- Optional:"),
    );
    const intent = intentLines.join(" ").trim() || "(unspecified)";
    let toolCall: ProcedureStep["toolCall"];
    const toolLine = lines.find((l) => l.startsWith("- Tool:"));
    if (toolLine) {
      const inner = toolLine.replace(/^- Tool:\s*/i, "").trim();
      const tick = inner.match(/^`([^`]+)`\s*[—-]\s*(.+)$/);
      if (tick) {
        toolCall = { kind: tick[1].trim(), signature: tick[2].trim() };
      }
    }
    const expectedLine = lines.find((l) => l.startsWith("- Expected:"));
    const expectedOutcome = expectedLine?.replace(/^- Expected:\s*/i, "").trim();
    const optional = /^- Optional:\s*true$/i.test(lines.find((l) => l.startsWith("- Optional:")) ?? "");

    steps.push({
      order: Number.isFinite(order) ? order : i + 1,
      intent,
      toolCall,
      expectedOutcome: expectedOutcome?.length ? expectedOutcome : undefined,
      optional: optional || undefined,
    });
  }
  return steps.length > 0 ? steps : null;
}
