import path from "node:path";
import { mkdir, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { exportMarkdownBundle } from "./export-md.js";
import { encryptCapsuleFile } from "./capsule-crypto.js";
import { computeTransferOutputRel, isTransferPathExcluded } from "./exclusions.js";

export interface BackupOptions {
  memoryDir: string;
  outDir: string;
  includeTranscripts?: boolean;
  retentionDays?: number;
  pluginVersion: string;
  /**
   * When `true`, produce an encrypted backup archive instead of a plaintext
   * directory. The secure-store keyring for `memoryDir` must be unlocked.
   *
   * An encrypted backup is a single `.backup.tar.gz.enc` file instead of a
   * timestamped directory. It contains a gzip-compressed JSON bundle (same
   * shape as the json export) sealed with AES-256-GCM.
   *
   * Default: `false`.
   */
  encrypt?: boolean;
}

function timestampDirName(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export async function backupMemoryDir(opts: BackupOptions): Promise<string> {
  const outDirAbs = path.resolve(opts.outDir);
  await mkdir(outDirAbs, { recursive: true });
  const ts = timestampDirName(new Date());

  if (opts.encrypt === true) {
    // Encrypted backup: produce a single <timestamp>.backup.json.gz.enc file.
    // We collect the memory directory records manually, gzip them, write a
    // temp plaintext archive, encrypt it, then remove the plaintext.
    // Per gotcha #54: write the encrypted file before removing the plaintext
    // so a crash mid-encrypt cannot destroy the only readable copy.
    const { listFilesRecursive, toPosixRelPath } = await import("./fs-utils.js");
    const { readFile } = await import("node:fs/promises");

    const memoryDirAbs = path.resolve(opts.memoryDir);
    const outputRelPosix = computeTransferOutputRel(memoryDirAbs, outDirAbs);
    const filesAbs = await listFilesRecursive(memoryDirAbs);
    const includeTranscripts = opts.includeTranscripts === true;

    const records: Array<{ path: string; content: string }> = [];
    for (const abs of filesAbs) {
      const relPosix = toPosixRelPath(abs, memoryDirAbs);
      if (isTransferPathExcluded(relPosix, { includeTranscripts, outputRelPosix })) continue;
      const content = await readFile(abs, "utf-8");
      records.push({ path: relPosix, content });
    }
    records.sort((a, b) => a.path.localeCompare(b.path));

    const bundle = {
      format: "remnic.backup.v1",
      createdAt: new Date().toISOString(),
      pluginVersion: opts.pluginVersion,
      records,
    };

    const tempGzPath = path.join(outDirAbs, `${ts}.backup.json.gz`);
    const gz = gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8"));
    await writeFile(tempGzPath, gz);

    // Encrypt and remove plaintext.
    let encPath: string;
    try {
      ({ encPath } = await encryptCapsuleFile({
        sourceGzPath: tempGzPath,
        memoryDir: opts.memoryDir,
      }));
      await unlink(tempGzPath);
    } catch (error) {
      try {
        await unlink(tempGzPath);
      } catch {
        // Best-effort cleanup: do not leave a plaintext backup after failed encryption.
      }
      throw error;
    }

    if (opts.retentionDays && opts.retentionDays > 0) {
      await enforceRetention(outDirAbs, opts.retentionDays);
    }

    return encPath;
  }

  const backupDir = path.join(outDirAbs, ts);

  await exportMarkdownBundle({
    memoryDir: opts.memoryDir,
    outDir: backupDir,
    includeTranscripts: opts.includeTranscripts,
    pluginVersion: opts.pluginVersion,
  });

  if (opts.retentionDays && opts.retentionDays > 0) {
    await enforceRetention(outDirAbs, opts.retentionDays);
  }

  return backupDir;
}

async function enforceRetention(outDirAbs: string, retentionDays: number): Promise<void> {
  const entries = await readdir(outDirAbs, { withFileTypes: true });
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  for (const ent of entries) {
    const name = ent.name;

    // --- Plaintext backup directories ---
    // Directory names are ISO8601 with [: .] replaced by "-" to be filesystem-friendly.
    // Example: 2026-02-11T05-06-07-123Z => 2026-02-11T05:06:07.123Z
    if (ent.isDirectory()) {
      const m = name.match(
        /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
      );
      const iso = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
      const tsMs = iso ? Date.parse(iso) : NaN;
      if (!Number.isFinite(tsMs)) continue;
      if (tsMs < cutoffMs) {
        await rm(path.join(outDirAbs, name), { recursive: true, force: true });
      }
      continue;
    }

    // --- Encrypted backup files (.backup.json.gz.enc) ---
    // Same timestamp pattern in the filename prefix. (Codex P2 / Cursor — the
    // original sweep skipped non-directory entries, leaving encrypted backups
    // to accumulate indefinitely when retention is enabled.)
    if (ent.isFile() && name.endsWith(".backup.json.gz.enc")) {
      const m = name.match(
        /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/,
      );
      const iso = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
      const tsMs = iso ? Date.parse(iso) : NaN;
      if (!Number.isFinite(tsMs)) continue;
      if (tsMs < cutoffMs) {
        await rm(path.join(outDirAbs, name), { force: true });
      }
    }
  }
}
