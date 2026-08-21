import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { EngramAccessService } from "./access-service.js";
import { externalWikiSearchOperation } from "./external-wiki-access.js";
import type { ExternalWikiRoot } from "./external-wiki.js";

async function fixtureRoot(): Promise<ExternalWikiRoot> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-external-wiki-access-"));
  await mkdir(path.join(rootDir, "wiki"), { recursive: true });
  await writeFile(
    path.join(rootDir, "INDEX.md"),
    "- [[wiki/planning|Planning Systems]] - deterministic planner fan-out\n",
    "utf8"
  );
  await writeFile(
    path.join(rootDir, "wiki", "planning.md"),
    "# Planning Systems\n\nDeterministic planner fan-out keeps cited evidence.\n",
    "utf8"
  );
  return {
    id: "planning",
    rootDir,
    enabled: true,
    pagesDir: "wiki",
    indexFile: "INDEX.md",
    indexInQmd: false,
    includeInDefaultRecall: false,
  };
}

test("external wiki operation searches roots from the service config", async () => {
  const root = await fixtureRoot();
  try {
    const service = { configRef: { externalWikis: [root] } } as EngramAccessService;
    const output = await externalWikiSearchOperation.run(
      { query: "deterministic planner", limit: 2, maxCharsPerHit: 200 },
      { service }
    );
    assert.equal(output.result.hits[0]?.wikiId, "planning");
    assert.equal(output.result.hits[0]?.path, "wiki/planning.md");
  } finally {
    await rm(root.rootDir, { recursive: true, force: true });
  }
});

test("external wiki operation rejects empty query and unknown fields", async () => {
  let configRead = false;
  const service = {
    get configRef() {
      configRead = true;
      return { externalWikis: [] };
    },
  } as unknown as EngramAccessService;

  await assert.rejects(externalWikiSearchOperation.run({ query: "  " }, { service }), /query is required/i);
  await assert.rejects(
    externalWikiSearchOperation.run({ query: "topic", unexpected: true }, { service }),
    /unrecognized key/i
  );
  assert.equal(configRead, false);
});
