import {
  type ReplayNormalizer,
  type ReplayParseOptions,
  type ReplayParseResult,
  type ReplayTurn,
} from "../types.js";
import { normalizeReplayContent, normalizeReplayRole, normalizeReplayTimestamp } from "./shared.js";

function gatherConversations(input: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(input)) {
    return input.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  }
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  if (Array.isArray(obj.conversations)) {
    return obj.conversations.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  }
  return [obj];
}

function extractFromMapping(conversation: Record<string, unknown>): Array<Record<string, unknown>> {
  const mapping = conversation.mapping;
  if (!mapping || typeof mapping !== "object") return [];
  const nodes = mapping as Record<string, unknown>;
  const currentNodeId = typeof conversation.current_node === "string" ? conversation.current_node : null;

  if (!currentNodeId || !nodes[currentNodeId] || typeof nodes[currentNodeId] !== "object") {
    // Fallback for malformed/legacy exports without a traversable active pointer.
    const loose: Array<Record<string, unknown>> = [];
    for (const node of Object.values(nodes)) {
      if (!node || typeof node !== "object") continue;
      const nodeObj = node as Record<string, unknown>;
      const message = nodeObj.message;
      if (!message || typeof message !== "object") continue;
      loose.push({
        ...(message as Record<string, unknown>),
        _nodeId: typeof nodeObj.id === "string" ? nodeObj.id : undefined,
        _nodeCreateTime: nodeObj.create_time,
      });
    }
    return loose;
  }

  const chain: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let cursor: string | null = currentNodeId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = nodes[cursor];
    if (!node || typeof node !== "object") break;
    const nodeObj = node as Record<string, unknown>;
    const message = nodeObj.message;
    if (message && typeof message === "object") {
      chain.push({
        ...(message as Record<string, unknown>),
        _nodeId: typeof nodeObj.id === "string" ? nodeObj.id : cursor,
        _nodeCreateTime: nodeObj.create_time,
      });
    }
    cursor = typeof nodeObj.parent === "string" ? nodeObj.parent : null;
  }

  return chain.reverse();
}

export const chatgptReplayNormalizer: ReplayNormalizer = {
  source: "chatgpt",
  parse(input: unknown, options: ReplayParseOptions = {}): ReplayParseResult {
    const warnings: ReplayParseResult["warnings"] = [];
    let parsedInput = input;
    if (typeof input === "string") {
      try {
        parsedInput = JSON.parse(input);
      } catch (error) {
        const message = `Invalid ChatGPT replay JSON: ${error instanceof Error ? error.message : String(error)}`;
        if (options.strict) throw new Error(message);
        warnings.push({ code: "replay.chatgpt.json.invalid", message });
        parsedInput = [];
      }
    }

    const turns: ReplayTurn[] = [];

    const conversations = gatherConversations(parsedInput);
    for (let i = 0; i < conversations.length; i += 1) {
      const conversation = conversations[i];
      const convIdRaw = conversation.id ?? conversation.conversation_id ?? conversation.uuid;
      const hasSourceConversationId = typeof convIdRaw === "string" && convIdRaw.trim().length > 0;
      const convId = hasSourceConversationId ? convIdRaw.trim() : `conv-${i + 1}`;
      const sessionKey = `replay:chatgpt:${convId}`;
      const fallbackSessionKey = options.defaultSessionKey?.trim() || sessionKey;

      const messageRows = Array.isArray(conversation.messages)
        ? conversation.messages
        : extractFromMapping(conversation);

      for (let j = 0; j < messageRows.length; j += 1) {
        const rawRow = messageRows[j];
        if (!rawRow || typeof rawRow !== "object") {
          const message = `Skipping malformed ChatGPT replay message at conversation ${i + 1}, index ${j}.`;
          if (options.strict) throw new Error(message);
          warnings.push({ code: "replay.chatgpt.message.invalid", message, index: j });
          continue;
        }
        const row = rawRow as Record<string, unknown>;
        const role = normalizeReplayRole(
          (row.author as Record<string, unknown> | undefined)?.role ?? row.role,
        );
        const content = normalizeReplayContent(
          (row.content as Record<string, unknown> | undefined)?.parts ?? row.content ?? row.text,
        );
        const timestamp = normalizeReplayTimestamp(
          row.create_time ?? row.timestamp ?? row._nodeCreateTime ?? row.created_at,
        );

        if (!role || !content || !timestamp) {
          const message = `Skipping invalid ChatGPT replay message at conversation ${i + 1}, index ${j}.`;
          if (options.strict) throw new Error(message);
          warnings.push({ code: "replay.chatgpt.message.invalid", message, index: j });
          continue;
        }

        const externalIdRaw = row.id ?? row._nodeId;

        turns.push({
          source: "chatgpt",
          sessionKey: hasSourceConversationId ? sessionKey : fallbackSessionKey,
          role,
          content,
          timestamp,
          sourceValidAt: timestamp,
          externalId: typeof externalIdRaw === "string" ? externalIdRaw : undefined,
          metadata: {
            conversationId: convId,
            conversationTitle: typeof conversation.title === "string" ? conversation.title : undefined,
          },
        });
      }
    }

    return { turns, warnings };
  },
};
