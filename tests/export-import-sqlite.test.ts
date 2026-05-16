import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFixtureMemoryDir } from "./transfer-fixtures.js";
import { exportSqlite } from "../src/transfer/export-sqlite.js";
import { importSqlite } from "../src/transfer/import-sqlite.js";
import { openBetterSqlite3 } from "../src/runtime/better-sqlite.js";
import { SQLITE_SCHEMA_VERSION, SQLITE_TABLES_SQL } from "../src/transfer/sqlite-schema.js";

async function assertPathMissing(filePath: string): Promise<void> {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}

function writeSqliteExport(
  sqliteFile: string,
  rows: Array<{ path: string; content: string }>,
): void {
  const db = openBetterSqlite3(sqliteFile);
  try {
    db.exec(SQLITE_TABLES_SQL);
    db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run(
      "schemaVersion",
      String(SQLITE_SCHEMA_VERSION),
    );
    const insert = db.prepare(
      "INSERT INTO files(path_rel,bytes,sha256,content) VALUES (?,?,?,?)",
    );
    for (const row of rows) {
      insert.run(
        row.path,
        Buffer.byteLength(row.content),
        "test",
        row.content,
      );
    }
  } finally {
    db.close();
  }
}

test("v2.3 sqlite export/import round-trips basic files", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-sqlite-"));
  const sqliteFile = path.join(outDir, "export.sqlite");

  await exportSqlite({ memoryDir: memDir, outFile: sqliteFile, pluginVersion: "2.2.3" });

  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const res = await importSqlite({ targetMemoryDir: targetDir, fromFile: sqliteFile, conflict: "skip" });
  assert.ok(res.written > 0);

  const importedProfile = await readFile(path.join(targetDir, "profile.md"), "utf-8");
  assert.match(importedProfile, /Profile/);
});

test("sqlite import rejects records that escape the target directory", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-sqlite-"));
  const sqliteFile = path.join(outDir, "export.sqlite");
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-outside-"));
  const outsidePath = path.join(outsideDir, "outside.md");

  writeSqliteExport(sqliteFile, [
    {
      path: `../${path.basename(outsideDir)}/outside.md`,
      content: "escaped",
    },
  ]);

  await assert.rejects(
    importSqlite({ targetMemoryDir: targetDir, fromFile: sqliteFile }),
    /unsafe segments|escapes target root/i,
  );
  await assertPathMissing(outsidePath);
});
