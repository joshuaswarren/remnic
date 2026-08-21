import {
  type ReplayNormalizer,
  type ReplayParseOptions,
  type ReplayParseResult,
  type ReplayTurn,
} from "../types.js";
import { normalizeReplayContent, normalizeReplayRole, normalizeReplayTimestamp } from "./shared.js";

function gatherConversations(input: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(input)) return input.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (!input || typeof input !== "object") return [];

  const obj = input as Record<string, unknown>;
  if (Array.isArray(obj.conversations)) {
    return obj.conversations.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  }

  if (Array.isArray(obj.chat_messages) || Array.isArray(obj.messages)) {
    return [obj];
  }

  return [];
}

export const claudeReplayNormalizer: ReplayNormalizer = {
  source: "claude",
  parse(input: unknown, options: ReplayParseOptions = {}): ReplayParseResult {
    const warnings: ReplayParseResult["warnings"] = [];
    let parsedInput = input;
    if (typeof input === "string") {
      try {
        parsedInput = JSON.parse(input);
      } catch (error) {
        const message = `Invalid Claude replay JSON: ${error instanceof Error ? error.message : String(error)}`;
        if (options.strict) throw new Error(message);
        warnings.push({ code: "replay.claude.json.invalid", message });
        parsedInput = [];
      }
    }

    const turns: ReplayTurn[] = [];
    const conversations = gatherConversations(parsedInput);

    for (let i = 0; i < conversations.length; i += 1) {
      const conversation = conversations[i];
      const convoIdRaw = conversation.uuid ?? conversation.id ?? conversation.conversation_id;
      const hasSourceConversationId = typeof convoIdRaw === "string" && convoIdRaw.trim().length > 0;
      const convoId = hasSourceConversationId ? convoIdRaw.trim() : `conv-${i + 1}`;
      const sessionKey = `replay:claude:${convoId}`;
      const fallbackSessionKey = options.defaultSessionKey?.trim() || sessionKey;

      const messagesRaw = Array.isArray(conversation.chat_messages)
        ? conversation.chat_messages
        : Array.isArray(conversation.messages)
          ? conversation.messages
          : [];

      for (let j = 0; j < messagesRaw.length; j += 1) {
        const msg = messagesRaw[j];
        if (!msg || typeof msg !== "object") {
          const message = `Skipping malformed Claude message at conversation ${i + 1}, index ${j}.`;
          if (options.strict) throw new Error(message);
          warnings.push({
            code: "replay.claude.message.invalid",
            message,
            index: j,
          });
          continue;
        }

        const row = msg as Record<string, unknown>;
        const role = normalizeReplayRole(
          row.sender ?? row.role ?? (row.author as Record<string, unknown> | undefined)?.role,
        );
        const content = normalizeReplayContent(row.text ?? row.content ?? row.message);
        const timestamp = normalizeReplayTimestamp(
          row.created_at ?? row.createdAt ?? row.updated_at ?? row.updatedAt ?? row.timestamp,
        );

        if (!role || !content || !timestamp) {
          const message = `Skipping invalid Claude replay message at conversation ${i + 1}, index ${j}.`;
          if (options.strict) throw new Error(message);
          warnings.push({ code: "replay.claude.message.invalid", message, index: j });
          continue;
        }

        const externalIdRaw = row.uuid ?? row.id;

        turns.push({
          source: "claude",
          sessionKey: hasSourceConversationId ? sessionKey : fallbackSessionKey,
          role,
          content,
          timestamp,
          sourceValidAt: timestamp,
          externalId: typeof externalIdRaw === "string" ? externalIdRaw : undefined,
          metadata: {
            conversationId: convoId,
            conversationName: typeof conversation.name === "string" ? conversation.name : undefined,
          },
        });
      }
    }

    return { turns, warnings };
  },
};
