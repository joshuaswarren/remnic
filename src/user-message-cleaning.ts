export function cleanUserMessage(content: string): string {
  let cleaned = content;
  // Remove structured host-injected memory wrappers wherever the platform
  // emits them; free-form markdown stripping below is intentionally anchored.
  cleaned = cleaned.replace(
    /<supermemory-context[^>]*>[\s\S]*?<\/supermemory-context>\s*/gi,
    "",
  );

  const platformHeader = cleaned.match(/^\[\w+\s+.+?\s+id:\d+\s+[^\]]+\]\s*/);
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
