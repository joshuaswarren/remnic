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

/**
 * Atomic, symlink-rejecting open: returns a file handle whose
 * underlying open(2) call carried `O_NOFOLLOW`, so the kernel itself
 * refuses to follow a symlink at the target path. Closes the
 * check-then-use TOCTOU race that a separate `assertPathNotSymlink`
 * + `fs.writeFile` pattern leaves open (codex P1 round 5 on PR #723).
 */
async function openNoFollow(file: string, flags: number): Promise<import("node:fs/promises").FileHandle> {
  return fs.open(file, flags | fsConstants.O_NOFOLLOW);
}

/** Read a file, refusing to follow symlinks at the kernel level
 * AND verifying parent-dir inode stability (codex P1 round 9). */
async function readFileNoFollow(file: string): Promise<string> {
  await assertParentDirInodeStable(file);
  const fh = await openNoFollow(file, fsConstants.O_RDONLY);
  try {
    return await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * Codex P1 round 9: O_NOFOLLOW only protects the FINAL path
 * component, so a parent-directory swap mid-flight (peers/<id>
 * unlinked + replaced with a symlink between assertPeerDirNotEscaped
 * and the open) could still write outside memoryDir. Without
 * `openat` (Node has no stable JS binding for it), the best
 * pure-Node mitigation is to:
 *   1. Open the parent directory with O_DIRECTORY | O_NOFOLLOW so
 *      WE hold the original-inode handle.
 *   2. fstat the parent handle and compare its (dev, inode) against
 *      lstat of the parent path. If they diverge, a swap happened
 *      between mkdir and now — abort.
 *   3. Then do the symlink-rejecting open of the file.
 * This narrows the race window to the few microseconds between the
 * fstat/lstat compare and the open. Fully closing the race needs
 * `openat`, which is tracked as a follow-up.
 */
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

/** Overwrite a file, refusing to follow symlinks at the kernel level
 * AND verifying the parent directory inode is stable across the open
 * (codex P1 round 9). */
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

/** Append to a file, refusing to follow symlinks AND verifying parent
 * inode stability (codex P1 round 9). */
async function appendFileNoFollow(file: string, data: string): Promise<void> {
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

// ──────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────

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
  // Defence-in-depth: reject consecutive dots/dashes/underscores. The
  // regex already prevents leading/trailing separators, but explicit
  // adjacency checks document intent and survive future regex refactors.
  if (/[.\-_]{2,}/.test(peerId)) {
    throw new Error(
      `peerId "${peerId}" is invalid — must not contain consecutive separators`,
    );
  }
}

/**
 * Strict plain-object check. Rejects arrays, null, Maps, Sets, class
 * instances, and anything else with a non-Object/null prototype.
 * Codex P2 round 13: writePeerProfile previously treated any
 * non-null non-array object as plain; inputs like `new Map()` would
 * pass and serialize to `{}` losing all data.
 */
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
// Path helpers
// ──────────────────────────────────────────────────────────────────────

/** Root directory holding the peer registry, relative to memoryDir. */
export const PEERS_DIR_NAME = "peers";

function peersRoot(memoryDir: string): string {
  return path.join(memoryDir, PEERS_DIR_NAME);
}

function peerDir(memoryDir: string, peerId: string): string {
  // Guard against path traversal on top of regex validation. After
  // assertValidPeerId, peerId cannot contain `/`, `..`, or NUL — but we
  // re-check defensively here.
  assertValidPeerId(peerId);
  const candidate = path.join(peersRoot(memoryDir), peerId);
  const root = peersRoot(memoryDir);
  // Ensure resolved path stays within peersRoot. Note: this is a
  // lexical check only — a symlinked peer directory can still escape.
  // I/O sites must additionally call `assertPeerDirNotEscaped` (below)
  // before reading or writing, which uses lstat to reject symlinks
  // and realpath to confirm physical containment (codex P1 #723).
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`peerId "${peerId}" resolves outside peers root`);
  }
  return candidate;
}

/**
 * Reject the peers root if it is itself a symlink. Called BEFORE any
 * `fs.mkdir`, so a `peers → /tmp/outside` symlink can't get its
 * target mutated by a recursive mkdir before subsequent checks fire
 * (codex P2 + cursor M on PR #723).
 */
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

/**
 * Codex P1 round 13: atomic mkdir of the peer directory under a
 * verified peers root. Opens the peers root with O_DIRECTORY|
 * O_NOFOLLOW first (creating it if missing under the same flags) so
 * a root-symlink swap can't redirect the subsequent mkdir to its
 * target. The dir handle is held across the mkdir, then we lstat
 * the candidate and reject if it's a symlink.
 */
async function mkdirPeerDirAtomic(memoryDir: string, peerId: string): Promise<void> {
  const root = peersRoot(memoryDir);
  // Ensure the root exists as a real directory, not a symlink. Use
  // mkdir + lstat: if mkdir succeeds (or EEXIST), lstat must report
  // a directory and not a symlink.
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
  // Open the root with O_DIRECTORY|O_NOFOLLOW to anchor the inode.
  // Hold the handle across the peer-dir mkdir so a root swap
  // mid-operation is detected via fstat-vs-lstat compare afterward.
  const rootHandle = await fs.open(
    root,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const candidate = peerDir(memoryDir, peerId);
    await fs.mkdir(candidate, { recursive: true });
    // Verify root inode unchanged across the mkdir.
    const fstatRoot = await rootHandle.stat();
    const lstatRoot = await fs.lstat(root);
    if (fstatRoot.ino !== lstatRoot.ino || fstatRoot.dev !== lstatRoot.dev) {
      throw new Error(`peers root "${root}" was swapped during mkdir`);
    }
    // Reject symlinked peer dir.
    const peerLstat = await fs.lstat(candidate);
    if (peerLstat.isSymbolicLink()) {
      throw new Error(`peer directory "${peerId}" is a symlink and is rejected`);
    }
  } finally {
    await rootHandle.close();
  }
}

/**
 * Codex P1 on PR #723: `peerDir` only enforces a lexical
 * `path.relative` check, so a symlinked peer directory like
 * `peers/self → /tmp/outside` would slip through. Run this guard
 * AFTER the peer directory has been (or is known to) exist, so we
 * can lstat it and realpath-check containment. For first-time writes,
 * call `mkdirPeerDirAtomic` BEFORE this; for reads, this alone.
 */
async function assertPeerDirNotEscaped(memoryDir: string, peerId: string): Promise<void> {
  const candidate = peerDir(memoryDir, peerId);
  const root = peersRoot(memoryDir);
  // 1. The peers root must not be a symlink (defensive — writers
  // already checked this before mkdir, but reads must still verify).
  await assertPeersRootNotSymlink(memoryDir);
  // 2. lstat on the candidate itself. If it's a symlink, refuse.
  let candidateStat: import("node:fs").Stats | null = null;
  try {
    candidateStat = await fs.lstat(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (candidateStat && candidateStat.isSymbolicLink()) {
    throw new Error(`peer directory "${peerId}" is a symlink and is rejected`);
  }
  // 3. Real-path containment. Only meaningful if the candidate exists.
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

function interactionsPath(memoryDir: string, peerId: string): string {
  return path.join(peerDir(memoryDir, peerId), "interactions.log.md");
}

// ──────────────────────────────────────────────────────────────────────
// Minimal YAML helpers (peer files only)
// ──────────────────────────────────────────────────────────────────────
//
// We deliberately do not depend on the codebase's primary YAML parser
// (`storage.ts`) because the peer schema is small and structured. We emit
// a strict, predictable subset:
//
//   ---
//   id: my-peer
//   kind: agent
//   displayName: "Codex"
//   createdAt: 2026-04-25T00:00:00.000Z
//   updatedAt: 2026-04-25T00:00:00.000Z
//   ---
//   {free-form markdown notes}
//
// String values are always double-quoted with `\\` and `\"` escapes. ISO
// timestamps and the kind enum are emitted bare. This keeps round-trip
// behaviour deterministic and easy to validate.

function escapeYamlString(value: string): string {
  // Cursor Medium: must escape newlines / carriage returns / tabs so a
  // value like `displayName: "first\nsecond"` doesn't blow up the
  // line-oriented parsePeerFrontmatter. Backslash → `\\`, double-quote
  // → `\"`, newline → `\n`, carriage return → `\r`, tab → `\t`.
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
  // Frontmatter must begin with a `---` line. We tolerate a leading BOM
  // and trailing newlines but otherwise require a strict, line-oriented
  // YAML subset of `key: value` pairs.
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) {
    throw new Error("peer file is missing YAML frontmatter delimiter");
  }
  // Split on the first occurrence of `\n---` after the leading `---`.
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
  // Cursor M: emit timestamps as quoted YAML strings — bare emission
  // would let a `createdAt` value containing a newline inject extra
  // frontmatter fields when round-tripped through `parsePeerFrontmatter`.
  // (`writePeer` validates these are non-empty strings, but the type
  // doesn't constrain content.)
  lines.push(`createdAt: ${escapeYamlString(peer.createdAt)}`);
  lines.push(`updatedAt: ${escapeYamlString(peer.updatedAt)}`);
  lines.push("---");
  lines.push("");
  lines.push(peer.notes ?? "");
  // Trailing newline for POSIX friendliness.
  // CodeQL: the previous `replace(/\n+$/, "\n")` flagged as
  // polynomial-regex risk because `\n+` can backtrack on long
  // trailing-newline runs. Strip trailing newlines with a bounded
  // loop instead — O(N) over the trailing-newline count, no regex.
  let out = lines.join("\n");
  while (out.endsWith("\n")) out = out.slice(0, -1);
  return out + "\n";
}

// ──────────────────────────────────────────────────────────────────────
// Public storage API
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
  // Codex P1 #2: even with the directory validated, a symlinked
  // identity.md inside a real peer dir would let us read arbitrary
  // out-of-scope files. Reject symlinks at the file level too.
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
  // Codex P2: nullish-coalescing alone treated `updatedAt: ""` as a
  // valid empty timestamp, contradicting writePeer's non-empty
  // validation and the module's "malformed files throw" contract.
  // Treat empty string as missing and fall back to createdAt; throw
  // only when the field is malformed in some other way (caught by
  // the typeof check).
  const rawUpdatedAt = fields.updatedAt;
  const updatedAt =
    typeof rawUpdatedAt === "string" && rawUpdatedAt.length > 0
      ? rawUpdatedAt
      : createdAt;
  // Codex P2 + CodeQL: previously used `body.replace(/^\s+/, "")`
  // which stripped ALL leading whitespace — including indentation in
  // notes. The `\s+` patterns also flagged as polynomial-regex risk
  // (CodeQL alert #74) because they can backtrack on adversarial
  // inputs. Strip exactly one leading separator newline and one
  // trailing newline — internal AND user-authored leading
  // indentation are preserved verbatim, and the regex is bounded.
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
  // Codex P2 round 8: reject non-string `peer.notes`. Without this,
  // an untyped JS caller passing an object/number would silently
  // coerce to "[object Object]"/"42" via lines.push(notes ?? "")
  // and corrupt user-authored identity content. Notes are optional;
  // omit by passing undefined (NOT null).
  if (peer.notes !== undefined && typeof peer.notes !== "string") {
    throw new Error("peer.notes must be a string when provided");
  }
  // Codex P1 round 13: atomic root validation. Open the peers root
  // (or its parent if peers doesn't exist yet) with O_DIRECTORY|
  // O_NOFOLLOW BEFORE the mkdir. This holds a kernel handle on the
  // original-inode root, so a swap between the symlink check and
  // the mkdir can't redirect mkdir to a symlink-target. We then
  // mkdir, lstat the result against the held handle, and only
  // proceed if they match.
  await mkdirPeerDirAtomic(memoryDir, peer.id);
  await assertPeerDirNotEscaped(memoryDir, peer.id);
  const file = identityPath(memoryDir, peer.id);
  // Codex P1 #2: reject if identity.md exists as a symlink so we
  // don't follow it on overwrite.
  await writeFileNoFollow(file, emitPeerIdentity(peer));
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
  // Refuse to follow a symlink at `identity.md` itself: lstat first
  // and reject if the target is a symlink. Then verify the parent
  // directory inode is stable across the unlink (mirrors the
  // assertParentDirInodeStable + O_NOFOLLOW pattern used by
  // writeFileNoFollow). This narrows the TOCTOU window between the
  // lstat and the unlink to the same few microseconds the write path
  // accepts.
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
  // assertPeerDirNotEscaped performs the realpath-containment check that
  // the lexical `peerDir()` guard alone cannot provide: it lstat-checks
  // the candidate, rejects symlinks, and confirms the resolved path stays
  // inside peersRoot. Mirrors the contract of every other I/O entry-point
  // in this module (`readPeer`, `writePeer`, `deletePeer`,
  // `appendInteractionLog`, `readPeerProfile`, `writePeerProfile`).
  // The function handles ENOENT gracefully (returns without throwing), so
  // calling it here is safe for the idempotent no-op path as well.
  await assertPeerDirNotEscaped(memoryDir, peerId);

  const dir = peerDir(memoryDir, peerId);

  // lstat the candidate directory. Return early (idempotent) if it
  // doesn't exist. Reject if it resolves to a symlink.
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

  // Perform the recursive removal. `fs.rm` with `{ recursive: true }`
  // is the correct API (replaces the deprecated `fs.rmdir`). The
  // `force: true` flag makes it a no-op if the directory was already
  // removed between our lstat and this call (race-safe idempotency).
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
  // Codex P2 round 13: atomic readdir against the root. Open the
  // peers directory with O_DIRECTORY|O_NOFOLLOW first so we hold the
  // original-inode handle, then readdir from that handle. A
  // root-symlink swap between assertPeersRootNotSymlink and a path-
  // based readdir is no longer possible — the kernel rejects the
  // open if the path resolves to a symlink, and the dirHandle.read()
  // operates on the original inode regardless of subsequent path-
  // based mutations.
  const root = peersRoot(memoryDir);
  // Cursor M round 14: Node's FileHandle has no `readdir` method
  // (only `fs.readdir(path)` is exposed), so we can't read directly
  // from the handle. Instead anchor the original-inode by opening
  // the dir with O_NOFOLLOW, fstat it, then do path-based readdir
  // and confirm the path's lstat AFTER matches the held inode. If
  // it diverges, a swap happened — abort. This is a fence around
  // the readdir, not the kernel-level guarantee a true `fdreaddir`
  // would give, but it closes the path-traversal race without
  // requiring native bindings.
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
  // Sort for deterministic ordering — callers that need a different
  // sort order can re-sort the result.
  entries.sort();
  for (const name of entries) {
    if (!PEER_ID_PATTERN.test(name) || name.length > PEER_ID_MAX_LENGTH) {
      continue;
    }
    let stat;
    try {
      // Codex P1: use `lstat` so we don't follow symlinks. A
      // `peers/<valid-id>` symlink pointing at an arbitrary directory
      // would otherwise let listPeers (and the readPeer that
      // follows) traverse outside the peers root.
      stat = await fs.lstat(path.join(root, name));
    } catch (err) {
      // Codex P2 round 13: don't swallow non-ENOENT errors.
      // Permission-denied / EACCES / EIO need to surface so the
      // operator sees a real I/O problem rather than a silently
      // truncated peer list.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    // Skip symlinks entirely — only real directories are peers.
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    let peer: Peer | null = null;
    try {
      peer = await readPeer(memoryDir, name);
    } catch (err) {
      // Cursor M round 14: classifying by `.code` alone treated
      // security-check failures (assertPeerDirNotEscaped /
      // assertParentDirInodeStable / "is a symlink and is rejected"
      // / "inode mismatch") as parse failures and silently skipped
      // them. Those messages are critical signals — an attacker
      // attempted to redirect a read outside the peers root. Match
      // by message prefix to detect them and propagate.
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
      // Real I/O errors (EACCES, EIO, EBUSY, etc.) propagate too.
      if (code && code !== "ENOENT") throw err;
      // Schema/parse failures fall through and skip the entry.
      continue;
    }
    if (peer !== null) {
      peers.push(peer);
    }
  }
  return peers;
}

// ──────────────────────────────────────────────────────────────────────
// Interaction log (append-only)
// ──────────────────────────────────────────────────────────────────────

function sanitizeLogField(value: string): string {
  // Cursor Medium: every interaction-log field — not just summary —
  // must collapse newlines so a malicious or buggy `timestamp` /
  // `kind` / `sessionId` value can't break the one-line-per-entry
  // invariant the append-only log relies on. Replace CR/LF/Tab with
  // a single space; trim leading/trailing whitespace.
  return value.replace(/[\r\n\t]+/g, " ").trim();
}

function formatLogEntry(entry: PeerInteractionLogEntry): string {
  // One line per entry. We use a leading bullet so the file remains
  // readable as ordinary markdown. Order: timestamp, kind, optional
  // session id, summary. ALL fields are passed through `sanitizeLogField`
  // so a stray newline anywhere can't shatter the append-only invariant
  // (cursor Medium on PR #723).
  //
  // Cursor Low on PR #736: the previous bare `session=<id>` token was
  // ambiguous with summaries that literally start with `session=`
  // (e.g. summary `"session=foo bar"` round-tripped to
  // `{sessionId: "foo", summary: "bar"}`). New entries wrap the
  // session marker in square brackets — `[session=<id>]` — which a
  // sanitized summary can never start with (sanitizeLogField never
  // emits `[` as the first character of a summary that originally
  // started with `session=`, and bracketed metadata is unambiguously
  // distinct from `session=` text). Old entries written by previous
  // code remain parseable through the legacy fallback in
  // `parseLogLine`.
  const ts = sanitizeLogField(entry.timestamp);
  const kind = sanitizeLogField(entry.kind);
  const summary = sanitizeLogField(entry.summary);
  const session = entry.sessionId
    ? ` [session=${sanitizeLogField(entry.sessionId)}]`
    : "";
  return `- [${ts}] (${kind})${session} ${summary}`;
}

/**
 * Append one entry to a peer's interaction log.
 *
 * Creates `peers/{id}/` and `interactions.log.md` if needed. The file is
 * append-only by contract — this helper never rewrites prior entries.
 * Returns the absolute path of the log file (useful for tests).
 */
export async function appendInteractionLog(
  memoryDir: string,
  peerId: string,
  entry: PeerInteractionLogEntry,
): Promise<string> {
  assertValidPeerId(peerId);
  // Codex P2 round 10: trim() before the empty check matches what
  // sanitizeLogField does at format time. A whitespace-only
  // `timestamp` or `kind` would previously pass validation and then
  // be normalized to "" later, producing an entry like `- [] ()`
  // that breaks downstream parsers.
  if (typeof entry.timestamp !== "string" || entry.timestamp.trim() === "") {
    throw new Error("interaction entry must have a non-whitespace timestamp");
  }
  if (typeof entry.kind !== "string" || entry.kind.trim() === "") {
    throw new Error("interaction entry must have a non-whitespace kind");
  }
  if (typeof entry.summary !== "string") {
    throw new Error("interaction entry must have a string summary");
  }
  // Codex P2 round 6/8/9: optional sessionId must be a non-empty
  // string OR strictly `undefined` (omitted). null and empty string
  // are both rejected explicitly: the previous behavior silently
  // dropped them during formatting, which reinterprets invalid input
  // instead of failing fast like other validators in this module.
  // Codex P2 round 12: trim() before the empty check matches what
  // sanitizeLogField does at format time. Whitespace-only sessionId
  // would otherwise pass validation and produce a `session=` token
  // with an empty value that breaks downstream log parsers.
  if (entry.sessionId !== undefined) {
    if (typeof entry.sessionId !== "string" || entry.sessionId.trim() === "") {
      throw new Error("interaction entry sessionId must be a non-whitespace string when provided");
    }
  }
  await mkdirPeerDirAtomic(memoryDir, peerId);
  await assertPeerDirNotEscaped(memoryDir, peerId);
  const file = interactionsPath(memoryDir, peerId);
  const line = formatLogEntry(entry) + "\n";
  // `appendFile` creates the file if it does not exist. POSIX guarantees
  // writes < PIPE_BUF are atomic; entries on this path are well under
  // that bound. Ordering across concurrent writers is the caller's
  // responsibility for now — the reasoner runs serially in PR 2/5.
  await appendFileNoFollow(file, line);
  return file;
}

// ──────────────────────────────────────────────────────────────────────
// Profile read/write (schema scaffold; reasoner ships in PR 2/5)
// ──────────────────────────────────────────────────────────────────────

interface ProfileFile {
  updatedAt: string;
  fields: Record<string, string>;
  provenance: Record<string, PeerProfileFieldProvenance[]>;
}

function emitPeerProfile(profile: PeerProfile): string {
  // Profiles use a JSON-in-fenced-code-block payload inside a markdown
  // file so they remain human-readable. The frontmatter holds the
  // updatedAt stamp; the body holds the full structured payload.
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
  // Codex P2: only accept string updatedAt values. A malformed payload
  // like `{ "updatedAt": 123 }` would previously short-circuit through
  // `payload.updatedAt ?? fm.updatedAt ?? ""` and produce a `PeerProfile`
  // whose updatedAt is a number — corrupting any downstream code that
  // assumes the contract.
  const payloadUpdatedAt = typeof payload.updatedAt === "string" ? payload.updatedAt : undefined;
  const updatedAt = payloadUpdatedAt ?? fm.updatedAt ?? "";
  if (typeof updatedAt !== "string" || updatedAt === "") {
    throw new Error(`peer profile for "${peerId}" is missing updatedAt`);
  }
  // Codex P2 round 10: a malformed `fields: "wat"` or
  // `provenance: 42` previously coerced to {} and silently dropped
  // the section. That contradicts the "malformed files throw"
  // contract — the file IS malformed, not just empty. Reject loudly.
  // `undefined` is still tolerated (an older profile file might omit
  // the section entirely).
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
  // Coerce values defensively. We never trust the on-disk shape.
  // Codex P1: skip prototype-pollution keys explicitly. We don't use
  // null-prototype objects in the returned shape because callers
  // (tests, downstream consumers) expect plain objects with normal
  // semantics — the assertion `assert.deepEqual` differentiates by
  // prototype. The skip-list is the load-bearing defense; iteration
  // via Object.entries() of attacker-controlled JSON objects is safe
  // as long as we never assign through dangerous keys.
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
      // Codex P2 round 9: empty observedAt/signal strings should be
      // treated as malformed, not valid. Drop the entry.
      if (typeof r.observedAt !== "string" || r.observedAt === "") continue;
      if (typeof r.signal !== "string" || r.signal === "") continue;
      // Codex P2 round 6: previously the optional fields were never
      // type-checked, so a hand-edited `{sourceSessionId: 123}`
      // survived and corrupted the PeerProfileFieldProvenance contract.
      // Build a clean record with only string-typed optional fields.
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

/**
 * Write (create or overwrite) a peer's profile.
 */
export async function writePeerProfile(
  memoryDir: string,
  profile: PeerProfile,
): Promise<void> {
  assertValidPeerId(profile.peerId);
  if (typeof profile.updatedAt !== "string" || profile.updatedAt === "") {
    throw new Error("profile.updatedAt must be a non-empty ISO-8601 string");
  }
  // Codex P2 round 6: validate the nested payload shape on write so
  // round-trip semantics are preserved. Without this, untyped JS
  // callers can persist non-string field values or malformed
  // provenance entries — readPeerProfile silently scrubs them on
  // the way back, so data is lost without an error. Fail fast at
  // the boundary instead.
  if (!isPlainObject(profile.fields)) {
    throw new Error("profile.fields must be a plain object");
  }
  // Codex P2 round 11: parsePeerProfile drops "__proto__" /
  // "constructor" / "prototype" keys on read. Without symmetric
  // rejection on write, those keys silently disappear during
  // round-trip — failing the contract that what writes succeeds
  // also reads back. Reject at the boundary so JS callers learn
  // immediately that those keys aren't allowed.
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
      // Cursor M round 9: empty optional strings would round-trip lose
      // (parsePeerProfile drops them on read). Reject at the boundary
      // for consistency with other validators in this module.
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

/**
 * Inverse of `formatLogEntry`. Used by `readPeerInteractionLog` to
 * convert the on-disk one-line bullet form back into a structured
 * `PeerInteractionLogEntry`. Returns `null` for malformed lines so
 * callers can keep the rest of the log even when a single entry was
 * hand-edited or partially written.
 *
 * Formats accepted (must match `formatLogEntry`):
 *
 *   - [TS] (KIND) [session=SID] SUMMARY     // canonical (PR #736)
 *   - [TS] (KIND) SUMMARY                   // session optional
 *
 * The unbracketed `session=SID` form (which would have been written
 * by an earlier draft of #679 PR 2/5) is intentionally NOT parsed —
 * the cursor #736 finding showed it was indistinguishable from a
 * summary that legitimately starts with `session=`. Since #679 PR
 * 2/5 is the first shipped writer for `sessionId` AND ships the
 * bracketed canonical form simultaneously, there is no real legacy
 * data on disk to support. A summary like `session=foo bar` thus
 * round-trips verbatim into `summary` rather than being mis-claimed
 * as a session id.
 *
 * Whitespace inside SUMMARY is preserved verbatim. The parser is
 * deliberately strict — anything that doesn't start with `- [` is
 * rejected and dropped (the file is also markdown-friendly, so blank
 * lines and stray prose are simply ignored).
 */
function parseLogLine(line: string): PeerInteractionLogEntry | null {
  if (!line.startsWith("- [")) return null;
  const tsClose = line.indexOf("]", 3);
  if (tsClose === -1) return null;
  const timestamp = line.slice(3, tsClose).trim();
  if (timestamp === "") return null;
  // Skip optional whitespace between `]` and `(`.
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
  // Optional session id token. We tolerate any leading whitespace
  // count; `formatLogEntry` always emits exactly one space, but
  // operator-edited logs may diverge.
  while (cursor < line.length && line[cursor] === " ") cursor += 1;
  // Canonical form (PR #736): `[session=<id>]`. Unambiguous because
  // a sanitized summary cannot start with `[session=` followed by a
  // closing bracket and a space — sanitization preserves user content
  // verbatim except for newlines/CR/tab, so a summary that literally
  // begins `[session=foo]` would imply the OPERATOR wrote a real
  // session marker, which is acceptable as session attribution.
  if (line.startsWith("[session=", cursor)) {
    const close = line.indexOf("]", cursor + "[session=".length);
    // A `[session=...]` with no closing bracket on the same line is
    // malformed metadata; treat the whole tail as summary instead of
    // misclaiming a session id.
    if (close > -1) {
      const sid = line.slice(cursor + "[session=".length, close).trim();
      if (sid.length > 0) sessionId = sid;
      cursor = close + 1;
    }
  }
  // NOTE: the legacy unbracketed `session=<id>` form is intentionally
  // NOT parsed. The cursor #736 finding is fundamentally a format
  // ambiguity: `- [TS] (KIND) session=foo bar` is indistinguishable
  // from a real session token vs. a summary that begins with the
  // literal text `session=foo bar`. Since #679 PR 2/5 is the first
  // PR that writes `sessionId` to the log AND ships the bracketed
  // canonical form simultaneously, there is no production legacy
  // data to support. Old `session=`-style summaries — both real
  // operator notes and hypothetical legacy entries — round-trip
  // verbatim into `summary` rather than being silently mis-claimed
  // as a session id.
  // Remaining tail is the summary (possibly empty if the log was
  // hand-edited; we still accept "" because `formatLogEntry` itself
  // accepts an empty summary string).
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
 * with `timestamp < afterTimestamp` (string compare is safe for
 * canonical ISO-8601 form). Both filters are applied in order:
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
  // Split on bare newlines; logs are written with a trailing `\n` per
  // entry by `appendInteractionLog`, so the final element after split
  // is typically the empty string. Both `\r\n` and `\n` are tolerated.
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
    filtered = filtered.filter((e) => e.timestamp > cutoff);
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
