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

export type UserMessageCleaner = (content: string) => string;

export function cleanUserMessageWithPattern(
  content: string,
  platformHeaderPattern: RegExp,
): string {
  let cleaned = content;
  // Remove structured host-injected memory wrappers wherever the platform
  // emits them; free-form markdown stripping below is intentionally anchored.
  // The opening tag admits one whitespace-led attribute run, bounded (256
  // chars) and exclusive of angle brackets, so repeated `<supermemory-context`
  // literals cannot drive polynomial backtracking (CodeQL redos rule) — the
  // attribute scan stops at the next `<` or `>` and the bound caps the work
  // per start position.
  cleaned = cleaned.replace(
    /<supermemory-context(?:\s[^<>]{0,256})?>[\s\S]*?<\/supermemory-context>\s*/gi,
    "",
  );

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
