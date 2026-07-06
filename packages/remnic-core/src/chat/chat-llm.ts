/**
 * LLM adapter for the chat engine (issue #1583).
 *
 * The adapter exposes the production {@link ChatLlmAdapter} interface so the
 * engine is decoupled from the routing chain.  Two implementations:
 *
 * - {@link createProductionChatLlmAdapter}: wraps the existing
 *   FallbackLlmClient / LocalLlmClient routing chain so local Ollama/vLLM
 *   models are fully supported (gotcha 1).  Memory chat must not require
 *   cloud.
 *
 * - {@link StubChatLlmAdapter}: test-only adapter that drives scripted
 *   tool-call sequences.  PR 1 tests use this to verify the engine loop,
 *   confirmation protocol, budget exhaustion, and citation guard without
 *   real LLM calls.
 */

import type { ChatLlmAdapter, ChatLlmMessage, ChatLlmResponse, ChatLlmToolCall, ChatToolSchema } from "./chat-types.js";

// ---------------------------------------------------------------------------
// Minimal LLM-client interface (duck-typed from FallbackLlmClient and
// LocalLlmClient — both expose chatCompletion returning {content}|null).
// ---------------------------------------------------------------------------

interface LlmLikeClient {
  chatCompletion(
    messages: Array<{ role: string; content: string }>,
    options?: { model?: string; signal?: AbortSignal; [k: string]: unknown },
  ): Promise<{ content: string; modelUsed?: string } | null>;
}

/**
 * Create a production LLM adapter from an existing routing-chain client
 * (FallbackLlmClient or LocalLlmClient).
 *
 * The adapter maps the chat engine's message format to the client's
 * chatCompletion signature, injects the tool schema as a system-level
 * instruction (OpenAI function-calling compat), and parses tool-call requests
 * from the model's response.
 */
export function createProductionChatLlmAdapter(
  client: LlmLikeClient,
): ChatLlmAdapter {
  return {
    async complete(
      messages: ChatLlmMessage[],
      options: { tools: ChatToolSchema[]; model?: string; signal?: AbortSignal },
    ): Promise<ChatLlmResponse | null> {
      // Build the tool-calling instruction appended to the system message.
      const toolInstruction = formatToolInstruction(options.tools);
      const mapped = messages.map((m) => {
        if (m.role === "system") {
          return { role: m.role, content: m.content + "\n\n" + toolInstruction };
        }
        return { role: m.role, content: m.content };
      });
      const result = await client.chatCompletion(mapped, {
        ...(options.model ? { model: options.model } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!result) return null;
      const toolCalls = parseToolCalls(result.content);
      return {
        content: stripToolCallJson(result.content, toolCalls),
        toolCalls,
      };
    },
  };
}

/**
 * Format the available tools as a function-calling instruction for the LLM.
 * Models that support native function-calling can ignore this; models that
 * don't (most local models) use it to emit structured tool calls.
 */
function formatToolInstruction(tools: ChatToolSchema[]): string {
  if (tools.length === 0) return "";
  const lines = [
    "## Available tools",
    "",
    "You may call the following tools by emitting a JSON block on its own line:",
    "```json",
    '{"tool": "<name>", "arguments": { ... }}',
    "```",
    "",
    "Call one tool at a time. After receiving the tool result, continue your",
    "reasoning or emit another tool call. When you have a final answer, reply",
    "with text only (no tool-call JSON).",
    "",
    "Tools:",
  ];
  for (const t of tools) {
    const params = JSON.stringify(t.function.parameters);
    lines.push(`- ${t.function.name}: ${t.function.description}`);
    lines.push(`  Parameters: ${params}`);
  }
  return lines.join("\n");
}

/**
 * Parse a tool-call JSON block from the model's response content.
 * Tolerates leading/trailing text and code fences.
 */
export function parseToolCalls(content: string): ChatLlmToolCall[] {
  const calls: ChatLlmToolCall[] = [];
  // Match ```json ... ``` blocks and bare JSON objects with "tool" key.
  const patterns = [
    /```json\s*\n([\s\S]*?)\n```/g,
    /```\s*\n([\s\S]*?)\n```/g,
  ];
  const candidates: string[] = [];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      candidates.push(match[1]);
    }
  }
  // Also try bare JSON lines.
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes('"tool"')) {
      candidates.push(trimmed);
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { tool?: string; arguments?: Record<string, unknown> };
      if (typeof parsed.tool === "string" && parsed.tool.length > 0) {
        calls.push({
          id: `call_${calls.length + 1}`,
          name: parsed.tool,
          arguments: parsed.arguments ?? {},
        });
      }
    } catch {
      // Not valid JSON — skip.
    }
  }
  return calls;
}

/**
 * Remove tool-call JSON blocks from the content, leaving only prose.
 */
function stripToolCallJson(content: string, toolCalls: ChatLlmToolCall[]): string {
  if (toolCalls.length === 0) return content;
  let result = content;
  // Remove fenced blocks.
  result = result.replace(/```json\s*\n[\s\S]*?\n```/g, "");
  result = result.replace(/```\s*\n[\s\S]*?\n```/g, "");
  // Remove bare JSON tool-call lines.
  result = result
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith("{") && trimmed.includes('"tool"'));
    })
    .join("\n");
  return result.trim();
}

// ---------------------------------------------------------------------------
// Stub adapter — for tests (rule 33: production signature, scripted behaviour)
// ---------------------------------------------------------------------------

/**
 * A scripted step in the stub adapter.  Each step is consumed in order for
 * each LLM call; the last step repeats if the engine loops beyond the
 * script length.
 */
export interface StubLlmStep {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export class StubChatLlmAdapter implements ChatLlmAdapter {
  private steps: StubLlmStep[];
  private callIndex = 0;

  constructor(steps: StubLlmStep[]) {
    this.steps = steps;
  }

  async complete(
    _messages: ChatLlmMessage[],
    _options: { tools: ChatToolSchema[]; model?: string; signal?: AbortSignal },
  ): Promise<ChatLlmResponse | null> {
    const step = this.steps[Math.min(this.callIndex, this.steps.length - 1)];
    this.callIndex++;
    const toolCalls: ChatLlmToolCall[] = (step.toolCalls ?? []).map((tc, i) => ({
      id: `call_${i + 1}`,
      name: tc.name,
      arguments: tc.arguments,
    }));
    return {
      content: step.content ?? "",
      toolCalls,
    };
  }

  /** Reset the call index (for test reuse). */
  reset(): void {
    this.callIndex = 0;
  }
}

/**
 * A stub adapter that always returns null (simulates LLM outage, rule 13).
 */
export class NullChatLlmAdapter implements ChatLlmAdapter {
  async complete(): Promise<null> {
    return null;
  }
}
