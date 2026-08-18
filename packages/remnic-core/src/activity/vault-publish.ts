/**
 * Managed-region vault publisher (issue #1985 first slice).
 *
 * Replaces only the bytes between `<!-- remnic:<name>:start -->` and
 * `<!-- remnic:<name>:end -->`. Missing markers leave the file unchanged.
 * `activity.timeline.vault.enabled` stays default-false until a later parse
 * slice; this module does not read config.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expandTildePath } from "../utils/path.js";

export type ApplyManagedRegionResult =
  | { ok: true; text: string }
  | { ok: false; reason: "no_marker"; text: string };

export type PublishVaultRegionResult =
  | { ok: true; status: "updated" | "unchanged" }
  | { ok: false; reason: "no_marker" | "missing_file" | "not_directory" };

export function applyManagedRegion(
  fileText: string,
  opts: { strategy: "markers"; name: string; content: string },
): ApplyManagedRegionResult {
  const startMarker = `<!-- remnic:${opts.name}:start -->`;
  const endMarker = `<!-- remnic:${opts.name}:end -->`;
  const startIdx = fileText.indexOf(startMarker);
  if (startIdx === -1) return { ok: false, reason: "no_marker", text: fileText };
  const endIdx = fileText.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) return { ok: false, reason: "no_marker", text: fileText };

  const eol = fileText.includes("\r\n") ? "\r\n" : "\n";
  let body = opts.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (eol === "\r\n") body = body.replace(/\n/g, "\r\n");
  if (body.endsWith(eol)) body = body.slice(0, -eol.length);

  return {
    ok: true,
    text: `${fileText.slice(0, startIdx + startMarker.length)}${eol}${body}${eol}${fileText.slice(endIdx)}`,
  };
}

export function publishVaultRegion(input: {
  vaultPath: string;
  relativeFile: string;
  name: string;
  content: string;
}): PublishVaultRegionResult {
  const vault = expandTildePath(input.vaultPath);
  try {
    if (!statSync(vault).isDirectory()) return { ok: false, reason: "not_directory" };
  } catch {
    return { ok: false, reason: "not_directory" };
  }

  if (input.relativeFile.length === 0 || path.isAbsolute(input.relativeFile)) {
    return { ok: false, reason: "missing_file" };
  }
  const root = path.resolve(vault);
  const dest = path.resolve(root, input.relativeFile);
  const rel = path.relative(root, dest);
  if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: "missing_file" };
  }

  let existing: string;
  try {
    if (!statSync(dest).isFile()) return { ok: false, reason: "missing_file" };
    existing = readFileSync(dest, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: "missing_file" };
    throw err;
  }

  const applied = applyManagedRegion(existing, {
    strategy: "markers",
    name: input.name,
    content: input.content,
  });
  if (!applied.ok) return { ok: false, reason: applied.reason };

  const prevHash = createHash("sha256").update(existing, "utf8").digest("hex");
  const nextHash = createHash("sha256").update(applied.text, "utf8").digest("hex");
  if (prevHash === nextHash) return { ok: true, status: "unchanged" };

  const tmpPath = path.join(path.dirname(dest), `.remnic-vault-${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmpPath, applied.text);
  try {
    renameSync(tmpPath, dest);
  } catch (renameErr) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // temp cleanup is best-effort
    }
    throw renameErr;
  }
  return { ok: true, status: "updated" };
}
