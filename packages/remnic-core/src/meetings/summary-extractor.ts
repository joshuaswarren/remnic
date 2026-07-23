/**
 * Production meeting summary extractor + durability-judge adapter (issue #1900).
 *
 * The engine's `MeetingsBuilder` accepts an optional `summary` dep pair
 * ({ extractor, judge }); when present alongside `memoryWriter` and
 * `summaryMode !== "off"` it runs `generateMeetingSummaryFacts` per record. This
 * module supplies the PRODUCTION implementations of those interfaces so the
 * default `summaryMode: "smart"` actually generates trust-gated meeting facts in
 * production. It lives beside `memory-gen` (whose interfaces it implements) so
 * `workspace-ops` stays thin — that file only constructs + injects.
 *
 * Reuse, not fork: the judge adapter wraps the SAME `judgeFactDurability` the
 * live extraction + wearables pipelines use (verdict cache + defer counters
 * included), and the extractor calls the shared local -> gateway LLM clients. No
 * parallel trust/judge/LLM machinery lives here.
 */

import { getVerdictKind, type JudgeBatchResult, type JudgeCandidate } from "../extraction-judge.js";
import { log } from "../logger.js";
import type {
  MeetingFactCandidate,
  MeetingSummaryExtractor,
  MeetingSummaryJudge,
} from "./memory-gen.js";
import type { MeetingRecord } from "./types.js";

/**
 * Narrow chat client the extractor needs. Structurally satisfied by BOTH
 * `LocalLlmClient` and `FallbackLlmClient`, so production injects the real
 * local -> gateway chain and unit tests inject a fake. Kept minimal (never fork
 * the clients) so a client outage or a null return degrades to "no candidates"
 * rather than throwing through the build.
 */
export interface MeetingSummaryChatClient {
  chatCompletion(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options?: { temperature?: number; maxTokens?: number; operation?: string },
  ): Promise<{ content: string } | null>;
}

const SUMMARY_SYSTEM_PROMPT = `You are a meeting scribe extracting DURABLE memory from a meeting transcript and its on-screen context.

Return ONLY a single JSON object, no prose, no code fences, in exactly this shape:
{
  "summary": "one concise paragraph (2-4 sentences) describing what the meeting was about and its outcome",
  "decisions": ["a concrete decision the group reached", ...],
  "commitments": [{"owner": "who owns it", "action": "what they committed to do, including any due date"}, ...],
  "openQuestions": ["an unresolved question that was raised", ...]
}

Rules:
- decisions: concrete choices the group made. Omit hypotheticals and discussion that led nowhere.
- commitments: owner-bearing action items only. If there is no clear owner, omit it.
- openQuestions: genuinely unresolved questions, not rhetorical asides.
- Prefer fewer, higher-quality items. Use [] for any empty list. Never invent content the transcript does not support.`;

const DECISION_CONFIDENCE = 0.8;
const COMMITMENT_CONFIDENCE = 0.8;
const QUESTION_CONFIDENCE = 0.6;
const DEFAULT_MAX_TOKENS = 1024;
/** Cap a salvaged (non-JSON) best-effort summary so a runaway response cannot
 *  push a huge blob into the trust-gated summary fact. */
const MAX_BEST_EFFORT_SUMMARY = 2000;

function meetingPromptHeader(record: MeetingRecord): string {
  const parts = [`Meeting on ${record.date}`];
  if (record.app !== undefined) parts.push(`app: ${record.app}`);
  if (record.attendees.length > 0) parts.push(`attendees: ${record.attendees.join(", ")}`);
  return parts.join(" | ");
}

function buildUserPrompt(
  record: MeetingRecord,
  transcriptText: string,
  screenContextText: string,
): string {
  const sections = [meetingPromptHeader(record), "", "## Transcript", transcriptText || "(none)"];
  if (screenContextText.trim().length > 0) {
    sections.push("", "## Screen context", screenContextText);
  }
  return sections.join("\n");
}

/** Strip a wrapping markdown code fence, if present. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```[a-zA-Z0-9]*\n?/, "");
  const closeIdx = withoutOpen.lastIndexOf("```");
  return (closeIdx === -1 ? withoutOpen : withoutOpen.slice(0, closeIdx)).trim();
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pushIfContent(
  out: MeetingFactCandidate[],
  content: string,
  category: MeetingFactCandidate["category"],
  confidence: number,
): void {
  const trimmed = content.trim();
  if (trimmed.length > 0) out.push({ content: trimmed, category, confidence });
}

function candidatesFromParsed(parsed: Record<string, unknown>): MeetingFactCandidate[] {
  const out: MeetingFactCandidate[] = [];
  const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  for (const d of decisions) pushIfContent(out, asString(d), "decision", DECISION_CONFIDENCE);

  const commitments = Array.isArray(parsed.commitments) ? parsed.commitments : [];
  for (const c of commitments) {
    if (typeof c === "string") {
      pushIfContent(out, c, "commitment", COMMITMENT_CONFIDENCE);
    } else if (c !== null && typeof c === "object") {
      const owner = asString((c as Record<string, unknown>).owner);
      const action = asString((c as Record<string, unknown>).action);
      const content = owner.length > 0 && action.length > 0 ? `${owner}: ${action}` : owner || action;
      pushIfContent(out, content, "commitment", COMMITMENT_CONFIDENCE);
    }
  }

  const questions = Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [];
  for (const q of questions) {
    const text = asString(q);
    if (text.length > 0) pushIfContent(out, `Open question: ${text}`, "fact", QUESTION_CONFIDENCE);
  }
  return out;
}

/**
 * Parse the model response into a summary + categorized candidates. Tolerant by
 * contract: malformed output yields empty candidates plus a best-effort summary
 * (the salvaged prose), and NEVER throws — a bad LLM response must degrade the
 * build, not fail it.
 */
export function parseMeetingSummaryResponse(raw: string): {
  summary: string;
  candidates: MeetingFactCandidate[];
} {
  const body = stripCodeFence(raw);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(body.slice(start, end + 1));
      if (parsed !== null && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        return { summary: asString(obj.summary), candidates: candidatesFromParsed(obj) };
      }
    } catch {
      // fall through to best-effort salvage
    }
  }
  // Best-effort: a model that ignored the JSON contract still gave us prose.
  return { summary: body.slice(0, MAX_BEST_EFFORT_SUMMARY).trim(), candidates: [] };
}

/**
 * Production extractor. Tries each injected chat client in order (local first,
 * then the gateway fallback) until one returns content; a null/empty result or
 * a thrown client error degrades to an empty extraction (no summary, no
 * candidates) instead of failing the meeting build.
 */
export class LlmMeetingSummaryExtractor implements MeetingSummaryExtractor {
  constructor(
    private readonly clients: readonly MeetingSummaryChatClient[],
    private readonly options: { maxTokens?: number } = {},
  ) {}

  async extract(input: {
    record: MeetingRecord;
    transcriptText: string;
    screenContextText: string;
  }): Promise<{ summary: string; candidates: MeetingFactCandidate[] }> {
    const raw = await this.complete(
      buildUserPrompt(input.record, input.transcriptText, input.screenContextText),
    );
    if (raw === null) return { summary: "", candidates: [] };
    return parseMeetingSummaryResponse(raw);
  }

  private async complete(userPrompt: string): Promise<string | null> {
    for (const client of this.clients) {
      try {
        const res = await client.chatCompletion(
          [
            { role: "system", content: SUMMARY_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          { temperature: 0, maxTokens: this.options.maxTokens ?? DEFAULT_MAX_TOKENS, operation: "meeting-summary" },
        );
        const content = res?.content?.trim();
        if (content !== undefined && content.length > 0) return content;
      } catch (err) {
        log.warn(
          `meetings: summary extractor LLM call failed, trying next client: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return null;
  }
}

/**
 * Judge adapter over the SHARED durability judge. Maps meeting candidates to
 * `JudgeCandidate`s, runs `judgeFacts` (the same `judgeFactDurability` closure
 * the wearables service passes — cache + defer counters included), and returns
 * verdict kinds aligned to the input candidate order. A judge outage returns an
 * empty array so `generateMeetingSummaryFacts` continues on trust score alone
 * (matching the wearables graceful-degradation contract); it never throws.
 */
export function createMeetingSummaryJudge(
  judgeFacts: (candidates: JudgeCandidate[]) => Promise<JudgeBatchResult>,
): MeetingSummaryJudge {
  return {
    async judge(candidates) {
      if (candidates.length === 0) return [];
      const judgeCandidates: JudgeCandidate[] = candidates.map((c) => ({
        text: c.content,
        category: c.category,
        confidence: c.confidence ?? 0.7,
      }));
      try {
        const { verdicts } = await judgeFacts(judgeCandidates);
        return candidates.map((_, i) => {
          const verdict = verdicts.get(i);
          return verdict ? getVerdictKind(verdict) : "defer";
        });
      } catch (err) {
        log.warn(
          `meetings: durability judge unavailable, scoring without verdicts: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return [];
      }
    },
  };
}

/**
 * Build the production summary deps (extractor + judge) the `MeetingsBuilder`
 * consumes. Pure construction — no disk, no network — so a caller can build it
 * unconditionally and let the builder gate on `summaryMode`. Reuses the caller's
 * local + fallback clients and the shared judge closure, so nothing here forks
 * the trust/judge/LLM contracts.
 */
export function createMeetingSummaryDeps(deps: {
  localLlm: MeetingSummaryChatClient | null;
  fallbackLlm: MeetingSummaryChatClient | null;
  judgeFacts: (candidates: JudgeCandidate[]) => Promise<JudgeBatchResult>;
}): { extractor: MeetingSummaryExtractor; judge: MeetingSummaryJudge } {
  const clients: MeetingSummaryChatClient[] = [];
  if (deps.localLlm !== null) clients.push(deps.localLlm);
  if (deps.fallbackLlm !== null) clients.push(deps.fallbackLlm);
  return {
    extractor: new LlmMeetingSummaryExtractor(clients),
    judge: createMeetingSummaryJudge(deps.judgeFacts),
  };
}
