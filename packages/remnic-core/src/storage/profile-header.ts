const LAST_UPDATED_PREFIX = "*Last updated:";
const PROFILE_TITLE = /^#\s+/;
const UTF8_BOM = "\uFEFF";

type FenceMarker = {
  character: string;
  length: number;
  trailing: string;
};

function isLastUpdatedHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith(LAST_UPDATED_PREFIX) && trimmed.endsWith("*");
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

function findHtmlBlockStart(normalizedLine: string, trimmedLine: string): HtmlBlock | null {
  const rawTag = findHtmlBlockTag(normalizedLine, RAW_HTML_BLOCK_TAGS);
  if (rawTag) return { endMarker: `</${rawTag}>`, endsAtBlankLine: false };
  if (normalizedLine.startsWith("<!--")) return { endMarker: "-->", endsAtBlankLine: false };
  if (normalizedLine.startsWith("<?")) return { endMarker: "?>", endsAtBlankLine: false };
  if (normalizedLine.startsWith("<![cdata[")) return { endMarker: "]]>", endsAtBlankLine: false };
  const declarationFirst = trimmedLine[2];
  if (trimmedLine.startsWith("<!") && declarationFirst && declarationFirst >= "A" && declarationFirst <= "Z") {
    return { endMarker: null, endsAtBlankLine: true };
  }
  const blockTag = findHtmlBlockTag(normalizedLine, HTML_BLOCK_TAGS);
  return blockTag ? { endMarker: `</${blockTag}>`, endsAtBlankLine: true } : null;
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

function visitProfileMetadataLines(
  lines: ProfileLine[],
  visit: (line: string, index: number) => void,
): void {
  const frontmatterEnd = findFrontmatterEnd(lines);
  let openFence: FenceMarker | null = null;
  let openHtmlBlock: HtmlBlock | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.content ?? "";
    if (index <= frontmatterEnd) continue;
    const fence = getFenceMarker(line);
    if (openFence) {
      if (fence && isClosingFence(fence, openFence)) openFence = null;
      continue;
    }
    const trimmedLine = line.trimStart();
    const normalizedLine = trimmedLine.toLowerCase();
    if (openHtmlBlock) {
      if (
        (openHtmlBlock.endMarker && normalizedLine.includes(openHtmlBlock.endMarker)) ||
        (openHtmlBlock.endsAtBlankLine && normalizedLine === "")
      ) {
        openHtmlBlock = null;
      }
      continue;
    }
    if (isIndentedCodeLine(line)) continue;
    if (fence) {
      openFence = fence;
      continue;
    }
    const htmlBlock = findHtmlBlockStart(normalizedLine, trimmedLine);
    if (htmlBlock) {
      openHtmlBlock =
        htmlBlock.endMarker && normalizedLine.includes(htmlBlock.endMarker) ? null : htmlBlock;
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

function findProfileHeaderIndexes(lines: ProfileLine[]): number[] {
  const indexes: number[] = [];
  visitProfileMetadataLines(lines, (line, index) => {
    if (isLastUpdatedHeader(line)) indexes.push(index);
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
    lines[headerIndexes[0]!].content = header;
    for (let index = headerIndexes.length - 1; index > 0; index -= 1) {
      lines.splice(headerIndexes[index]!, 1);
    }
    return renderProfileLines(lines);
  }

  if (titleIndex < 0) return prependHeader(lines, header);

  insertHeaderAfter(lines, titleIndex, header);
  return renderProfileLines(lines);
}
