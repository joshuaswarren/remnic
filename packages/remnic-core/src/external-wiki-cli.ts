import {
  type ExternalWikiRoot,
  type ExternalWikiSearchResult,
  searchExternalWikis,
} from "./external-wiki-search.js";

interface ExternalWikiCliIo {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
}

const USAGE =
  "Usage: remnic external-wiki search <query...> [--wiki-id <id>] [--limit <1-20>] [--max-chars-per-hit <100-8000>] [--json]\n";

export async function runExternalWikiCliCommand(
  roots: readonly ExternalWikiRoot[],
  args: readonly string[],
  io: ExternalWikiCliIo
): Promise<number> {
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    io.stdout.write(USAGE);
    return 0;
  }
  const searchArgs = args[0] === "search" ? args.slice(1) : args;

  let limit: number | undefined;
  let wikiId: string | undefined;
  let maxCharsPerHit: number | undefined;
  let json = false;
  const queryParts: string[] = [];
  for (let index = 0; index < searchArgs.length; index += 1) {
    const argument = searchArgs[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--limit" || argument === "--wiki-id" || argument === "--max-chars-per-hit") {
      const value = searchArgs[index + 1];
      if (value === undefined || value.startsWith("--")) {
        io.stderr.write(`external-wiki: ${argument} requires a value\n`);
        return 2;
      }
      index += 1;
      if (argument === "--wiki-id") {
        wikiId = value.trim();
        if (wikiId.length === 0) {
          io.stderr.write("external-wiki: --wiki-id must not be empty\n");
          return 2;
        }
        continue;
      }
      const parsed = Number(value);
      const maximum = argument === "--limit" ? 20 : 8_000;
      const minimum = argument === "--limit" ? 1 : 100;
      if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        io.stderr.write(`external-wiki: ${argument} must be an integer from ${minimum} to ${maximum}\n`);
        return 2;
      }
      if (argument === "--limit") limit = parsed;
      else maxCharsPerHit = parsed;
      continue;
    }
    if (argument.startsWith("-")) {
      io.stderr.write(`external-wiki: unknown option '${argument}'\n${USAGE}`);
      return 2;
    }
    queryParts.push(argument);
  }

  const query = queryParts.join(" ").trim();
  if (query.length === 0) {
    io.stderr.write("external-wiki: provide a search query\n");
    return 1;
  }
  const enabled = roots.filter((root) => root.enabled !== false);
  if (enabled.length === 0) {
    io.stderr.write("external-wiki: no enabled wiki roots configured\n");
    return 1;
  }

  let result: ExternalWikiSearchResult;
  try {
    result = await searchExternalWikis(enabled, { query, limit, wikiId, maxCharsPerHit });
  } catch (error) {
    io.stderr.write(`external-wiki: ${error instanceof Error ? error.message : "search failed"}\n`);
    return 1;
  }
  if (json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (result.hits.length === 0) {
    io.stdout.write("No results.\n");
    return 0;
  }
  for (const hit of result.hits) {
    io.stdout.write(`[${hit.wikiId}] ${hit.path} (score ${hit.score})\n${hit.snippet}\n\n`);
  }
  if (result.degradedWikiIds.length > 0) {
    io.stderr.write(`Warning: degraded roots: ${result.degradedWikiIds.join(", ")}\n`);
  }
  return 0;
}
