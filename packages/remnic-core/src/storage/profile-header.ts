const LAST_UPDATED_HEADER = /^\*Last updated:[^*]*\*$/;
const PROFILE_TITLE = /^ {0,3}#\s+/;
const MARKDOWN_HEADING = /^#{1,6}(?:\s+|$)/;
const MARKDOWN_LIST_ITEM = /^(?:[-+*]|\d+[.)])\s+/;
const MARKDOWN_THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const MARKDOWN_SETEXT_UNDERLINE = /^(?:=+|-+)$/;
const MARKDOWN_BLOCK_QUOTE = /^>/;
const UTF8_BOM = "\uFEFF";

type FenceMarker = {
  character: string;
  length: number;
  trailing: string;
};

function isLastUpdatedHeader(line: string): boolean {
  const withoutBom = line.startsWith(UTF8_BOM) ? line.slice(1) : line;
  if (isIndentedCodeLine(withoutBom)) return false;
  return LAST_UPDATED_HEADER.test(withoutBom.trim());
}

function isIndentedCodeLine(line: string): boolean {
  let indentation = 0;
  while (line[indentation] === " ") indentation += 1;
  return indentation >= 4 || line[indentation] === "\t";
}

function getFenceMarker(line: string): FenceMarker | null {
  let indentation = 0;
  while (line[indentation] === " ") indentation += 1;
  if (indentation > 3 || line[indentation] === "\t") return null;
  const trimmed = line.slice(indentation);
  const character = trimmed[0];
  if (character !== "`" && character !== "~") return null;
  let length = 0;
  while (trimmed[length] === character) length += 1;
  if (length < 3) return null;
  const trailing = trimmed.slice(length);
  if (character === "`" && trailing.includes("`")) return null;
  return { character, length, trailing };
}

function isClosingFence(fence: FenceMarker, openFence: FenceMarker): boolean {
  return (
    fence.character === openFence.character &&
    fence.length >= openFence.length &&
    fence.trailing.trim() === ""
  );
}

const RAW_HTML_BLOCK_TAGS = ["pre", "textarea", "script", "style", "xmp"] as const;
const HTML_BLOCK_TAGS = [
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul",
] as const;

type HtmlBlock = {
  endMarker: string | null;
  endsAtBlankLine: boolean;
  tagName: string | null;
  depth: number;
};

function findHtmlBlockTag(line: string, tags: readonly string[]): string | null {
  const isClosing = line.startsWith("</");
  const nameStart = isClosing ? 2 : 1;
  for (const tag of tags) {
    const nextCharacter = line[nameStart + tag.length];
    if (
      line.startsWith(`${isClosing ? "</" : "<"}${tag}`) &&
      (nextCharacter === undefined ||
        nextCharacter === ">" ||
        nextCharacter === "/" ||
        nextCharacter === " " ||
        nextCharacter === "\t")
    ) {
      return tag;
    }
  }
  return null;
}

type HtmlTag = {
  name: string;
  isClosing: boolean;
  isSelfClosing: boolean;
};

function isAsciiLetter(character: string): boolean {
  return (
    (character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z")
  );
}

function isHtmlTagNameCharacter(character: string): boolean {
  return (
    isAsciiLetter(character) ||
    (character >= "0" && character <= "9") ||
    character === "-"
  );
}
const HTML_ATTRIBUTES =
  /^(?:[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*$/;

function hasValidHtmlTagAttributes(attributeText: string, isClosing: boolean): boolean {
  const trimmed = attributeText.trim();
  if (isClosing || trimmed === "") return trimmed === "";
  const withoutSelfClosingSlash = trimmed.endsWith("/")
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;
  return withoutSelfClosingSlash === "" || HTML_ATTRIBUTES.test(withoutSelfClosingSlash);
}

function findCompleteHtmlTag(line: string): HtmlTag | null {
  let index = 1;
  const isClosing = line[index] === "/";
  if (isClosing) index += 1;
  const nameStart = index;
  if (!isAsciiLetter(line[index] ?? "")) return null;
  while (isHtmlTagNameCharacter(line[index] ?? "")) index += 1;
  const nextCharacter = line[index] ?? "";
  if (
    nextCharacter !== ">" &&
    nextCharacter !== "/" &&
    nextCharacter !== " " &&
    nextCharacter !== "\t"
  ) {
    return null;
  }
  const name = line.slice(nameStart, index).toLowerCase();
  let quote: string | null = null;
  for (; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">" && line.slice(index + 1).trim() === "") {
      const tagBody = line.slice(nameStart, index).trimEnd();
      if (!hasValidHtmlTagAttributes(tagBody.slice(name.length), isClosing)) return null;
      return {
        name,
        isClosing,
        isSelfClosing: !isClosing && tagBody.endsWith("/"),
      };
    }
  }
  return null;
}
function findHtmlTagPrefix(line: string): HtmlTag | null {
  let quote: string | null = null;
  for (let index = 1; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character !== ">") continue;
    return findCompleteHtmlTag(line.slice(0, index + 1));
  }
  return null;
}

function isRawHtmlBlockTerminator(line: string): boolean {
  const normalizedLine = line.toLowerCase();
  return RAW_HTML_BLOCK_TAGS.some((name) =>
    hasRawHtmlBlockEndMarker(normalizedLine, `</${name}>`),
  );
}

function findHtmlTags(line: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "<") {
      index += 1;
      continue;
    }

    let cursor = index + 1;
    const isClosing = line[cursor] === "/";
    if (isClosing) cursor += 1;
    const nameStart = cursor;
    if (!isAsciiLetter(line[cursor] ?? "")) {
      index += 1;
      continue;
    }
    while (isHtmlTagNameCharacter(line[cursor] ?? "")) cursor += 1;
    const name = line.slice(nameStart, cursor).toLowerCase();
    let quote: string | null = null;
    for (; cursor < line.length; cursor += 1) {
      const character = line[cursor] ?? "";
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === "\"" || character === "'") {
        quote = character;
        continue;
      }
      if (character !== ">") continue;
      const tagBody = line.slice(nameStart, cursor).trimEnd();
      tags.push({
        name,
        isClosing,
        isSelfClosing: !isClosing && tagBody.endsWith("/"),
      });
      index = cursor + 1;
      break;
    }
    if (cursor >= line.length) break;
  }
  return tags;
}

function updateHtmlBlockDepth(
  htmlBlock: HtmlBlock,
  line: string,
  skipFirstOpening: boolean,
): HtmlBlock | null {
  if (!htmlBlock.tagName) return htmlBlock;
  let depth = htmlBlock.depth;
  let skippedFirstOpening = !skipFirstOpening;
  for (const tag of findHtmlTags(line)) {
    if (tag.name !== htmlBlock.tagName) continue;
    if (tag.isClosing) {
      depth -= 1;
    } else if (!tag.isSelfClosing) {
      if (!skippedFirstOpening) {
        skippedFirstOpening = true;
        continue;
      }
      depth += 1;
    }
  }
  if (depth > 0) return { ...htmlBlock, depth };
  return htmlBlock.endsAtBlankLine
    ? { endMarker: null, endsAtBlankLine: true, tagName: null, depth: 0 }
    : null;
}

function findHtmlBlockStart(
  normalizedLine: string,
  trimmedLine: string,
  allowGenericHtmlBlock: boolean,
): HtmlBlock | null {
  const rawTag = findHtmlBlockTag(normalizedLine, RAW_HTML_BLOCK_TAGS);
  if (rawTag) {
    const completeTag =
      findCompleteHtmlTag(trimmedLine) ?? findHtmlTagPrefix(trimmedLine);
    if (!completeTag) return null;
    if (completeTag.isSelfClosing) {
      return { endMarker: null, endsAtBlankLine: true, tagName: null, depth: 0 };
    }
    const endMarker = `</${rawTag}>`;
    if (hasHtmlBlockEndMarker(normalizedLine, endMarker)) return null;
    return { endMarker, endsAtBlankLine: false, tagName: null, depth: 0 };
  }
  if (normalizedLine.startsWith("<!--")) {
    return { endMarker: "-->", endsAtBlankLine: false, tagName: null, depth: 0 };
  }
  if (normalizedLine.startsWith("<?")) {
    return { endMarker: "?>", endsAtBlankLine: false, tagName: null, depth: 0 };
  }
  if (trimmedLine.startsWith("<![CDATA[")) {
    return { endMarker: "]]>", endsAtBlankLine: false, tagName: null, depth: 0 };
  }
  const declarationFirst = trimmedLine[2];
  if (
    trimmedLine.startsWith("<!") &&
    declarationFirst &&
    declarationFirst >= "A" &&
    declarationFirst <= "Z"
  ) {
    return trimmedLine.trimEnd().endsWith(">")
      ? null
      : { endMarker: ">", endsAtBlankLine: false, tagName: null, depth: 0 };
  }
  const blockTag = findHtmlBlockTag(normalizedLine, HTML_BLOCK_TAGS);
  if (blockTag) {
    const completeTag =
      findCompleteHtmlTag(trimmedLine) ?? findHtmlTagPrefix(trimmedLine);
    if (!completeTag) return null;
    if (completeTag.isClosing) {
      return { endMarker: null, endsAtBlankLine: true, tagName: null, depth: 0 };
    }
    if (completeTag.isSelfClosing) {
      return { endMarker: null, endsAtBlankLine: true, tagName: null, depth: 0 };
    }
    return { endMarker: `</${blockTag}>`, endsAtBlankLine: true, tagName: blockTag, depth: 1 };
  }
  if (!allowGenericHtmlBlock) return null;
  const genericTag = findCompleteHtmlTag(trimmedLine);
  if (!genericTag) return null;
  if (genericTag.isClosing || genericTag.isSelfClosing) {
    return { endMarker: null, endsAtBlankLine: true, tagName: null, depth: 0 };
  }
  return { endMarker: `</${genericTag.name}>`, endsAtBlankLine: true, tagName: genericTag.name, depth: 1 };
}


type ProfileLine = {
  content: string;
  ending: string;
};

function parseProfileLines(content: string): ProfileLine[] {
  const segments = content.split(/(\r\n|\n|\r)/);
  const lines: ProfileLine[] = [];
  for (let index = 0; index < segments.length; index += 2) {
    lines.push({
      content: segments[index] ?? "",
      ending: segments[index + 1] ?? "",
    });
  }
  return lines;
}

function renderProfileLines(lines: ProfileLine[]): string {
  let rendered = "";
  for (const line of lines) {
    rendered += line.content + line.ending;
  }
  return rendered;
}

function findFrontmatterEnd(lines: ProfileLine[]): number {
  const firstLine = lines[0]?.content.startsWith(UTF8_BOM) ? lines[0].content.slice(1) : lines[0]?.content;
  if (firstLine !== "---") return -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.content.trimEnd();
    if (line === "---" || line === "...") return index;
  }
  return -1;
}

function hasHtmlBlockEndMarker(line: string, endMarker: string): boolean {
  return line.includes(endMarker);
}

function isHtmlBlockTerminator(line: string): boolean {
  return (
    isRawHtmlBlockTerminator(line) ||
    line.includes("-->") ||
    line.includes("?>") ||
    line.includes("]]>")
  );
}
function shouldCloseHtmlBlock(lines: ProfileLine[], index: number, endMarker: string): boolean {
  const normalizedLine = lines[index]?.content.trimStart().toLowerCase() ?? "";
  const normalizedMarker = endMarker.toLowerCase();
  if (!normalizedLine.includes(normalizedMarker)) return false;
  if (normalizedLine.trim() === normalizedMarker || normalizedMarker.startsWith("</")) return true;
  return !lines
    .slice(index + 1)
    .some((line) => line.content.trim().toLowerCase() === normalizedMarker);
}


function hasRawHtmlBlockEndMarker(line: string, endMarker: string): boolean {
  return line.includes(endMarker);
}
function canStartGenericHtmlBlock(lines: ProfileLine[], index: number): boolean {
  const previousLine = lines[index - 1]?.content.trim() ?? "";
  if (previousLine === "") return true;
  return (
    isMetadataBoundary(previousLine) &&
    !MARKDOWN_LIST_ITEM.test(previousLine) &&
    !MARKDOWN_BLOCK_QUOTE.test(previousLine)
  );
}

function visitProfileMetadataLines(
  lines: ProfileLine[],
  visit: (line: string, index: number) => void,
): void {
  const frontmatterEnd = findFrontmatterEnd(lines);
  let openFence: FenceMarker | null = null;
  let openHtmlBlock: HtmlBlock | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.content ?? "";
    const parserLine = index === 0 && line.startsWith(UTF8_BOM) ? line.slice(1) : line;
    if (index <= frontmatterEnd) continue;
    const fence = getFenceMarker(parserLine);
    if (openFence) {
      if (fence && isClosingFence(fence, openFence)) openFence = null;
      continue;
    }
    const trimmedLine = parserLine.trimStart();
    const normalizedLine = trimmedLine.toLowerCase();
    if (openHtmlBlock) {
      if (openHtmlBlock.endsAtBlankLine && normalizedLine === "") {
        openHtmlBlock = null;
        continue;
      }
      if (openHtmlBlock.tagName) {
        openHtmlBlock = updateHtmlBlockDepth(openHtmlBlock, normalizedLine, false);
        continue;
      }
      if (openHtmlBlock.endMarker && shouldCloseHtmlBlock(lines, index, openHtmlBlock.endMarker)) {
        openHtmlBlock = null;
      }
      continue;
    }
    if (isIndentedCodeLine(parserLine)) continue;
    if (fence) {
      openFence = fence;
      continue;
    }
    const htmlBlock = findHtmlBlockStart(
      normalizedLine,
      trimmedLine,
      canStartGenericHtmlBlock(lines, index),
    );
    if (htmlBlock) {
      openHtmlBlock = htmlBlock.tagName
        ? updateHtmlBlockDepth(htmlBlock, normalizedLine, true)
        : htmlBlock.endMarker && shouldCloseHtmlBlock(lines, index, htmlBlock.endMarker)
          ? null
          : htmlBlock;
      continue;
    }
    visit(line, index);
  }
}

function isNestedListTitle(lines: ProfileLine[], index: number, indentation: number): boolean {
  for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
    const previousLine = lines[previousIndex]?.content ?? "";
    if (previousLine.trim() === "") continue;
    const previousIndentation = previousLine.length - previousLine.trimStart().length;
    if (previousIndentation >= indentation) continue;
    return MARKDOWN_LIST_ITEM.test(previousLine.trimStart());
  }
  return false;
}

function isProfileTitleLine(lines: ProfileLine[], index: number, line: string): boolean {
  const titleLine = index === 0 && line.startsWith(UTF8_BOM) ? line.slice(1) : line;
  if (!PROFILE_TITLE.test(titleLine)) return false;
  const indentation = titleLine.length - titleLine.trimStart().length;
  if (indentation === 0 || index === 0) return true;
  const previousLine = lines[index - 1]?.content.trim() ?? "";
  return previousLine === ""
    ? !isNestedListTitle(lines, index, indentation)
    : previousLine === "---" || previousLine === "...";
}

function findProfileTitleIndex(lines: ProfileLine[]): number {
  let titleIndex = -1;
  visitProfileMetadataLines(lines, (line, index) => {
    if (titleIndex >= 0) return;
    if (isProfileTitleLine(lines, index, line)) titleIndex = index;
  });
  return titleIndex;
}

function isMetadataBoundary(line: string): boolean {
  return (
    line === "" ||
    MARKDOWN_HEADING.test(line) ||
    MARKDOWN_LIST_ITEM.test(line) ||
    MARKDOWN_THEMATIC_BREAK.test(line) ||
    MARKDOWN_SETEXT_UNDERLINE.test(line) ||
    MARKDOWN_BLOCK_QUOTE.test(line) ||
    isLastUpdatedHeader(line) ||
    getFenceMarker(line) !== null ||
    isHtmlBlockTerminator(line)
  );
}

function isStandaloneMetadataLine(
  lines: ProfileLine[],
  index: number,
  frontmatterEnd: number,
): boolean {
  const previousLine = lines[index - 1]?.content.trim() ?? "";
  const nextLine = lines[index + 1]?.content.trim() ?? "";
  const previousWithoutBom = previousLine.startsWith(UTF8_BOM)
    ? previousLine.slice(1)
    : previousLine;
  const nextWithoutBom = nextLine.startsWith(UTF8_BOM) ? nextLine.slice(1) : nextLine;
  const previousMetadataBoundary = isMetadataBoundary(previousWithoutBom);
  const nextMetadataBoundary = isMetadataBoundary(nextWithoutBom);
  const previousContainerMarker =
    !MARKDOWN_THEMATIC_BREAK.test(previousWithoutBom) &&
    (MARKDOWN_LIST_ITEM.test(previousWithoutBom) || MARKDOWN_BLOCK_QUOTE.test(previousWithoutBom));
  const startsBlock =
    (index === 0 || index === frontmatterEnd + 1 || previousMetadataBoundary) &&
    !previousContainerMarker;
  const endsBlock = index === lines.length - 1 || nextMetadataBoundary;
  const compactHeaderAfterTitle = isProfileTitleLine(lines, index - 1, previousWithoutBom);
  const compactHeaderAfterHeader = isLastUpdatedHeader(previousWithoutBom);
  return startsBlock && (endsBlock || compactHeaderAfterTitle || compactHeaderAfterHeader);
}

function findProfileHeaderIndexes(lines: ProfileLine[]): number[] {
  const indexes: number[] = [];
  const frontmatterEnd = findFrontmatterEnd(lines);
  visitProfileMetadataLines(lines, (line, index) => {
    if (
      isLastUpdatedHeader(line) &&
      isStandaloneMetadataLine(lines, index, frontmatterEnd)
    ) {
      indexes.push(index);
    }
  });
  return indexes;
}

function insertHeaderAfter(lines: ProfileLine[], index: number, header: string): void {
  const insertAt = index + 1;
  const ending = lines[index]?.ending || lines[insertAt]?.ending || "\n";
  if (lines[insertAt]?.content.trim() === "") {
    lines.splice(
      insertAt + 1,
      0,
      { content: header, ending },
      { content: "", ending },
    );
  } else {
    lines.splice(
      insertAt,
      0,
      { content: "", ending },
      { content: header, ending },
      { content: "", ending },
    );
  }
}

function prependHeader(lines: ProfileLine[], header: string): string {
  const frontmatterEnd = findFrontmatterEnd(lines);
  if (frontmatterEnd >= 0) {
    insertHeaderAfter(lines, frontmatterEnd, header);
    return renderProfileLines(lines);
  }
  const ending = lines[0]?.ending || "\n";
  if (lines[0]?.content.startsWith(UTF8_BOM)) {
    lines[0].content = lines[0].content.slice(1);
    lines.unshift(
      { content: `${UTF8_BOM}${header}`, ending },
      { content: "", ending },
    );
    return renderProfileLines(lines);
  }
  lines.unshift(
    { content: header, ending },
    { content: "", ending },
  );
  return renderProfileLines(lines);
}

export function renderProfileWithLastUpdated(content: string, updatedAt: string): string {
  const lines = parseProfileLines(content);
  const header = `*Last updated: ${updatedAt}*`;
  const titleIndex = findProfileTitleIndex(lines);
  const headerIndexes = findProfileHeaderIndexes(lines);

  if (headerIndexes.length > 0) {
    const firstHeaderIndex = headerIndexes[0];
    if (firstHeaderIndex === undefined) return renderProfileLines(lines);
    const canonicalIndex =
      titleIndex >= 0
        ? headerIndexes.find((index) => index > titleIndex) ?? firstHeaderIndex
        : firstHeaderIndex;
    const preserveBomAtFileStart = headerIndexes.some((index) =>
      lines[index].content.startsWith(UTF8_BOM),
    );
    const bomPrefix =
      canonicalIndex === 0 && lines[canonicalIndex].content.startsWith(UTF8_BOM)
        ? UTF8_BOM
        : "";
    lines[canonicalIndex].content = `${bomPrefix}${header}`;
    for (let index = headerIndexes.length - 1; index >= 0; index -= 1) {
      const headerIndex = headerIndexes[index];
      if (headerIndex === undefined || headerIndex === canonicalIndex) continue;
      lines.splice(headerIndex, 1);
    }
    if (preserveBomAtFileStart && !lines[0].content.startsWith(UTF8_BOM)) {
      lines[0].content = `${UTF8_BOM}${lines[0].content}`;
    }
    return renderProfileLines(lines);
  }

  if (titleIndex < 0) return prependHeader(lines, header);

  insertHeaderAfter(lines, titleIndex, header);
  return renderProfileLines(lines);
}
