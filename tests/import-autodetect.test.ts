import test from "node:test";
import { skipUnlessBetterSqlite3 } from "./helpers/native-binding.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectImportFormat } from "../src/transfer/autodetect.js";
import { exportJsonBundle } from "../src/transfer/export-json.js";
import { exportSqlite } from "../src/transfer/export-sqlite.js";
import { exportMarkdownBundle } from "../src/transfer/export-md.js";
import { writeFixtureMemoryDir } from "./transfer-fixtures.js";

test("detectImportFormat detects json bundle dir", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);
  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-export-"));
  await exportJsonBundle({ memoryDir: memDir, outDir, pluginVersion: "2.2.3" });
  assert.equal(await detectImportFormat(outDir), "json");
});

test("detectImportFormat detects md bundle dir", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);
  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  await exportMarkdownBundle({ memoryDir: memDir, outDir, pluginVersion: "2.2.3" });
  assert.equal(await detectImportFormat(outDir), "md");
});

test("detectImportFormat detects sqlite file", { skip: skipUnlessBetterSqlite3() }, async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);
  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-sqlite-"));
  const sqliteFile = path.join(outDir, "export.sqlite");
  await exportSqlite({ memoryDir: memDir, outFile: sqliteFile, pluginVersion: "2.2.3" });
  assert.equal(await detectImportFormat(sqliteFile), "sqlite");
});

test("md bundle can be imported by copying into target dir", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);
  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-md-"));
  await exportMarkdownBundle({ memoryDir: memDir, outDir, pluginVersion: "2.2.3" });

  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const { importMarkdownBundle } = await import("../src/transfer/import-md.js");
  const res = await importMarkdownBundle({ targetMemoryDir: targetDir, fromDir: outDir, conflict: "skip" });
  assert.ok(res.written > 0);
});
