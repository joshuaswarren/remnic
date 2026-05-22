import path from "node:path";
import { SQLITE_SCHEMA_VERSION, SQLITE_TABLES_SQL } from "./sqlite-schema.js";
import { listFilesRecursive, readUtf8FileStrict, toPosixRelPath } from "./fs-utils.js";
import { openBetterSqlite3 } from "../runtime/better-sqlite.js";
import { computeTransferOutputRel, isTransferPathExcluded } from "./exclusions.js";

export interface ExportSqliteOptions {
  memoryDir: string;
  outFile: string;
  includeTranscripts?: boolean;
  pluginVersion: string;
}

export async function exportSqlite(opts: ExportSqliteOptions): Promise<void> {
  const includeTranscripts = opts.includeTranscripts === true;
  const memDirAbs = path.resolve(opts.memoryDir);
  const outAbs = path.resolve(opts.outFile);
  const outputRelPosix = computeTransferOutputRel(memDirAbs, outAbs);

  const filesAbs = await listFilesRecursive(memDirAbs);
  const rows: Array<{ rel: string; bytes: number; sha256: string; content: string }> = [];
  for (const abs of filesAbs) {
    const relPosix = toPosixRelPath(abs, memDirAbs);
    if (isTransferPathExcluded(relPosix, { includeTranscripts, outputRelPosix })) continue;
    const { content, sha256, bytes } = await readUtf8FileStrict(abs);
    rows.push({ rel: relPosix, bytes, sha256, content });
  }

  const db = openBetterSqlite3(outAbs);
  try {
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec(SQLITE_TABLES_SQL);

    const insertMeta = db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)");
    const insertFile = db.prepare(
      "INSERT OR REPLACE INTO files(path_rel, bytes, sha256, content) VALUES (?,?,?,?)",
    );

    const tx = db.transaction((rows: Array<{ rel: string; bytes: number; sha256: string; content: string }>) => {
      db.prepare("DELETE FROM meta").run();
      db.prepare("DELETE FROM files").run();
      insertMeta.run("schemaVersion", String(SQLITE_SCHEMA_VERSION));
      insertMeta.run("createdAt", new Date().toISOString());
      insertMeta.run("pluginVersion", opts.pluginVersion);
      insertMeta.run("includesTranscripts", includeTranscripts ? "true" : "false");
      for (const r of rows) insertFile.run(r.rel, r.bytes, r.sha256, r.content);
    });

    tx(rows);
  } finally {
    db.close();
  }
}
