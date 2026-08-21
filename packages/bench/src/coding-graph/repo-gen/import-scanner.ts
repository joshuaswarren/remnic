import type { SyntheticFile } from "./types.js";

function isImportWhitespace(code: number): boolean {
  return (
    (code >= 0x0009 && code <= 0x000d)
    || code === 0x0020
    || code === 0x00a0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff
  );
}

function isImportIdentifierChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x5f
  );
}

function skipImportWhitespace(source: string, start: number, end = source.length): number {
  let cursor = start;
  while (cursor < end && isImportWhitespace(source.charCodeAt(cursor))) cursor++;
  return cursor;
}

function isImportKeywordAt(source: string, index: number): boolean {
  if (!source.startsWith("import", index)) return false;
  if (index > 0 && isImportIdentifierChar(source.charCodeAt(index - 1))) return false;
  const afterKeyword = index + "import".length;
  return (
    afterKeyword >= source.length
    || isImportWhitespace(source.charCodeAt(afterKeyword))
    || source[afterKeyword] === "{"
  );
}

function importedNameFromSpecifier(source: string, start: number, end: number): string {
  const trimmedStart = skipImportWhitespace(source, start, end);
  let trimmedEnd = end;
  while (
    trimmedEnd > trimmedStart
    && isImportWhitespace(source.charCodeAt(trimmedEnd - 1))
  ) {
    trimmedEnd--;
  }
  for (let cursor = trimmedStart; cursor < trimmedEnd; cursor++) {
    if (!isImportWhitespace(source.charCodeAt(cursor))) continue;
    const whitespaceEnd = skipImportWhitespace(source, cursor, trimmedEnd);
    if (
      source.startsWith("as", whitespaceEnd)
      && whitespaceEnd + 2 < trimmedEnd
      && isImportWhitespace(source.charCodeAt(whitespaceEnd + 2))
    ) {
      return source.slice(trimmedStart, cursor);
    }
    cursor = whitespaceEnd - 1;
  }
  return source.slice(trimmedStart, trimmedEnd);
}

function scanNamedImportDeclaration(
  source: string,
  importStart: number,
): { names?: string[]; resumeAt: number } {
  let cursor = skipImportWhitespace(source, importStart + "import".length);
  if (source[cursor] !== "{") return { resumeAt: importStart + 1 };
  cursor++;
  let specifierStart = cursor;
  const names: string[] = [];
  while (cursor < source.length) {
    if (source[cursor] === "{") return { resumeAt: cursor };
    if (isImportKeywordAt(source, cursor)) return { resumeAt: cursor };
    if (source[cursor] === "," || source[cursor] === "}") {
      const name = importedNameFromSpecifier(source, specifierStart, cursor);
      if (name.length > 0) names.push(name);
      if (source[cursor] === ",") {
        cursor++;
        specifierStart = cursor;
        continue;
      }
      if (names.length === 0) return { resumeAt: cursor + 1 };
      cursor = skipImportWhitespace(source, cursor + 1);
      if (!source.startsWith("from", cursor)) return { resumeAt: cursor };
      cursor = skipImportWhitespace(source, cursor + "from".length);
      const quote = source[cursor];
      if (quote !== "'" && quote !== "\"") return { resumeAt: cursor };
      const moduleStart = cursor + 1;
      const moduleEnd = source.indexOf(quote, moduleStart);
      if (moduleEnd === -1) return { resumeAt: source.length };
      if (source.slice(moduleStart, moduleEnd) !== "./utils.js") {
        return { resumeAt: moduleEnd + 1 };
      }
      return { names, resumeAt: moduleEnd + 1 };
    }
    cursor++;
  }
  return { resumeAt: source.length };
}

function namedImportsFromUtils(source: string): string[] {
  let cursor = 0;
  while (cursor <= source.length - "import".length) {
    if (!isImportKeywordAt(source, cursor)) {
      cursor++;
      continue;
    }
    const parsed = scanNamedImportDeclaration(source, cursor);
    if (parsed.names) return parsed.names;
    cursor = Math.max(cursor + 1, parsed.resumeAt);
  }
  return [];
}

export function unresolvedHelperImports(files: readonly SyntheticFile[]): string[] {
  const helper = files.find((file) => file.path === "src/helper.ts")?.content;
  const utilities = files.find((file) => file.path === "src/utils.ts")?.content;
  if (!helper || !utilities) return ["missing src/helper.ts or src/utils.ts"];
  const importedNames = namedImportsFromUtils(helper);
  if (importedNames.length === 0) return [];
  const exports = new Set(
    [...utilities.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)/g)]
      .map((match) => match[1]),
  );
  return importedNames.filter((name) => name.length > 0 && !exports.has(name));
}
