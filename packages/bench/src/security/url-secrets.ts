export type SecretQueryKeyPredicate = (key: string) => boolean;

export function redactUrlSecrets(
  value: string,
  redactedValue: string,
  isSecretQueryKey: SecretQueryKeyPredicate
): string {
  return redactUrlQuerySecrets(redactUrlUserinfoSecrets(value, redactedValue), redactedValue, isSecretQueryKey);
}

function redactUrlUserinfoSecrets(value: string, redactedValue: string): string {
  if (!value.includes("://")) return value;
  let redacted = "";
  let cursor = 0;
  let changed = false;

  for (let schemeEnd = value.indexOf("://"); schemeEnd !== -1; schemeEnd = value.indexOf("://", schemeEnd + 3)) {
    const schemeStart = findUrlSchemeStart(value, schemeEnd);
    if (schemeStart === -1) continue;
    const authorityStart = schemeEnd + 3;
    const authorityEnd = findUrlAuthorityEnd(value, authorityStart);
    const atIndex = value.lastIndexOf("@", authorityEnd - 1);
    if (atIndex < authorityStart) continue;
    redacted += value.slice(cursor, authorityStart);
    redacted += redactedValue;
    cursor = atIndex;
    changed = true;
  }

  return changed ? redacted + value.slice(cursor) : value;
}

function redactUrlQuerySecrets(
  value: string,
  redactedValue: string,
  isSecretQueryKey: SecretQueryKeyPredicate
): string {
  if (!/[?&;]/.test(value)) return value;
  let redacted = "";
  let cursor = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "?" && value[index] !== "&" && value[index] !== ";") continue;
    const keyStart = index + 1;
    const equalsIndex = value.indexOf("=", keyStart);
    if (equalsIndex === -1) continue;
    const valueEnd = findQueryValueEnd(value, equalsIndex + 1);
    const key = value.slice(keyStart, equalsIndex);
    if (isSecretUrlQueryKey(key, isSecretQueryKey)) {
      if (redactedValue.length > 0 && value.startsWith(redactedValue, equalsIndex + 1)) continue;
      redacted += value.slice(cursor, equalsIndex + 1);
      redacted += redactedValue;
      cursor = valueEnd;
      index = valueEnd - 1;
    }
  }

  return cursor === 0 ? value : redacted + value.slice(cursor);
}

function findQueryValueEnd(value: string, startIndex: number): number {
  let index = startIndex;
  while (index < value.length && !isQueryValueTerminator(value[index]!)) {
    index += 1;
  }
  return index;
}

function isQueryValueTerminator(char: string): boolean {
  return (
    char === "&" ||
    char === ";" ||
    char === "#" ||
    char === '"' ||
    char === "'" ||
    char === "}" ||
    char === "]" ||
    isWhitespace(char)
  );
}

function isSecretUrlQueryKey(key: string, isSecretQueryKey: SecretQueryKeyPredicate): boolean {
  try {
    return isSecretQueryKey(decodeURIComponent(key.replace(/\+/g, " ")));
  } catch {
    return isSecretQueryKey(key);
  }
}

function findUrlSchemeStart(value: string, schemeEnd: number): number {
  let cursor = schemeEnd - 1;
  while (cursor >= 0 && isUrlSchemeChar(value[cursor]!)) cursor -= 1;
  const schemeStart = cursor + 1;
  return schemeStart < schemeEnd && isAsciiLetter(value[schemeStart]!) ? schemeStart : -1;
}

function isUrlSchemeChar(char: string): boolean {
  return isAsciiAlnum(char) || char === "+" || char === "-" || char === ".";
}

function findUrlAuthorityEnd(value: string, authorityStart: number): number {
  let cursor = authorityStart;
  while (cursor < value.length && !isUrlAuthorityTerminator(value[cursor]!)) cursor += 1;
  return cursor;
}

function isUrlAuthorityTerminator(char: string): boolean {
  return char === "/" || char === "?" || char === "#" || isWhitespace(char) || char === '"' || char === "'";
}

function isAsciiLetter(char: string): boolean {
  return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z");
}

function isAsciiAlnum(char: string): boolean {
  return isAsciiLetter(char) || (char >= "0" && char <= "9");
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}
