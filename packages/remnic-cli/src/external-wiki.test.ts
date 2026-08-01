import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "./run-cli.js";

test("external-wiki search loads configured roots and returns cited JSON", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-external-wiki-"));
  const rootDir = path.join(baseDir, "compiled-wiki");
  const memoryDir = path.join(baseDir, "memory");
  const configPath = path.join(baseDir, "remnic.config.json");
  await mkdir(path.join(rootDir, "wiki"), { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await writeFile(
    path.join(rootDir, "INDEX.md"),
    "- [[wiki/planning|Planning Systems]] - planner fan-out with citations\n",
    "utf8"
  );
  await writeFile(
    path.join(rootDir, "wiki", "planning.md"),
    "# Planning Systems\n\nPlanner fan-out uses cited evidence.\n",
    "utf8"
  );
  await writeFile(
    configPath,
    JSON.stringify({
      memoryDir,
      externalWikis: [{ id: "ops", rootDir, enabled: true }],
    }),
    "utf8"
  );

  try {
    const result = await runCli(["external-wiki", "search", "planner", "fan-out", "--wiki-id", "ops", "--json"], {
      env: { REMNIC_CONFIG_PATH: configPath },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    const parsed: unknown = JSON.parse(result.stdout);
    assert.ok(parsed && typeof parsed === "object" && "hits" in parsed);
    assert.ok(Array.isArray(parsed.hits));
    assert.equal(parsed.hits[0]?.path, "wiki/planning.md");
    assert.deepEqual(parsed.hits[0]?.citations, [
      {
        path: "wiki/planning.md",
        lineStart: 1,
        lineEnd: 4,
        note: "Planning Systems",
      },
    ]);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
