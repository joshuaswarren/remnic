import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promoteUnreleasedChangelog } from "../src/release-changelog.js";

async function main(): Promise<void> {
  const version = process.argv[2]?.replace(/^v/i, "");
  if (!version) {
    throw new Error("Usage: tsx scripts/promote-release-changelog.ts <version>");
  }

  const changelogPath = path.join(process.cwd(), "CHANGELOG.md");
  const raw = await readFile(changelogPath, "utf-8");
  const next = promoteUnreleasedChangelog(raw, {
    version,
    date: new Date().toISOString().slice(0, 10),
  });

  if (next !== raw) {
    await writeFile(changelogPath, next, "utf-8");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
