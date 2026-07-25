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
  return { character, length, trailing: trimmed.slice(length) };
}

function isClosingFence(fence: FenceMarker, openFence: FenceMarker): boolean {
  return (
    fence.character === openFence.character &&
    fence.length >= openFence.length &&
    fence.trailing.trim() === ""
  );
}

function findFrontmatterEnd(lines: string[]): number {
  const firstLine = lines[0]?.startsWith(UTF8_BOM) ? lines[0].slice(1) : lines[0];
  if (firstLine !== "---") return -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trimEnd();
    if (line === "---" || line === "...") return index;
  }
  return -1;
}

function visitOutsideFencedBlocks(
  lines: string[],
  visit: (line: string, index: number) => void,
): void {
  const frontmatterEnd = findFrontmatterEnd(lines);
  let openFence: FenceMarker | null = null;
  let openHtmlPre = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (index <= frontmatterEnd || isIndentedCodeLine(line)) continue;
    const normalizedLine = line.trimStart().toLowerCase();
    const closesHtmlPre = normalizedLine.includes("</pre>");
    if (openHtmlPre) {
      if (closesHtmlPre) openHtmlPre = false;
      continue;
    }
    const startsHtmlPre =
      normalizedLine.startsWith("<pre") &&
      (normalizedLine[4] === ">" || normalizedLine[4] === " " || normalizedLine[4] === "\t");
    if (startsHtmlPre) {
      openHtmlPre = !closesHtmlPre;
      continue;
    }
    const fence = getFenceMarker(line);
    if (openFence) {
      if (fence && isClosingFence(fence, openFence)) openFence = null;
      continue;
    }
    if (fence) {
      openFence = fence;
      continue;
    }
    visit(line, index);
  }
}

function findProfileTitleIndex(lines: string[]): number {
  let titleIndex = -1;
  visitOutsideFencedBlocks(lines, (line, index) => {
    if (titleIndex >= 0) return;
    const titleLine = index === 0 && line.startsWith(UTF8_BOM) ? line.slice(1) : line;
    if (PROFILE_TITLE.test(titleLine)) titleIndex = index;
  });
  return titleIndex;
}

function findProfileHeaderIndexes(lines: string[]): number[] {
  const indexes: number[] = [];
  visitOutsideFencedBlocks(lines, (line, index) => {
    if (isLastUpdatedHeader(line)) indexes.push(index);
  });
  return indexes;
}

function insertHeaderAfter(lines: string[], index: number, header: string): void {
  const insertAt = index + 1;
  if (lines[insertAt]?.trim() === "") {
    lines.splice(insertAt + 1, 0, header, "");
  } else {
    lines.splice(insertAt, 0, "", header, "");
  }
}

function prependHeader(lines: string[], header: string, lineEnding: string): string {
  const frontmatterEnd = findFrontmatterEnd(lines);
  if (frontmatterEnd >= 0) {
    insertHeaderAfter(lines, frontmatterEnd, header);
    return lines.join(lineEnding);
  }
  if (lines[0]?.startsWith(UTF8_BOM)) {
    lines[0] = lines[0].slice(1);
    return [`${UTF8_BOM}${header}`, "", ...lines].join(lineEnding);
  }
  return [header, "", ...lines].join(lineEnding);
}

export function renderProfileWithLastUpdated(content: string, updatedAt: string): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const header = `*Last updated: ${updatedAt}*`;
  const titleIndex = findProfileTitleIndex(lines);
  const headerIndexes = findProfileHeaderIndexes(lines);

  if (headerIndexes.length > 0) {
    lines[headerIndexes[0]!] = header;
    for (let index = headerIndexes.length - 1; index > 0; index -= 1) {
      lines.splice(headerIndexes[index]!, 1);
    }
    return lines.join(lineEnding);
  }

  if (titleIndex < 0) return prependHeader(lines, header, lineEnding);

  insertHeaderAfter(lines, titleIndex, header);
  return lines.join(lineEnding);
}
