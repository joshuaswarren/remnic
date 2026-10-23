import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { exportJsonBundle } from "@remnic/core/transfer/export-json";
import { exportSqlite } from "@remnic/core/transfer/export-sqlite";
import { importJsonBundle } from "@remnic/core/transfer/import-json";
import { importSqlite } from "@remnic/core/transfer/import-sqlite";
import type { ConflictPolicy } from "../packages/remnic-core/src/transfer/conflict-policy.js";

async function createFixture(t: TestContext, format: "json" | "sqlite") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-import-conflicts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source");
  const target = path.join(dir, "target");
  const archive = path.join(dir, "archive");
  await mkdir(source);
  await mkdir(target);
  await writeFile(path.join(source, "profile.md"), "incoming profile\n");
  await writeFile(path.join(source, "new.md"), "new memory\n");
  await writeFile(path.join(target, "profile.md"), "original profile\n");
  const sqliteFile = path.join(archive, "export.sqlite");
  if (format === "sqlite") {
    await exportSqlite({ memoryDir: source, outFile: sqliteFile, pluginVersion: "test" });
  } else {
    await exportJsonBundle({ memoryDir: source, outDir: archive, pluginVersion: "test" });
  }
  return {
    target,
    importBundle: (conflict: ConflictPolicy, dryRun = false) =>
      format === "sqlite"
        ? importSqlite({ targetMemoryDir: target, fromFile: sqliteFile, conflict, dryRun })
        : importJsonBundle({ targetMemoryDir: target, fromDir: archive, conflict, dryRun }),
  };
}

for (const format of ["json", "sqlite"] as const) {
  test(`${format} skip preserves existing content while importing new files`, async (t) => {
    const fixture = await createFixture(t, format);
    assert.deepEqual(await fixture.importBundle("skip"), { written: 1, skipped: 1 });
    assert.equal(await readFile(path.join(fixture.target, "profile.md"), "utf8"), "original profile\n");
    assert.equal(await readFile(path.join(fixture.target, "new.md"), "utf8"), "new memory\n");
  });

  test(`${format} overwrite replaces conflicts with archive content`, async (t) => {
    const fixture = await createFixture(t, format);
    assert.deepEqual(await fixture.importBundle("overwrite"), { written: 2, skipped: 0 });
    assert.equal(await readFile(path.join(fixture.target, "profile.md"), "utf8"), "incoming profile\n");
    assert.equal(await readFile(path.join(fixture.target, "new.md"), "utf8"), "new memory\n");
  });

  test(`${format} dedupe preserves whitespace-equivalent content byte for byte`, async (t) => {
    const fixture = await createFixture(t, format);
    const original = " \n incoming\t\tprofile  \n";
    await writeFile(path.join(fixture.target, "profile.md"), original);
    assert.deepEqual(await fixture.importBundle("dedupe"), { written: 1, skipped: 1 });
    assert.equal(await readFile(path.join(fixture.target, "profile.md"), "utf8"), original);
    assert.equal(await readFile(path.join(fixture.target, "new.md"), "utf8"), "new memory\n");
  });

  test(`${format} dedupe replaces genuinely different content`, async (t) => {
    const fixture = await createFixture(t, format);
    assert.deepEqual(await fixture.importBundle("dedupe"), { written: 2, skipped: 0 });
    assert.equal(await readFile(path.join(fixture.target, "profile.md"), "utf8"), "incoming profile\n");
  });

  test(`${format} dry-run reports skipped conflicts without changing target files`, async (t) => {
    const fixture = await createFixture(t, format);
    assert.deepEqual(await fixture.importBundle("skip", true), { written: 0, skipped: 1 });
    assert.equal(await readFile(path.join(fixture.target, "profile.md"), "utf8"), "original profile\n");
    await assert.rejects(readFile(path.join(fixture.target, "new.md")), { code: "ENOENT" });
  });
}
