const LAST_UPDATED_HEADER = /^\s*(?:\*{1,2})?Last updated:\s*.*?(?:\*{1,2})?\s*$/i;
const PROFILE_TITLE = /^#\s+/;

export function renderProfileWithLastUpdated(content: string, updatedAt: string): string {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const header = `*Last updated: ${updatedAt}*`;
  let headerWritten = false;
  const normalized = lines.flatMap((line) => {
    if (!LAST_UPDATED_HEADER.test(line)) return [line];
    if (headerWritten) return [];
    headerWritten = true;
    return [header];
  });

  if (headerWritten) return normalized.join(lineEnding);

  const titleIndex = normalized.findIndex((line) => PROFILE_TITLE.test(line));
  if (titleIndex < 0) return [header, "", ...normalized].join(lineEnding);

  const insertAt = titleIndex + 1;
  if (normalized[insertAt] === "") {
    normalized.splice(insertAt + 1, 0, header, "");
  } else {
    normalized.splice(insertAt, 0, "", header, "");
  }
  return normalized.join(lineEnding);
}
