/**
 * Host-agnostic user-message cleaning (issue #2331).
 *
 * Owns the generic part of the cleaner the OpenClaw wiring has always used
 * (`src/user-message-cleaning.ts` in the root host bundle): stripping the
 * structured host-injected memory wrappers and the leading memory-context
 * preamble from a user message. The host wrapper keeps only the
 * platform-header pattern (channel envelopes are an OpenClaw concept) and
 * delegates here, so core consumers — the episodic-context recall section
 * re-rendering archived user turns — share ONE implementation instead of a
 * second cleaner drifting beside it.
 */

/** Never-matching header pattern for callers with no platform envelope. */
const NO_PLATFORM_HEADER = /$a/;

const WRAPPER_OPEN = "<supermemory-context";
const WRAPPER_CLOSE = "</supermemory-context>";
const WRAPPER_MAX_ATTRIBUTE_CHARS = 256;

function isWhitespaceCode(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/**
 * Remove `<supermemory-context …>…</supermemory-context>` wrappers. A
 * single left-to-right scan with string searches — no regex on uncontrolled
 * input — so adversarial repeats of the tag literal stay linear (CodeQL
 * redos rule, issue #2331 review). Malformed or oversized tag heads are
 * treated as plain text, and an unterminated wrapper preserves the rest.
 */
function stripMemoryWrappers(content: string): string {
  let out = "";
  let cursor = 0;
  for (;;) {
    const open = content.indexOf(WRAPPER_OPEN, cursor);
    if (open === -1) return out + content.slice(cursor);
    const headEnd = content.indexOf(">", open);
    if (headEnd === -1) return out + content.slice(cursor);
    const head = content.slice(open + WRAPPER_OPEN.length, headEnd);
    const headIsPlain =
      head.length > 0 &&
      (head.length > WRAPPER_MAX_ATTRIBUTE_CHARS + 1 || headIsNotAttributeRun(head));
    if (head !== "" && headIsPlain) {
      // Not a wrapper open tag: keep the literal and continue after it.
      out += content.slice(cursor, open + WRAPPER_OPEN.length);
      cursor = open + WRAPPER_OPEN.length;
      continue;
    }
    const close = content.indexOf(WRAPPER_CLOSE, headEnd);
    if (close === -1) return out + content.slice(cursor);
    let after = close + WRAPPER_CLOSE.length;
    while (after < content.length && isWhitespaceCode(content.charCodeAt(after))) {
      after += 1;
    }
    cursor = after;
  }
}

/** True when the tag-head text cannot be a whitespace-led attribute run. */
function headIsNotAttributeRun(head: string): boolean {
  if (head.charCodeAt(0) !== 32 && !(head.charCodeAt(0) >= 9 && head.charCodeAt(0) <= 13)) {
    return true;
  }
  for (let index = 0; index < head.length; index += 1) {
    const code = head.charCodeAt(index);
    if (code === 60 || code === 62) return true;
  }
  return false;
}

export function cleanUserMessageWithPattern(
  content: string,
  platformHeaderPattern: RegExp,
): string {
  let cleaned = stripMemoryWrappers(content);
  const platformHeader = cleaned.match(platformHeaderPattern);
  const hasPlatformHeader = platformHeader !== null;
  if (platformHeader) {
    cleaned = cleaned.slice(platformHeader[0].length);
  }

  // Remove markdown memory context only when it is a leading preamble. If a
  // user writes a section with this title later in their message, preserve it.
  cleaned = cleaned.replace(
    /^\s*## Memory Context \((?:Engram|Remnic)\)[\s\S]*?(?=\n## |\n$)/i,
    "",
  );

  if (hasPlatformHeader) {
    cleaned = cleaned.replace(/\s*\[message_id:\s*[^\]]+\]\s*$/i, "");
  }
  return cleaned.trim();
}

/**
 * Clean an archived user turn for re-injection (issue #2331): strips the
 * memory wrappers this system itself injects, so an archived echo of a
 * previous recall output cannot re-enter the context through the
 * episodic-context section. No platform envelope stripping — core has no
 * host channel-envelope concept.
 */
export function cleanArchivedUserMessage(content: string): string {
  return cleanUserMessageWithPattern(content, NO_PLATFORM_HEADER);
}
