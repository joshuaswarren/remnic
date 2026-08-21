/**
 * Transcript turn helpers shared by the embedded runtime (root src/index.ts)
 * and the delegate runtime. Moved here from root src/index.ts so both bridge
 * modes use one implementation (issue #2120).
 */

export function extractLastTurn(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  return lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages.slice(-2);
}

export function extractTextContent(msg: Record<string, unknown>): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .filter(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          block.type === "text" &&
          typeof block.text === "string",
      )
      .map((block) => block.text as string)
      .join("\n");
  }
  return "";
}
