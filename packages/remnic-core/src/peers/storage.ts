/**
 * Peer registry storage primitives — issue #679 PR 1/5.
 *
 * Pure file-I/O helpers for the per-peer kernel files:
 *
 *   peers/{peer-id}/identity.md       — slow, human-edited identity facts
 *   peers/{peer-id}/profile.md        — evolving profile (reasoner-owned)
 *   peers/{peer-id}/interactions.log.md — append-only signal log
 *
 * No reasoner logic, no recall integration, no migration of existing
 * identity-anchor data — those land in PR 2/5 — 5/5.
 *
 * Path safety: `peerId` is validated against PEER_ID_PATTERN before any
 * filesystem operation. Reading a non-existent peer returns null (does not
 * throw). Reading malformed files throws — callers can catch and recover.
 */

import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";

async function openNoFollow(file: string, flags: number): Promise<import("node:fs/promises").FileHandle> {
  return fs.open(file, flags | fsConstants.O_NOFOLLOW);
}

async function readFileNoFollow(file: string): Promise<string> {
  await assertParentDirInodeStable(file);
  const fh = await openNoFollow(file, fsConstants.O_RDONLY);
  try {
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
}

async function assertParentDirInodeStable(filePath: string): Promise<void> {
  const parent = path.dirname(filePath);
  const dh = await fs.open(
    parent,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const fstatInfo = await dh.stat();
    const lstatInfo = await fs.lstat(parent);
    if (fstatInfo.ino !== lstatInfo.ino || fstatInfo.dev !== lstatInfo.dev) {
      throw new Error(
        `parent directory "${parent}" was swapped between checks (inode mismatch)`,
      );
    }
    if (lstatInfo.isSymbolicLink()) {
      throw new Error(`parent directory "${parent}" is a symlink and is rejected`);
    }
  } finally {
    await dh.close();
  }
}

async function writeFileNoFollow(file: string, data: string): Promise<void> {
  await assertParentDirInodeStable(file);
  const fh = await openNoFollow(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
  );
  try {
    await fh.writeFile(data, "utf8");
  } finally {
    await fh.close();
  }
}

/**
 * Create a file only when absent, refusing symlinks and non-regular existing
 * targets. Returns false only for an existing regular file.
 */
async function writeFileNoFollowIfAbsent(file: string, data: string): Promise<boolean> {
  await assertParentDirInodeStable(file);
  let fh: import("node:fs/promises").FileHandle;
  try {
    fh = await openNoFollow(
      file,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    const existing = await fs.lstat(file);
    if (existing.isSymbolicLink()) {
      throw new Error(`refusing to create "${file}": target is a symlink`);
    }
    if (!existing.isFile()) {
      throw new Error(`refusing to create "${file}": target is not a regular file`);
    }
    return false;
  }
  try {
    await fh.writeFile(data, "utf8");
  } finally {
    await fh.close();
  }
  return true;
}

export async function appendFileNoFollow(file: string, data: string): Promise<void> {
  await assertParentDirInodeStable(file);
  const fh = await openNoFollow(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND,
  );
  try {
    await fh.writeFile(data, "utf8");
  } finally {
    await fh.close();
  }
}

import {
  PEER_ID_MAX_LENGTH,
  PEER_ID_PATTERN,
  type Peer,
  type PeerInteractionLogEntry,
  type PeerKind,
  type PeerProfile,
  type PeerProfileFieldProvenance,
} from "./types.js";


const ALLOWED_KINDS: ReadonlySet<PeerKind> = new Set<PeerKind>([
  "self",
  "human",
  "agent",
  "integration",
]);

/**
 * Validate a peer id. Throws `Error` with a descriptive message on failure.
 * Exported so callers can pre-check user input before constructing a Peer.
 */
export function assertValidPeerId(peerId: unknown): asserts peerId is string {
  if (typeof peerId !== "string") {
    throw new Error("peerId must be a string");
  }
  if (peerId.length === 0) {
    throw new Error("peerId must not be empty");
  }
  if (peerId.length > PEER_ID_MAX_LENGTH) {
    throw new Error(`peerId must be ≤ ${PEER_ID_MAX_LENGTH} characters`);
  }
  if (!PEER_ID_PATTERN.test(peerId)) {
    throw new Error(
      `peerId "${peerId}" is invalid — must match ${PEER_ID_PATTERN}`,
    );
  }
  if (/[.\-_]{2,}/.test(peerId)) {
    throw new Error(
      `peerId "${peerId}" is invalid — must not contain consecutive separators`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertValidKind(kind: unknown): asserts kind is PeerKind {
  if (typeof kind !== "string" || !ALLOWED_KINDS.has(kind as PeerKind)) {
    throw new Error(
      `peer kind must be one of ${Array.from(ALLOWED_KINDS).join(", ")}`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────

/** Root directory holding the peer registry, relative to memoryDir. */
export const PEERS_DIR_NAME = "peers";

function peersRoot(memoryDir: string): string {
  return path.join(memoryDir, PEERS_DIR_NAME);
}

function peerDir(memoryDir: string, peerId: string): string {
  assertValidPeerId(peerId);
  const candidate = path.join(peersRoot(memoryDir), peerId);
  const root = peersRoot(memoryDir);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`peerId "${peerId}" resolves outside peers root`);
  }
  return candidate;
}

async function assertPeersRootNotSymlink(memoryDir: string): Promise<void> {
  const root = peersRoot(memoryDir);
  let rootStat: import("node:fs").Stats | null = null;
  try {
    rootStat = await fs.lstat(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (rootStat && rootStat.isSymbolicLink()) {
    throw new Error(`peers root "${root}" is a symlink and is rejected`);
  }
}

export async function mkdirPeerDirAtomic(memoryDir: string, peerId: string): Promise<void> {
  const root = peersRoot(memoryDir);
  await fs.mkdir(memoryDir, { recursive: true });
  try {
    await fs.mkdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const rootLstat = await fs.lstat(root);
  if (rootLstat.isSymbolicLink()) {
    throw new Error(`peers root "${root}" is a symlink and is rejected`);
  }
  if (!rootLstat.isDirectory()) {
    throw new Error(`peers root "${root}" exists but is not a directory`);
  }
  const rootHandle = await fs.open(
    root,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const candidate = peerDir(memoryDir, peerId);
    await fs.mkdir(candidate, { recursive: true });
    const fstatRoot = await rootHandle.stat();
    const lstatRoot = await fs.lstat(root);
    if (fstatRoot.ino !== lstatRoot.ino || fstatRoot.dev !== lstatRoot.dev) {
      throw new Error(`peers root "${root}" was swapped during mkdir`);
    }
    const peerLstat = await fs.lstat(candidate);
    if (peerLstat.isSymbolicLink()) {
      throw new Error(`peer directory "${peerId}" is a symlink and is rejected`);
    }
  } finally {
    await rootHandle.close();
  }
}

export async function assertPeerDirNotEscaped(memoryDir: string, peerId: string): Promise<void> {
  const candidate = peerDir(memoryDir, peerId);
  const root = peersRoot(memoryDir);
  await assertPeersRootNotSymlink(memoryDir);
  let candidateStat: import("node:fs").Stats | null = null;
  try {
    candidateStat = await fs.lstat(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (candidateStat && candidateStat.isSymbolicLink()) {
    throw new Error(`peer directory "${peerId}" is a symlink and is rejected`);
  }
  if (candidateStat) {
    const realRoot = await fs.realpath(root);
    const realCandidate = await fs.realpath(candidate);
    const rel = path.relative(realRoot, realCandidate);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`peer directory "${peerId}" escapes the peers root`);
    }
  }
}

function identityPath(memoryDir: string, peerId: string): string {
  return path.join(peerDir(memoryDir, peerId), "identity.md");
}

function profilePath(memoryDir: string, peerId: string): string {
  return path.join(peerDir(memoryDir, peerId), "profile.md");
}

export function interactionsPath(memoryDir: string, peerId: string): string {
  return path.join(peerDir(memoryDir, peerId), "interactions.log.md");
}

// ──────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────
//
//
//   ---
//   ---
//

function escapeYamlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

function unescapeYamlString(quoted: string): string {
  // Caller has already verified `quoted` starts and ends with a double quote.
  const body = quoted.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) {
      const next = body[i + 1];
      if (next === "\\" || next === '"') {
        out += next;
        i++;
        continue;
      }
      if (next === "n") {
        out += "\n";
        i++;
        continue;
      }
      if (next === "r") {
        out += "\r";
        i++;
        continue;
      }
      if (next === "t") {
        out += "\t";
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

interface ParsedFrontmatter {
  fields: Record<string, string>;
  body: string;
}

function parsePeerFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) {
    throw new Error("peer file is missing YAML frontmatter delimiter");
  }
  const after = text.slice(3);
  const close = after.indexOf("\n---");
  if (close === -1) {
    throw new Error("peer file frontmatter is not terminated");
  }
  const fmBlock = after.slice(0, close).replace(/^\n/, "");
  const body = after.slice(close + 4).replace(/^\n/, "");
  const fields: Record<string, string> = {};
  for (const lineRaw of fmBlock.split("\n")) {
    const line = lineRaw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`peer frontmatter line is malformed: ${line}`);
    }
    const key = line.slice(0, colon).trim();
    const valueRaw = line.slice(colon + 1).trim();
    if (key === "") {
      throw new Error(`peer frontmatter has empty key: ${line}`);
    }
    let value: string;
    if (valueRaw.startsWith('"') && valueRaw.endsWith('"') && valueRaw.length >= 2) {
      value = unescapeYamlString(valueRaw);
    } else {
      value = valueRaw;
    }
    fields[key] = value;
  }
  return { fields, body };
}

function emitPeerIdentity(peer: Peer): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${escapeYamlString(peer.id)}`);
  lines.push(`kind: ${peer.kind}`);
  lines.push(`displayName: ${escapeYamlString(peer.displayName)}`);
  lines.push(`createdAt: ${escapeYamlString(peer.createdAt)}`);
  lines.push(`updatedAt: ${escapeYamlString(peer.updatedAt)}`);
  lines.push("---");
  lines.push("");
  lines.push(peer.notes ?? "");
  let out = lines.join("\n");
  while (out.endsWith("\n")) out = out.slice(0, -1);
  return out + "\n";
}

function assertWritablePeer(peer: Peer): void {
  assertValidPeerId(peer.id);
  assertValidKind(peer.kind);
  if (typeof peer.displayName !== "string") {
    throw new Error("peer.displayName must be a string");
  }
  if (typeof peer.createdAt !== "string" || peer.createdAt === "") {
    throw new Error("peer.createdAt must be a non-empty ISO-8601 string");
  }
  if (typeof peer.updatedAt !== "string" || peer.updatedAt === "") {
    throw new Error("peer.updatedAt must be a non-empty ISO-8601 string");
  }
  if (peer.notes !== undefined && typeof peer.notes !== "string") {
    throw new Error("peer.notes must be a string when provided");
  }
}

// ──────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────

/**
 * Read a peer's identity kernel.
 *
 * Returns `null` (does not throw) when the peer directory or identity
 * file does not exist. Throws on filesystem errors other than ENOENT and
 * on malformed files.
 */
export async function readPeer(
  memoryDir: string,
  peerId: string,
): Promise<Peer | null> {
  assertValidPeerId(peerId);
  await assertPeerDirNotEscaped(memoryDir, peerId);
  const file = identityPath(memoryDir, peerId);
  let raw: string;
  try {
    raw = await readFileNoFollow(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const { fields, body } = parsePeerFrontmatter(raw);
  const id = fields.id ?? peerId;
  if (id !== peerId) {
    throw new Error(
      `peer identity file mismatch — expected id "${peerId}", file claims "${id}"`,
    );
  }
  const kind = fields.kind;
  assertValidKind(kind);
  const displayName = fields.displayName ?? "";
  const createdAt = fields.createdAt ?? "";
  if (createdAt === "") {
    throw new Error(`peer "${peerId}" is missing createdAt`);
  }
  const rawUpdatedAt = fields.updatedAt;
  const updatedAt =
    typeof rawUpdatedAt === "string" && rawUpdatedAt.length > 0
      ? rawUpdatedAt
      : createdAt;
  let trimmedBody = body;
  if (trimmedBody.startsWith("\r\n")) trimmedBody = trimmedBody.slice(2);
  else if (trimmedBody.startsWith("\n")) trimmedBody = trimmedBody.slice(1);
  if (trimmedBody.endsWith("\r\n")) trimmedBody = trimmedBody.slice(0, -2);
  else if (trimmedBody.endsWith("\n")) trimmedBody = trimmedBody.slice(0, -1);
  return {
    id: peerId,
    kind,
    displayName,
    createdAt,
    updatedAt,
    notes: trimmedBody === "" ? undefined : trimmedBody,
  };
}

/**
 * Write (create or overwrite) a peer's identity kernel.
 *
 * Creates `peers/{id}/` if it does not exist. Does not touch the peer's
 * profile or interaction log. Atomic-write semantics are deferred to
 * later PRs — for the schema slice we simply write the file.
 */
export async function writePeer(memoryDir: string, peer: Peer): Promise<void> {
  assertWritablePeer(peer);
  await mkdirPeerDirAtomic(memoryDir, peer.id);
  await assertPeerDirNotEscaped(memoryDir, peer.id);
  const file = identityPath(memoryDir, peer.id);
  await writeFileNoFollow(file, emitPeerIdentity(peer));
}

/**
 * Create a peer identity only if it is absent, applying the same root,
 * peer-directory, parent-inode, and O_NOFOLLOW guards as writePeer.
 *
 * Returns true when this call created the identity file and false when a
 * regular identity file already existed. Symlinked roots, peer directories,
 * identity paths, and non-regular identity paths are rejected.
 */
export async function writePeerIfAbsent(
  memoryDir: string,
  peer: Peer,
): Promise<boolean> {
  assertWritablePeer(peer);
  await mkdirPeerDirAtomic(memoryDir, peer.id);
  await assertPeerDirNotEscaped(memoryDir, peer.id);
  const file = identityPath(memoryDir, peer.id);
  return await writeFileNoFollowIfAbsent(file, emitPeerIdentity(peer));
}

/**
 * Delete a peer's `identity.md` if present, applying the same symlink
 * and path-escape protections as the read/write paths.
 *
 * Returns `true` if a regular file was unlinked, `false` if no
 * `identity.md` existed at the time of the call. The peer directory
 * itself is left in place so any companion files (`profile.md`,
 * `interactions/`, etc.) are untouched. Idempotent: missing target
 * returns `false` rather than throwing.
 *
 * Cursor M (PR #756 review): a manual `path.join` + raw `fs.unlink`
 * bypasses `assertPeerDirNotEscaped`, the peers-root symlink check,
 * and the parent-inode-stable / lstat guards used by every other
 * peer I/O entrypoint. A symlinked `peers/<id>/` could redirect the
 * unlink to an arbitrary `identity.md` outside `memoryDir`. This
 * function consolidates the safe-delete contract so callers cannot
 * skip the guards.
 */
export async function deletePeer(memoryDir: string, peerId: string): Promise<boolean> {
  assertValidPeerId(peerId);
  await assertPeerDirNotEscaped(memoryDir, peerId);
  const file = identityPath(memoryDir, peerId);
  let lstatBefore: import("node:fs").Stats;
  try {
    lstatBefore = await fs.lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
  if (lstatBefore.isSymbolicLink()) {
    throw new Error(`refusing to unlink "${file}": target is a symlink`);
  }
  if (!lstatBefore.isFile()) {
    throw new Error(`refusing to unlink "${file}": target is not a regular file`);
  }
  await assertParentDirInodeStable(file);
  try {
    await fs.unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
  return true;
}

/**
 * Destructively purge the entire peer directory for a given peerId —
 * `identity.md`, `profile.md`, `interactions.log.md`, and any other
 * files written by future extensions.
 *
 * This is the DESTRUCTIVE counterpart to `deletePeer` (which only
 * removes `identity.md`). Callers must pass `confirm: "yes"` to prevent
 * accidental data loss — the function throws `Error("forgetPeer requires
 * confirm: 'yes'")` when the flag is absent or wrong.
 *
 * Idempotent: if the peer directory does not exist the function returns
 * `{ purged: false }` rather than throwing. Safe to run twice.
 *
 * Security contract (mirrors `deletePeer`):
 *   - `peerId` is validated against `PEER_ID_PATTERN`.
 *   - The peers root is checked for symlink swap (assertPeersRootNotSymlink).
 *   - `assertPeerDirNotEscaped` performs realpath containment: symlinked
 *     peer directories are rejected and the resolved path is confirmed to
 *     stay inside peersRoot (same guard used by every other I/O entry-point).
 *   - A secondary `lstat` + `isSymbolicLink()` check is kept as defence-in-
 *     depth before the `fs.rm` call itself.
 *   - `fs.rm` with `{ recursive: true, force: true }` is used for the
 *     actual removal so partially-populated directories are handled
 *     atomically by the OS rather than file-by-file in userland.
 *
 * Returns:
 *   `{ purged: true }`  — directory existed and was removed.
 *   `{ purged: false }` — directory did not exist (no-op).
 */
export async function forgetPeer(
  memoryDir: string,
  peerId: string,
  opts: { confirm: string },
): Promise<{ purged: boolean }> {
  if (opts.confirm !== "yes") {
    throw new Error("forgetPeer requires confirm: 'yes'");
  }
  assertValidPeerId(peerId);
  await assertPeersRootNotSymlink(memoryDir);
  await assertPeerDirNotEscaped(memoryDir, peerId);

  const dir = peerDir(memoryDir, peerId);

  let dirStat: import("node:fs").Stats;
  try {
    dirStat = await fs.lstat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { purged: false };
    }
    throw err;
  }
  if (dirStat.isSymbolicLink()) {
    throw new Error(
      `refusing to purge peer directory "${peerId}": target is a symlink`,
    );
  }
  if (!dirStat.isDirectory()) {
    throw new Error(
      `refusing to purge peer directory "${peerId}": target is not a directory`,
    );
  }

  await fs.rm(dir, { recursive: true, force: true });
  return { purged: true };
}

/**
 * Enumerate all peers under `memoryDir/peers/`.
 *
 * Returns an empty array if the peers root does not exist. Subdirectories
 * whose name fails `PEER_ID_PATTERN` are skipped (defensive: the user
 * may have hand-edited the directory). Directories that exist but lack
 * `identity.md` are also skipped.
 */
export async function listPeers(memoryDir: string): Promise<Peer[]> {
  const root = peersRoot(memoryDir);
  let entries: string[];
  let dh: import("node:fs/promises").FileHandle | null = null;
  try {
    dh = await fs.open(
      root,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const fstatBefore = await dh.stat();
    entries = await fs.readdir(root);
    const lstatAfter = await fs.lstat(root);
    if (
      fstatBefore.ino !== lstatAfter.ino ||
      fstatBefore.dev !== lstatAfter.dev ||
      lstatAfter.isSymbolicLink()
    ) {
      throw new Error(`peers root "${root}" was swapped during readdir`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  } finally {
    if (dh) await dh.close();
  }
  const peers: Peer[] = [];
  entries.sort();
  for (const name of entries) {
    if (!PEER_ID_PATTERN.test(name) || name.length > PEER_ID_MAX_LENGTH) {
      continue;
    }
    let stat;
    try {
      stat = await fs.lstat(path.join(root, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    let peer: Peer | null = null;
    try {
      peer = await readPeer(memoryDir, name);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const message = err instanceof Error ? err.message : String(err);
      const isSecurityFailure =
        message.startsWith("peers root") ||
        message.startsWith("peer directory") ||
        message.startsWith("parent directory") ||
        message.startsWith("path ") /* "path \"...\" is a symlink" */ ||
        message.includes("escapes the peers root") ||
        message.includes("inode mismatch") ||
        message.includes("is a symlink and is rejected") ||
        message.includes("was swapped");
      if (isSecurityFailure) throw err;
      if (code && code !== "ENOENT") throw err;
      continue;
    }
    if (peer !== null) {
      peers.push(peer);
    }
  }
  return peers;
}

// ──────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────

function parseIsoTimestampMs(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// ──────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────

interface ProfileFile {
  updatedAt: string;
  fields: Record<string, string>;
  provenance: Record<string, PeerProfileFieldProvenance[]>;
}

function emitPeerProfile(profile: PeerProfile): string {
  const payload: ProfileFile = {
    updatedAt: profile.updatedAt,
    fields: { ...profile.fields },
    provenance: Object.fromEntries(
      Object.entries(profile.provenance).map(([k, v]) => [k, [...v]]),
    ),
  };
  const json = JSON.stringify(payload, null, 2);
  return [
    "---",
    `peerId: ${escapeYamlString(profile.peerId)}`,
    `updatedAt: ${escapeYamlString(profile.updatedAt)}`,
    "---",
    "",
    "<!-- peer profile — managed by the async reasoner. Manual edits will be overwritten. -->",
    "",
    "```json",
    json,
    "```",
    "",
  ].join("\n");
}

function parsePeerProfile(raw: string, peerId: string): PeerProfile {
  const { fields: fm, body } = parsePeerFrontmatter(raw);
  if (fm.peerId !== undefined && fm.peerId !== peerId) {
    throw new Error(
      `peer profile mismatch — expected "${peerId}", file claims "${fm.peerId}"`,
    );
  }
  const fenceMatch = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!fenceMatch) {
    throw new Error(`peer profile for "${peerId}" is missing JSON payload`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceMatch[1]);
  } catch (err) {
    throw new Error(
      `peer profile for "${peerId}" has invalid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`peer profile for "${peerId}" is not an object`);
  }
  const payload = parsed as Partial<ProfileFile>;
  const payloadUpdatedAt = typeof payload.updatedAt === "string" ? payload.updatedAt : undefined;
  const updatedAt = payloadUpdatedAt ?? fm.updatedAt ?? "";
  if (typeof updatedAt !== "string" || updatedAt === "") {
    throw new Error(`peer profile for "${peerId}" is missing updatedAt`);
  }
  let fieldsObj: object;
  if (payload.fields === undefined) {
    fieldsObj = {};
  } else if (
    typeof payload.fields === "object" &&
    payload.fields !== null &&
    !Array.isArray(payload.fields)
  ) {
    fieldsObj = payload.fields;
  } else {
    throw new Error(`peer profile for "${peerId}" has malformed fields section`);
  }
  let provenanceObj: object;
  if (payload.provenance === undefined) {
    provenanceObj = {};
  } else if (
    typeof payload.provenance === "object" &&
    payload.provenance !== null &&
    !Array.isArray(payload.provenance)
  ) {
    provenanceObj = payload.provenance;
  } else {
    throw new Error(`peer profile for "${peerId}" has malformed provenance section`);
  }
  const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(fieldsObj)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    if (typeof v === "string") fields[k] = v;
  }
  const provenance: Record<string, PeerProfileFieldProvenance[]> = {};
  for (const [k, v] of Object.entries(provenanceObj)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    if (!Array.isArray(v)) continue;
    const list: PeerProfileFieldProvenance[] = [];
    for (const item of v) {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item)
      ) {
        continue;
      }
      const r = item as unknown as Record<string, unknown>;
      if (typeof r.observedAt !== "string" || r.observedAt === "") continue;
      if (typeof r.signal !== "string" || r.signal === "") continue;
      const clean: PeerProfileFieldProvenance = {
        observedAt: r.observedAt,
        signal: r.signal,
        ...(typeof r.sourceSessionId === "string" && r.sourceSessionId.length > 0
          ? { sourceSessionId: r.sourceSessionId }
          : {}),
        ...(typeof r.note === "string" && r.note.length > 0
          ? { note: r.note }
          : {}),
      };
      list.push(clean);
    }
    provenance[k] = list;
  }
  return { peerId, updatedAt, fields, provenance };
}

/**
 * Read a peer's profile. Returns null if the profile file does not exist.
 *
 * The PR-1 surface only ships the structured read/write so the reasoner
 * (PR 2/5) and recall integration (PR 3/5) have a stable target. We do
 * not yet expose any field-update helpers.
 */
export async function readPeerProfile(
  memoryDir: string,
  peerId: string,
): Promise<PeerProfile | null> {
  assertValidPeerId(peerId);
  await assertPeerDirNotEscaped(memoryDir, peerId);
  const file = profilePath(memoryDir, peerId);
  let raw: string;
  try {
    raw = await readFileNoFollow(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  return parsePeerProfile(raw, peerId);
}

export async function writePeerProfile(
  memoryDir: string,
  profile: PeerProfile,
): Promise<void> {
  assertValidPeerId(profile.peerId);
  if (typeof profile.updatedAt !== "string" || profile.updatedAt === "") {
    throw new Error("profile.updatedAt must be a non-empty ISO-8601 string");
  }
  if (!isPlainObject(profile.fields)) {
    throw new Error("profile.fields must be a plain object");
  }
  const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
  for (const [key, value] of Object.entries(profile.fields)) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(`profile.fields key "${key}" is reserved and cannot be persisted`);
    }
    if (typeof value !== "string") {
      throw new Error(`profile.fields["${key}"] must be a string`);
    }
  }
  if (!isPlainObject(profile.provenance)) {
    throw new Error("profile.provenance must be a plain object");
  }
  for (const [key, list] of Object.entries(profile.provenance)) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(`profile.provenance key "${key}" is reserved and cannot be persisted`);
    }
    if (!Array.isArray(list)) {
      throw new Error(`profile.provenance["${key}"] must be an array`);
    }
    for (let i = 0; i < list.length; i++) {
      const item = list[i] as unknown;
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`profile.provenance["${key}"][${i}] must be an object`);
      }
      const r = item as Record<string, unknown>;
      if (typeof r.observedAt !== "string" || r.observedAt === "") {
        throw new Error(`profile.provenance["${key}"][${i}].observedAt must be a non-empty string`);
      }
      if (typeof r.signal !== "string" || r.signal === "") {
        throw new Error(`profile.provenance["${key}"][${i}].signal must be a non-empty string`);
      }
      if (r.sourceSessionId !== undefined) {
        if (typeof r.sourceSessionId !== "string" || r.sourceSessionId === "") {
          throw new Error(`profile.provenance["${key}"][${i}].sourceSessionId must be a non-empty string when provided`);
        }
      }
      if (r.note !== undefined) {
        if (typeof r.note !== "string" || r.note === "") {
          throw new Error(`profile.provenance["${key}"][${i}].note must be a non-empty string when provided`);
        }
      }
    }
  }
  await mkdirPeerDirAtomic(memoryDir, profile.peerId);
  await assertPeerDirNotEscaped(memoryDir, profile.peerId);
  const file = profilePath(memoryDir, profile.peerId);
  await writeFileNoFollow(file, emitPeerProfile(profile));
}

/**
 * Read the raw interaction log for a peer.
 *
 * Returns the empty string if the log does not yet exist. Callers parse
 * the log themselves — this PR does not ship structured log parsing.
 * Exposed primarily so tests can verify monotonic append semantics.
 */
export async function readInteractionLogRaw(
  memoryDir: string,
  peerId: string,
): Promise<string> {
  assertValidPeerId(peerId);
  await assertPeerDirNotEscaped(memoryDir, peerId);
  const file = interactionsPath(memoryDir, peerId);
  try {
    return await readFileNoFollow(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

function parseLogLine(line: string): PeerInteractionLogEntry | null {
  if (!line.startsWith("- [")) return null;
  const tsClose = line.indexOf("]", 3);
  if (tsClose === -1) return null;
  const timestamp = line.slice(3, tsClose).trim();
  if (timestamp === "") return null;
  if (parseIsoTimestampMs(timestamp) === null) return null;
  let cursor = tsClose + 1;
  while (cursor < line.length && line[cursor] === " ") cursor += 1;
  if (line[cursor] !== "(") return null;
  const kindOpen = cursor;
  const kindClose = line.indexOf(")", kindOpen + 1);
  if (kindClose === -1) return null;
  const kind = line.slice(kindOpen + 1, kindClose).trim();
  if (kind === "") return null;
  cursor = kindClose + 1;
  let sessionId: string | undefined;
  while (cursor < line.length && line[cursor] === " ") cursor += 1;
  if (line.startsWith("[session=", cursor)) {
    const close = line.indexOf("]", cursor + "[session=".length);
    if (close > -1) {
      const sid = line.slice(cursor + "[session=".length, close).trim();
      if (sid.length > 0) sessionId = sid;
      cursor = close + 1;
    }
  }
  while (cursor < line.length && line[cursor] === " ") cursor += 1;
  const summary = line.slice(cursor);
  return sessionId === undefined
    ? { timestamp, kind, summary }
    : { timestamp, kind, sessionId, summary };
}

/**
 * Read the structured interaction log for a peer.
 *
 * Returns an empty array when the log file does not exist. Each line
 * is parsed via `parseLogLine`; malformed lines are silently skipped
 * so the reasoner can still derive profile fields from a partially
 * corrupt log rather than aborting the whole pass.
 *
 * `options.limit` (when > 0) restricts the result to the most recent
 * N entries. `options.afterTimestamp` (ISO-8601) filters out entries
 * with `timestamp <= afterTimestamp`, comparing parsed instants so
 * legacy valid ISO-8601 forms like `Z` without milliseconds or
 * offset timestamps keep working. Both filters are applied in order:
 * timestamp first, then limit.
 *
 * Order: oldest → newest, matching the append-only on-disk order so
 * downstream consumers can reason about temporal evolution without
 * re-sorting.
 */
export async function readPeerInteractionLog(
  memoryDir: string,
  peerId: string,
  options: { limit?: number; afterTimestamp?: string } = {},
): Promise<PeerInteractionLogEntry[]> {
  const raw = await readInteractionLogRaw(memoryDir, peerId);
  if (raw === "") return [];
  const entries: PeerInteractionLogEntry[] = [];
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trimEnd();
    if (line === "") continue;
    const parsed = parseLogLine(line);
    if (parsed === null) continue;
    entries.push(parsed);
  }
  let filtered = entries;
  if (typeof options.afterTimestamp === "string" && options.afterTimestamp.length > 0) {
    const cutoff = options.afterTimestamp;
    const cutoffMs = parseIsoTimestampMs(cutoff);
    if (cutoffMs === null) {
      throw new Error("afterTimestamp must be an ISO-8601 timestamp");
    }
    filtered = filtered.filter((e) => {
      const entryMs = parseIsoTimestampMs(e.timestamp);
      return entryMs !== null && entryMs > cutoffMs;
    });
  }
  // Gotcha #27: guard slice(-n) against n === 0 — `slice(-0)` returns
  // the entire array. Treat 0 and negatives as "no limit applied".
  if (typeof options.limit === "number" && options.limit > 0) {
    if (filtered.length > options.limit) {
      filtered = filtered.slice(filtered.length - options.limit);
    }
  }
  return filtered;
}
