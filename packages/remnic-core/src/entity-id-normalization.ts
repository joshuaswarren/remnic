const BUILTIN_ALIASES: Record<string, string> = {
  openclaw: "openclaw",
  "open-claw": "openclaw",
};

function normalizeEntityNameWithPattern(
  raw: string,
  type: string,
  aliases: Readonly<Record<string, string>> | undefined,
  pattern: RegExp,
  normalizeUnicode: boolean
): string {
  const rawStr = typeof raw === "string" ? raw : "";
  const typeStr = typeof type === "string" && type.trim().length > 0 ? type : "entity";
  let name = normalizeUnicode ? rawStr.normalize("NFC").toLowerCase().trim() : rawStr.toLowerCase().trim();
  const typePrefix = `${typeStr.toLowerCase()}-`;
  if (name.startsWith(typePrefix)) name = name.slice(typePrefix.length);

  let normalized = name.replace(pattern, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const userAlias = aliases !== undefined && Object.hasOwn(aliases, normalized) ? aliases[normalized] : undefined;
  if (typeof userAlias === "string" && userAlias.length > 0) {
    normalized = userAlias;
  } else if (Object.hasOwn(BUILTIN_ALIASES, normalized)) {
    normalized = BUILTIN_ALIASES[normalized];
  }

  return `${typeStr.toLowerCase()}-${normalized}`;
}

export function normalizeEntityName(raw: string, type: string, aliases?: Readonly<Record<string, string>>): string {
  return normalizeEntityNameWithPattern(raw, type, aliases, /[^\p{L}\p{M}\p{N}]+/gu, true);
}

export function normalizeLegacyEntityName(
  raw: string,
  type: string,
  aliases?: Readonly<Record<string, string>>
): string {
  return normalizeEntityNameWithPattern(raw, type, aliases, /[^a-z0-9]+/g, false);
}
