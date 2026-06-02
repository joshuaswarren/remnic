let channelEnvelopePrefixes = ["OpenClaw"];

export function configureOpenClawChannelEnvelopePrefixes(prefixes: string[]): void {
  const cleaned = prefixes
    .map((prefix) => (typeof prefix === "string" ? prefix.trim() : ""))
    .filter((prefix) => prefix.length > 0);
  channelEnvelopePrefixes = cleaned.length > 0 ? cleaned : ["OpenClaw"];
}

export function cleanUserMessage(content: string): string {
  let cleaned = content;
  // Remove structured host-injected memory wrappers wherever the platform
  // emits them; free-form markdown stripping below is intentionally anchored.
  cleaned = cleaned.replace(
    /<supermemory-context[^>]*>[\s\S]*?<\/supermemory-context>\s*/gi,
    "",
  );

  const platformHeader = cleaned.match(channelEnvelopeHeaderPattern());
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

function channelEnvelopeHeaderPattern(): RegExp {
  const alternatives = channelEnvelopePrefixes
    .map(escapeRegExp)
    .join("|");
  return new RegExp(
    `^\\[(?:${alternatives})\\s+.+?\\s+id:\\d+\\s+[^\\]]+\\]\\s*`,
    "i",
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
