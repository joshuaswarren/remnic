export interface PromoteUnreleasedChangelogOptions {
  version: string;
  date: string;
}

export function promoteUnreleasedChangelog(
  changelog: string,
  options: PromoteUnreleasedChangelogOptions,
): string {
  const unreleasedMarker = "## [Unreleased]";
  const unreleasedIndex = changelog.indexOf(unreleasedMarker);
  if (unreleasedIndex === -1) {
    throw new Error("CHANGELOG.md is missing the Unreleased section");
  }

  const afterMarker = changelog.slice(unreleasedIndex + unreleasedMarker.length);
  const nextSectionMatch = afterMarker.match(/\n## \[/);
  const unreleasedEnd =
    nextSectionMatch == null
      ? changelog.length
      : unreleasedIndex + unreleasedMarker.length + (nextSectionMatch.index ?? 0);

  const before = changelog.slice(0, unreleasedIndex + unreleasedMarker.length);
  const unreleasedBody = changelog.slice(unreleasedIndex + unreleasedMarker.length, unreleasedEnd);
  const after = changelog.slice(unreleasedEnd);

  if (unreleasedBody.trim().length === 0) {
    return changelog;
  }

  const normalizedVersion = options.version.replace(/^v/i, "");
  const normalizedBody = unreleasedBody.replace(/^\n+/, "").replace(/\n+$/, "");
  const releaseSection = `\n\n## [v${normalizedVersion}] - ${options.date}\n\n${normalizedBody}\n`;
  return `${before}${releaseSection}${after}`;
}
