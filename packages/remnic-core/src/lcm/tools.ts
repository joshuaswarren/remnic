import { Type } from "@sinclair/typebox";
import type { LcmEngine } from "./engine.js";
import { log } from "../logger.js";

interface ToolApi {
  registerTool(
    spec: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
      ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
    },
    options: { name: string },
  ): void;
}

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined as undefined };
}

function registerAliasedTool(
  api: ToolApi,
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>,
): void {
  const aliases = [name];
  if (name.startsWith("engram_")) {
    aliases.unshift(`remnic_${name.slice("engram_".length)}`);
  }

  for (const alias of aliases) {
    api.registerTool(
      {
        name: alias,
        label,
        description,
        parameters,
        execute,
      },
      { name: alias },
    );
  }
}

export function registerLcmTools(api: ToolApi, engine: LcmEngine): void {
  // engram.context_search — FTS search across conversation history
  registerAliasedTool(
    api,
    "engram_context_search",
    "Search Conversation History",
    "Search all conversation history (including compacted regions) by keyword. Returns matching message snippets from the lossless context archive.",
    Type.Object({
      query: Type.String({
        description: "Search query — keywords or phrases",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum results (default: 10)",
          minimum: 1,
          maximum: 50,
        }),
      ),
      session_id: Type.Optional(
        Type.String({
          description: "Limit search to a specific session",
        }),
      ),
    }),
    async (_toolCallId, params) => {
        const query = params.query as string;
        const limit = (params.limit as number) ?? 10;
        const sessionId = params.session_id as string | undefined;

        const results = await engine.searchContext(query, limit, sessionId);

        if (results.length === 0) {
          return toolResult(`No results found for "${query}" in conversation history.`);
        }

        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. [${r.session_id}:${r.turn_index}] (${r.role})\n   ${r.snippet}`,
          )
          .join("\n\n");

        return toolResult(
          `## Context Search: "${query}"\n\nFound ${results.length} result(s):\n\n${formatted}`,
        );
      },
  );

  // engram.context_describe — Get compressed summary of a turn range
  registerAliasedTool(
    api,
    "engram_context_describe",
    "Describe Conversation Range",
    "Get a compressed summary of a conversation turn range. Uses the hierarchical summary DAG to provide the best available summary.",
    Type.Object({
      session_id: Type.String({
        description: "Session ID to describe",
      }),
      from_turn: Type.Number({
        description: "Start turn index",
        minimum: 0,
      }),
      to_turn: Type.Number({
        description: "End turn index",
        minimum: 0,
      }),
    }),
    async (_toolCallId, params) => {
        const sessionId = params.session_id as string;
        const fromTurn = params.from_turn as number;
        const toTurn = params.to_turn as number;

        const result = await engine.describeContext(sessionId, fromTurn, toTurn);
        if (!result) {
          return toolResult(`No data found for session "${sessionId}" turns ${fromTurn}-${toTurn}.`);
        }

        return toolResult(
          `## Context Description (turns ${fromTurn}-${toTurn})\n\n` +
            `**Turns covered:** ${result.turn_count} | **Summary depth:** ${result.depth}\n\n` +
            result.summary,
        );
      },
  );

  // engram.context_expand — Retrieve raw messages (lossless)
  registerAliasedTool(
    api,
    "engram_context_expand",
    "Expand Conversation Range",
    "Retrieve full conversation messages for a turn range (lossless). Use this to recover the exact content of messages that may have been compacted.",
    Type.Object({
      session_id: Type.String({
        description: "Session ID to expand",
      }),
      from_turn: Type.Number({
        description: "Start turn index",
        minimum: 0,
      }),
      to_turn: Type.Number({
        description: "End turn index",
        minimum: 0,
      }),
      max_tokens: Type.Optional(
        Type.Number({
          description: "Maximum tokens to return (default: 8000)",
          minimum: 100,
          maximum: 32000,
        }),
      ),
    }),
    async (_toolCallId, params) => {
        const sessionId = params.session_id as string;
        const fromTurn = params.from_turn as number;
        const toTurn = params.to_turn as number;
        const maxTokens = (params.max_tokens as number) ?? 8000;

        const messages = await engine.expandContext(sessionId, fromTurn, toTurn, maxTokens);
        if (messages.length === 0) {
          return toolResult(
            `No messages found for session "${sessionId}" turns ${fromTurn}-${toTurn}.`,
          );
        }

        const formatted = messages
          .map((m) => `### Turn ${m.turn_index} (${m.role})\n\n${m.content}`)
          .join("\n\n---\n\n");

        return toolResult(
          `## Context Expansion (turns ${fromTurn}-${toTurn})\n\n` +
            `**Messages:** ${messages.length}\n\n${formatted}`,
        );
      },
  );
}
