const DEFAULT_CHANNEL_ENVELOPE_PREFIXES = ["OpenClaw"] as const;

export type UserMessageCleaner = (content: string) => string;

export function configureOpenClawChannelEnvelopePrefixes(prefixes: string[]): string[] {
  return normalizeOpenClawChannelEnvelopePrefixes(prefixes);
}

export function createOpenClawUserMessageCleaner(prefixes: readonly string[]): UserMessageCleaner {
  const normalized = normalizeOpenClawChannelEnvelopePrefixes(prefixes);
  const platformHeaderPattern = channelEnvelopeHeaderPattern(normalized);
  return (content) => cleanUserMessageWithPattern(content, platformHeaderPattern);
}

export function cleanUserMessage(
  content: string,
  options: { channelEnvelopePrefixes?: readonly string[] } = {},
): string {
  const prefixes = normalizeOpenClawChannelEnvelopePrefixes(
    options.channelEnvelopePrefixes ?? DEFAULT_CHANNEL_ENVELOPE_PREFIXES,
  );
  return cleanUserMessageWithPattern(content, channelEnvelopeHeaderPattern(prefixes));
}

function cleanUserMessageWithPattern(
  content: string,
  platformHeaderPattern: RegExp,
): string {
  let cleaned = content;
  // Remove structured host-injected memory wrappers wherever the platform
  // emits them; free-form markdown stripping below is intentionally anchored.
  cleaned = cleaned.replace(
    /<supermemory-context[^>]*>[\s\S]*?<\/supermemory-context>\s*/gi,
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

function normalizeOpenClawChannelEnvelopePrefixes(prefixes: readonly string[]): string[] {
  const cleaned = prefixes
    .map((prefix) => (typeof prefix === "string" ? prefix.trim() : ""))
    .filter((prefix) => prefix.length > 0);
  return cleaned.length > 0 ? cleaned : [...DEFAULT_CHANNEL_ENVELOPE_PREFIXES];
}

function channelEnvelopeHeaderPattern(prefixes: readonly string[]): RegExp {
  const alternatives = prefixes.map(escapeRegExp).join("|");
  return new RegExp(
    `^\\[(?:${alternatives})\\s+.+?\\s+id:\\d+\\s+[^\\]]+\\]\\s*`,
    "i",
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
