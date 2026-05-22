import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFixtureMemoryDir, writeSensitiveTransferFixtureEntries } from "./transfer-fixtures.js";
import { exportSqlite } from "../src/transfer/export-sqlite.js";
import { importSqlite } from "../src/transfer/import-sqlite.js";
import { openBetterSqlite3 } from "../src/runtime/better-sqlite.js";
import { sha256String } from "../src/transfer/fs-utils.js";
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
      const hash = sha256String(row.content);
      insert.run(
        row.path,
        hash.bytes,
        hash.sha256,
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

test("sqlite re-export to an existing archive removes stale rows", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFile(path.join(memDir, "a.md"), "alpha\n", "utf-8");
  await writeFile(path.join(memDir, "b.md"), "bravo\n", "utf-8");

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-sqlite-"));
  const sqliteFile = path.join(outDir, "export.sqlite");

  await exportSqlite({ memoryDir: memDir, outFile: sqliteFile, pluginVersion: "2.2.3" });
  await rm(path.join(memDir, "b.md"));
  await exportSqlite({ memoryDir: memDir, outFile: sqliteFile, pluginVersion: "2.2.3" });

  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const res = await importSqlite({ targetMemoryDir: targetDir, fromFile: sqliteFile });
  assert.equal(res.written, 1);
  assert.equal(await readFile(path.join(targetDir, "a.md"), "utf-8"), "alpha\n");
  await assertPathMissing(path.join(targetDir, "b.md"));
});

test("sqlite export rejects non-UTF8 files instead of emitting unverifiable v1 checksums", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await mkdir(path.join(memDir, "binary-lifecycle"), { recursive: true });
  await writeFile(path.join(memDir, "binary-lifecycle", "payload.bin"), Buffer.from([0xff, 0xfe, 0xfd]));

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-sqlite-"));
  const sqliteFile = path.join(outDir, "export.sqlite");
  await assert.rejects(
    exportSqlite({ memoryDir: memDir, outFile: sqliteFile, pluginVersion: "2.2.3" }),
    /requires UTF-8 text files/,
  );
});

test("sqlite import rejects tampered content before writing files", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-sqlite-"));
  const sqliteFile = path.join(outDir, "export.sqlite");
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const targetPath = path.join(targetDir, "profile.md");

  writeSqliteExport(sqliteFile, [
    {
      path: "profile.md",
      content: "trusted profile\n",
    },
  ]);
  const db = openBetterSqlite3(sqliteFile);
  try {
    db.prepare("UPDATE files SET content = ? WHERE path_rel = ?").run(
      "tampered profile\n",
      "profile.md",
    );
  } finally {
    db.close();
  }

  await assert.rejects(
    importSqlite({ targetMemoryDir: targetDir, fromFile: sqliteFile }),
    /checksum mismatch|byte count mismatch/,
  );
  await assertPathMissing(targetPath);
});

test("sqlite export excludes secure store, capsules, VCS, and dependencies", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);
  await writeSensitiveTransferFixtureEntries(memDir);

  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-sqlite-"));
  const sqliteFile = path.join(outDir, "export.sqlite");
  await exportSqlite({ memoryDir: memDir, outFile: sqliteFile, pluginVersion: "2.2.3" });

  const db = openBetterSqlite3(sqliteFile);
  try {
    const paths = db.prepare("SELECT path_rel FROM files ORDER BY path_rel").all() as Array<{ path_rel: string }>;
    assert.equal(paths.some((row) => row.path_rel.startsWith(".secure-store/")), false);
    assert.equal(paths.some((row) => row.path_rel.startsWith(".capsules/")), false);
    assert.equal(paths.some((row) => row.path_rel.startsWith(".git/")), false);
    assert.equal(paths.some((row) => row.path_rel.startsWith("node_modules/")), false);
    assert.ok(paths.some((row) => row.path_rel === "facts/2026-02-11/fact-1.md"));
  } finally {
    db.close();
  }
});

test("sqlite export excludes stale output sidecars inside memory dir", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFile(path.join(memDir, "profile.md"), "Profile\n", "utf-8");
  const sqliteFile = path.join(memDir, "snapshot.sqlite");
  await writeFile(`${sqliteFile}-wal`, Buffer.from([0xff, 0xfe, 0xfd]));
  await writeFile(`${sqliteFile}-shm`, Buffer.from([0xff, 0xfe, 0xfd]));

  await exportSqlite({ memoryDir: memDir, outFile: sqliteFile, pluginVersion: "2.2.3" });

  const db = openBetterSqlite3(sqliteFile);
  try {
    const paths = db.prepare("SELECT path_rel FROM files ORDER BY path_rel").all() as Array<{ path_rel: string }>;
    assert.deepEqual(
      paths.map((row) => row.path_rel),
      ["profile.md"],
    );
  } finally {
    db.close();
  }
});

test("sqlite export rejects output file equal to memory directory", async () => {
  const memDir = await mkdtemp(path.join(os.tmpdir(), "engram-mem-"));
  await writeFixtureMemoryDir(memDir);

  await assert.rejects(
    exportSqlite({ memoryDir: memDir, outFile: memDir, pluginVersion: "2.2.3" }),
    /output path must not equal the memory directory/,
  );
});

test("sqlite import rejects invalid conflict policy without overwriting existing files", async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "engram-sqlite-"));
  const sqliteFile = path.join(outDir, "export.sqlite");
  const targetDir = await mkdtemp(path.join(os.tmpdir(), "engram-import-"));
  const targetPath = path.join(targetDir, "profile.md");

  writeSqliteExport(sqliteFile, [
    {
      path: "profile.md",
      content: "incoming profile\n",
    },
  ]);
  await writeFile(targetPath, "original profile\n", "utf-8");

  await assert.rejects(
    importSqlite({
      targetMemoryDir: targetDir,
      fromFile: sqliteFile,
      conflict: "replace" as any,
    }),
    /invalid conflict policy/i,
  );
  assert.equal(await readFile(targetPath, "utf-8"), "original profile\n");
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
