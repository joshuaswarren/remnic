export const WORK_LAYER_CONTEXT_OPEN = "[WORK_LAYER_CONTEXT";
export const WORK_LAYER_CONTEXT_CLOSE = "[/WORK_LAYER_CONTEXT]";
const WORK_LAYER_CONTEXT_ESCAPED_OPEN = "[WORK_LAYER_ESCAPED_CONTEXT";
const WORK_LAYER_CONTEXT_ESCAPED_CLOSE = "[/WORK_LAYER_CONTEXT_ESC]";

export function wrapWorkLayerContext(content: string, options?: { linkToMemory?: boolean }): string {
  const linkToMemory = options?.linkToMemory === true;
  const header = `${WORK_LAYER_CONTEXT_OPEN} link_to_memory=${linkToMemory ? "true" : "false"}]`;
  const payload = content
    .trim()
    .replaceAll(WORK_LAYER_CONTEXT_OPEN, WORK_LAYER_CONTEXT_ESCAPED_OPEN)
    .replaceAll(WORK_LAYER_CONTEXT_CLOSE, WORK_LAYER_CONTEXT_ESCAPED_CLOSE);
  return `${header}\n${payload}\n${WORK_LAYER_CONTEXT_CLOSE}`;
}

export function applyWorkExtractionBoundary(conversation: string): string {
  if (conversation.trim().length === 0) return "";

  // Replace work-layer blocks using indexOf to avoid backtracking regex.
  let bounded = conversation;
  const OPEN_TAG = "[WORK_LAYER_CONTEXT";
  const CLOSE_TAG = "[/WORK_LAYER_CONTEXT]";
  let searchFrom = 0;
  while (true) {
    const openIdx = bounded.indexOf(OPEN_TAG, searchFrom);
    if (openIdx < 0) break;
    // Require line-start anchor
    if (openIdx > 0 && bounded[openIdx - 1] !== "\n") {
      searchFrom = openIdx + OPEN_TAG.length;
      continue;
    }
    const closeBracket = bounded.indexOf("]", openIdx + OPEN_TAG.length);
    if (closeBracket < 0) break;
    const header = bounded.substring(openIdx + OPEN_TAG.length, closeBracket);
    const closeIdx = bounded.indexOf(CLOSE_TAG, closeBracket + 1);
    if (closeIdx < 0) break;
    // Parse attributes from header
    const flagMatch = header.match(/\blink_to_memory=(true|false)/);
    const encMatch = header.match(/\bencoding=(base64)/);
    const flag = flagMatch?.[1];
    const encoding = encMatch?.[1];
    // Extract body (between ] and closer)
    let bodyStart = closeBracket + 1;
    if (bounded[bodyStart] === "\n") bodyStart++;
    let bodyEnd = closeIdx;
    if (bodyEnd > bodyStart && bounded[bodyEnd - 1] === "\n") bodyEnd--;
    const body = bounded.substring(bodyStart, bodyEnd);
    const shouldLink = flag === "true";
    const prefix = openIdx > 0 ? bounded.substring(0, openIdx) : "";
    const suffix = bounded.substring(closeIdx + CLOSE_TAG.length);
    if (!shouldLink) {
      bounded = prefix + suffix;
      searchFrom = prefix.length;
    } else if (encoding === "base64") {
      try {
        const decoded = Buffer.from(body.trim(), "base64").toString("utf8").trim();
        bounded = prefix + decoded + suffix;
        searchFrom = prefix.length + decoded.length;
      } catch {
        bounded = prefix + suffix;
        searchFrom = prefix.length;
      }
    } else {
      bounded = prefix + body.trim() + suffix;
      searchFrom = prefix.length + body.trim().length;
    }
  }

  // Defensive hardening: if a *real wrapper opener* survives without a closer (e.g., turn-level truncation),
  // strip everything from the opener onward to avoid leaking excluded work-layer payloads.
  // Keep literal "[WORK_LAYER_CONTEXT" text unless it contains wrapper metadata attributes.
  // Strip unterminated work-layer openers using indexOf for safety (avoids backtracking).
  // Only match openers at the start of a line (like the original ^|\n anchor).
  let strippedUnterminated = bounded;
  const opener = "[WORK_LAYER_CONTEXT";
  const closer = "[/WORK_LAYER_CONTEXT]";
  let unterminatedSearchFrom = 0;
  while (true) {
    const openerIdx = bounded.indexOf(opener, unterminatedSearchFrom);
    if (openerIdx < 0) break;

    const isLineStart = openerIdx === 0 || bounded[openerIdx - 1] === "\n";
    if (!isLineStart) {
      unterminatedSearchFrom = openerIdx + opener.length;
      continue;
    }

    const afterOpener = bounded.indexOf("]", openerIdx);
    const bracketContent = afterOpener >= 0
      ? bounded.substring(openerIdx, afterOpener + 1)
      : bounded.substring(openerIdx);
    const hasWrapperMetadata =
      bracketContent.includes("link_to_memory=") || bracketContent.includes("encoding=");
    if (!hasWrapperMetadata) {
      unterminatedSearchFrom = openerIdx + opener.length;
      continue;
    }

    const closerAfter = afterOpener >= 0 ? bounded.indexOf(closer, afterOpener) : -1;
    if (closerAfter < 0) {
      strippedUnterminated = openerIdx > 0
        ? bounded.substring(0, openerIdx - 1)  // exclude the preceding \n
        : "";
      break;
    }

    unterminatedSearchFrom = closerAfter + closer.length;
  }

  const restoredEscapes = strippedUnterminated
    .replaceAll(WORK_LAYER_CONTEXT_ESCAPED_OPEN, WORK_LAYER_CONTEXT_OPEN)
    .replaceAll(WORK_LAYER_CONTEXT_ESCAPED_CLOSE, WORK_LAYER_CONTEXT_CLOSE);

  const cleanedLines = restoredEscapes
    .split("\n")
    .map((line) => line.trimEnd());

  return cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
