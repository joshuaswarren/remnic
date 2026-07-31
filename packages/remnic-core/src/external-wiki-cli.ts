import { type ExternalWikiRoot, searchExternalWikis } from "./external-wiki-search.js";

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
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    io.stdout.write(USAGE);
    return 0;
  }
  if (args[0] !== "search") {
    io.stderr.write(`external-wiki: unknown command '${args[0]}'\n${USAGE}`);
    return 2;
  }

  let limit: number | undefined;
  let wikiId: string | undefined;
  let maxCharsPerHit: number | undefined;
  let json = false;
  const queryParts: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--limit" || argument === "--wiki-id" || argument === "--max-chars-per-hit") {
      const value = args[index + 1];
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
    io.stderr.write(`external-wiki: query is required\n${USAGE}`);
    return 2;
  }

  const result = await searchExternalWikis(roots, { query, limit, wikiId, maxCharsPerHit });
  if (json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  io.stdout.write(`External wiki results for "${result.query}" (${result.count})\n`);
  for (const hit of result.hits) {
    const citation = hit.citations[0];
    const location = citation ? `${citation.path}:${citation.lineStart}-${citation.lineEnd}` : hit.path;
    io.stdout.write(`${hit.rank}. [${hit.wikiId}] ${hit.title} (${location})\n`);
    io.stdout.write(`   ${hit.snippet.replace(/\s+/g, " ").trim()}\n`);
  }
  if (result.degradedWikiIds.length > 0) {
    io.stderr.write(`external-wiki: degraded roots: ${result.degradedWikiIds.join(", ")}\n`);
  }
  return 0;
}
