export function normalizeProjectionPreview(content: string, maxChars = 180): string {
  return content.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export function normalizeProjectionTags(tags: string[] | undefined): string[] {
  return [...new Set(
    (tags ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  )].sort();
}
