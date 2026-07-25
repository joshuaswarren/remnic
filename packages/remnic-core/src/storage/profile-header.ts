const LAST_UPDATED_PREFIX = "*Last updated: ";
const PROFILE_TITLE = /^#\s+/;

function isCanonicalLastUpdatedHeader(line: string): boolean {
  if (!line.startsWith(LAST_UPDATED_PREFIX) || !line.endsWith("*")) return false;
  const timestamp = line.slice(LAST_UPDATED_PREFIX.length, -1);
  if (!timestamp) return false;
  const time = Date.parse(timestamp);
  return Number.isFinite(time) && new Date(time).toISOString() === timestamp;
}

function findProfileMetadataHeaderIndexes(lines: string[], start: number): number[] {
  const indexes: number[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === "") continue;
    if (!isCanonicalLastUpdatedHeader(line)) break;
    indexes.push(index);
  }
  return indexes;
}

export function renderProfileWithLastUpdated(content: string, updatedAt: string): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const header = `*Last updated: ${updatedAt}*`;
  const titleIndex = lines.findIndex((line) => PROFILE_TITLE.test(line));
  const metadataStart = titleIndex < 0 ? 0 : titleIndex + 1;
  const headerIndexes = findProfileMetadataHeaderIndexes(lines, metadataStart);

  if (headerIndexes.length > 0) {
    lines[headerIndexes[0]!] = header;
    for (let index = headerIndexes.length - 1; index > 0; index -= 1) {
      lines.splice(headerIndexes[index]!, 1);
    }
    return lines.join(lineEnding);
  }

  if (titleIndex < 0) return [header, "", ...lines].join(lineEnding);

  const insertAt = titleIndex + 1;
  if (lines[insertAt] === "") {
    lines.splice(insertAt + 1, 0, header, "");
  } else {
    lines.splice(insertAt, 0, "", header, "");
  }
  return lines.join(lineEnding);
}
