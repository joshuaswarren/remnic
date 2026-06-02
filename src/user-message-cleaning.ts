const DEFAULT_CHANNEL_ENVELOPE_PREFIXES = ["OpenClaw"] as const;

export type UserMessageCleaner = (content: string) => string;
export type UserMessageCleanerOptions = {
  includeLegacyChannelEnvelopePattern?: boolean;
};

export function createOpenClawUserMessageCleaner(
  prefixes: readonly string[],
  options: UserMessageCleanerOptions = {},
): UserMessageCleaner {
  const normalized = normalizeOpenClawChannelEnvelopePrefixes(prefixes);
  const includeLegacyChannelEnvelopePattern =
    options.includeLegacyChannelEnvelopePattern ?? true;
  const platformHeaderPattern = channelEnvelopeHeaderPattern(
    normalized,
    includeLegacyChannelEnvelopePattern === true,
  );
  return (content) => cleanUserMessageWithPattern(content, platformHeaderPattern);
}

export function cleanUserMessage(
  content: string,
  options: { channelEnvelopePrefixes?: readonly string[] } & UserMessageCleanerOptions = {},
): string {
  const prefixes = normalizeOpenClawChannelEnvelopePrefixes(
    options.channelEnvelopePrefixes ?? DEFAULT_CHANNEL_ENVELOPE_PREFIXES,
  );
  const includeLegacyChannelEnvelopePattern =
    options.includeLegacyChannelEnvelopePattern ?? true;
  return cleanUserMessageWithPattern(
    content,
    channelEnvelopeHeaderPattern(
      prefixes,
      includeLegacyChannelEnvelopePattern === true,
    ),
  );
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

function channelEnvelopeHeaderPattern(
  prefixes: readonly string[],
  includeLegacyChannelEnvelopePattern: boolean,
): RegExp {
  const alternatives = prefixes.map(escapeRegExp).join("|");
  const patterns = [`\\[(?:${alternatives})\\s+.+?\\s+id:\\d+\\s+[^\\]]+\\]`];
  if (includeLegacyChannelEnvelopePattern) {
    patterns.push("\\[\\w+\\s+.+?\\s+id:\\d+\\s+[^\\]]+\\]");
  }
  return new RegExp(`^(?:${patterns.join("|")})\\s*`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
