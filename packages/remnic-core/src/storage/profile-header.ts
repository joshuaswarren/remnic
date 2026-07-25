const LAST_UPDATED_PREFIX = "*Last updated:";
const PROFILE_TITLE = /^#\s+/;
const MARKDOWN_HEADING = /^#{1,6}\s+/;
const MARKDOWN_LIST_ITEM = /^(?:[-+*]|\d+[.)])\s+/;
const UTF8_BOM = "\uFEFF";

type FenceMarker = {
  character: string;
  length: number;
  trailing: string;
};

function isLastUpdatedHeader(line: string): boolean {
  const content = (line.startsWith(UTF8_BOM) ? line.slice(1) : line).trimEnd();
  return content.startsWith(LAST_UPDATED_PREFIX) && content.endsWith("*");
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
  for (const tag of tags) {
    const nextCharacter = line[tag.length + 1];
    if (
      line.startsWith(`<${tag}`) &&
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
    character === "-" ||
    character === ":"
  );
}

function findCompleteHtmlTag(line: string): HtmlTag | null {
  let index = 1;
  const isClosing = line[index] === "/";
  if (isClosing) index += 1;
  const nameStart = index;
  if (!isAsciiLetter(line[index] ?? "")) return null;
  while (isHtmlTagNameCharacter(line[index] ?? "")) index += 1;
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
      return {
        name,
        isClosing,
        isSelfClosing: !isClosing && tagBody.endsWith("/"),
      };
    }
  }
  return null;
}
function isRawHtmlBlockTerminator(line: string): boolean {
  const tag = findCompleteHtmlTag(line.trim());
  return tag?.isClosing === true && RAW_HTML_BLOCK_TAGS.some((name) => name === tag.name);
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

function findHtmlBlockStart(normalizedLine: string, trimmedLine: string): HtmlBlock | null {
  const rawTag = findHtmlBlockTag(normalizedLine, RAW_HTML_BLOCK_TAGS);
  if (rawTag) {
    const completeTag = findCompleteHtmlTag(trimmedLine);
    if (completeTag?.isSelfClosing) {
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
  if (normalizedLine.startsWith("<![cdata[")) {
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
    const completeTag = findCompleteHtmlTag(trimmedLine);
    if (completeTag?.isSelfClosing) {
      return { endMarker: null, endsAtBlankLine: true, tagName: null, depth: 0 };
    }
    return { endMarker: `</${blockTag}>`, endsAtBlankLine: true, tagName: blockTag, depth: 1 };
  }
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
  const markerIndex = line.indexOf(endMarker);
  if (markerIndex < 0) return false;
  const trailingContent = line.slice(markerIndex + endMarker.length).trim();
  return (
    trailingContent === "" ||
    (trailingContent.startsWith("<") && findHtmlTags(trailingContent).length > 0)
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
      if (
        openHtmlBlock.endMarker &&
        hasHtmlBlockEndMarker(normalizedLine, openHtmlBlock.endMarker)
      ) {
        openHtmlBlock = null;
      }
      continue;
    }
    if (isIndentedCodeLine(parserLine)) continue;
    if (fence) {
      openFence = fence;
      continue;
    }
    const htmlBlock = findHtmlBlockStart(normalizedLine, trimmedLine);
    if (htmlBlock) {
      openHtmlBlock = htmlBlock.tagName
        ? updateHtmlBlockDepth(htmlBlock, normalizedLine, true)
        : htmlBlock.endMarker && hasHtmlBlockEndMarker(normalizedLine, htmlBlock.endMarker)
          ? null
          : htmlBlock;
      continue;
    }
    visit(line, index);
  }
}

function findProfileTitleIndex(lines: ProfileLine[]): number {
  let titleIndex = -1;
  visitProfileMetadataLines(lines, (line, index) => {
    if (titleIndex >= 0) return;
    const titleLine = index === 0 && line.startsWith(UTF8_BOM) ? line.slice(1) : line;
    if (PROFILE_TITLE.test(titleLine)) titleIndex = index;
  });
  return titleIndex;
}

function isMetadataBoundary(line: string): boolean {
  return (
    line === "" ||
    MARKDOWN_HEADING.test(line) ||
    MARKDOWN_LIST_ITEM.test(line) ||
    isLastUpdatedHeader(line) ||
    getFenceMarker(line) !== null ||
    isRawHtmlBlockTerminator(line)
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
  const startsBlock =
    index === 0 || index === frontmatterEnd + 1 || previousMetadataBoundary;
  const endsBlock = index === lines.length - 1 || nextMetadataBoundary;
  return startsBlock && endsBlock;
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
