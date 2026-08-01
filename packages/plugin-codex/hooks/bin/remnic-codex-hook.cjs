#!/usr/bin/env node
/**
 * Remnic unified Codex hook runner (issue #1440).
 *
 * A single cross-platform Node.js implementation of all four Codex hooks.
 * Thin `.sh` (POSIX) and `.ps1` (Windows) wrappers exec this file with the
 * event name as argv[2]:
 *
 *   node remnic-codex-hook.cjs <event>
 *
 * Events: session-start | user-prompt-recall | post-tool-observe | session-end
 *
 * This is a faithful port of the original four bash scripts — same endpoints,
 * env vars, token resolution, cursor/lock hardening, engram→remnic migration,
 * daemon health/auto-start, git coding-context projectId derivation, and
 * session-end memory materialization. Node replaces the per-script `node -e`
 * one-liners and Unix tools (curl/git/sed/mktemp/…) so the exact same logic
 * runs on Windows, macOS, and Linux.
 *
 * Fail-open everywhere: any unexpected error degrades to `{"continue":true}`.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFileSync, spawn, spawnSync } = require("child_process");

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

// Daemon base URL resolution (issue #1571 — remote/network parity with
// @remnic/plugin-pi's `remnicDaemonUrl`). A full REMNIC_DAEMON_URL
// (e.g. "http://macstudio.tailnet:4318" or "https://remnic.internal:443")
// takes precedence and lets a Codex host talk to a shared central daemon
// over Tailscale/LAN/VPN. The legacy REMNIC_HOST/REMNIC_PORT pair remains
// supported as a backward-compat fallback so existing installs and the
// test harness (which spins a mock on 127.0.0.1:<port>) keep working.
const RAW_DAEMON_URL = process.env.REMNIC_DAEMON_URL || process.env.ENGRAM_DAEMON_URL || "";
const HOST = process.env.REMNIC_HOST || process.env.ENGRAM_HOST || "127.0.0.1";
const PORT = process.env.REMNIC_PORT || process.env.ENGRAM_PORT || "4318";

// Parse once. `protocol` is "http:" or "https:" so https.request is selected
// for TLS daemons (common for remote/private deployments behind a proxy).
//
// An EXPLICIT but invalid REMNIC_DAEMON_URL (missing scheme, typo, e.g.
// "macstudio:4318") must NOT silently fall through to REMNIC_HOST/REMNIC_PORT —
// that would route recall/observe/flush to a local daemon and corrupt the wrong
// memory store. Instead we disable the daemon entirely (all HTTP calls fail
// open) and surface the misconfiguration once on stderr so the operator fixes
// the URL rather than debugging silent cross-store writes (#1571 review).
let DAEMON_CONFIG_ERROR = "";
const DAEMON_URL = (function resolveDaemonUrl() {
  if (RAW_DAEMON_URL) {
    try {
      const parsed = new URL(RAW_DAEMON_URL);
      // Require an explicit scheme — a bare "macstudio:4318" parses with
      // protocol "macstudio:" and would otherwise silently route to localhost.
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed;
    } catch {
      /* handled below */
    }
    DAEMON_CONFIG_ERROR =
      'REMNIC_DAEMON_URL="' + RAW_DAEMON_URL + '" is not a valid http(s) URL — ' +
      "daemon disabled (recall/observe/flush will no-op). Set a valid " +
      "http(s):// URL or unset REMNIC_DAEMON_URL to use REMNIC_HOST/REMNIC_PORT.";
    if (process.env.REMNIC_HOOK_QUIET !== "1") {
      try { process.stderr.write("[remnic-codex-hook] " + DAEMON_CONFIG_ERROR + "\n"); } catch {}
    }
    return null;
  }
  try {
    return new URL(`http://${HOST}:${PORT}`);
  } catch {
    return new URL("http://127.0.0.1:4318");
  }
})();

// Internal re-entrant mode: post-tool-observe spawns a detached copy of itself
// so the (slow) observe runs in the background and never blocks Codex past the
// short PostToolUse timeout — mirroring the original `( … ) & disown`.
const OBSERVE_WORKER = "__observe-worker__";

// PreCompact tail-drain lock-wait budget (100ms each → ~15s). Bounds how long
// handlePreCompact waits for a detached PostToolUse observe worker (whose own
// /observe can run up to 120s) to release the session lock before skipping the
// drain+flush. 15s covers a typical observe round-trip on a healthy daemon; a
// pathologically slow worker that outlasts this is left for the next cycle
// rather than blocking compaction indefinitely. The hooks.json PreCompact
// timeout accommodates this budget plus the drain observe + LCM flush.
const _pcRaw = process.env.REMNIC_PRECOMPACT_LOCK_RETRIES;
const _pcParsed = _pcRaw != null && _pcRaw !== "" ? Number.parseInt(_pcRaw, 10) : 150;
// 0 is honored (immediate busy-skip); NaN/negative falls back to the 150 default.
const PRECOMPACT_LOCK_RETRIES = Number.isFinite(_pcParsed) && _pcParsed >= 0 ? _pcParsed : 150;

const LOG_FILES = {
  "session-start": "remnic-session-recall.log",
  "user-prompt-recall": "remnic-user-prompt-recall.log",
  "post-tool-observe": "remnic-post-tool-observe.log",
  "session-end": "remnic-codex-session-end.log",
  "pre-compact": "remnic-pre-compact.log",
};
const LOG_TAGS = {
  "session-start": "codex-session-start",
  "user-prompt-recall": "codex-user-prompt",
  "post-tool-observe": "codex-post-tool",
  "session-end": "codex-stop",
  "pre-compact": "codex-pre-compact",
};

function makeLogger(event) {
  const file = path.join(HOME, ".remnic", "logs", LOG_FILES[event] || "remnic-codex-hook.log");
  const tag = LOG_TAGS[event] || "codex-hook";
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* best effort */
  }
  return (msg) => {
    try {
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      fs.appendFileSync(file, `${ts} [${tag}] ${msg}\n`);
    } catch {
      /* logging must never throw */
    }
  };
}

let emitted = false;
function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  emitted = true;
}

function readStdin() {
  // Always read the real stdin. The foreground hook gets its payload from
  // Codex on fd 0; the detached observe worker gets it from the pipe the
  // foreground writes. We deliberately do NOT consult an env var here — an
  // inherited REMNIC_HOOK_INPUT in the parent environment would otherwise
  // override the piped payload and the worker could observe stale/empty input
  // (#1443 review).
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseInput(raw) {
  try {
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? d : {};
  } catch {
    return {};
  }
}

// ── engram → remnic migration (CLAUDE.md rule #9) ──────────────────────────
function ensureMigrated() {
  try {
    if (fs.existsSync(path.join(HOME, ".remnic", ".migrated-from-engram"))) return;
    const hasEngram =
      fs.existsSync(path.join(HOME, ".engram")) ||
      fs.existsSync(path.join(HOME, ".config", "engram", "config.json"));
    if (!hasEngram) return;
    // Try `remnic` first, fall through to legacy `engram` when missing on PATH.
    // Pre-check PATH with onPath() (which is .cmd/.exe-aware on Windows) rather
    // than relying on spawnSync ENOENT — under `shell: true` a missing command
    // yields a non-zero shell exit, not ENOENT, so an exit-code check couldn't
    // distinguish "missing" from "migration failed" (#1443 review).
    // On Windows the CLIs are `.cmd` shims, which Node can only launch via a
    // shell. Timeout is 5 min so a large migration can complete (the original
    // bash hook had no timeout). Args are fixed literals — safe under a shell.
    for (const bin of ["remnic", "engram"]) {
      if (!onPath(bin)) continue;
      spawnSync(bin, ["migrate"], {
        stdio: "ignore",
        timeout: 300000,
        shell: process.platform === "win32",
        windowsHide: true,
      });
      return;
    }
  } catch {
    /* migration is best effort */
  }
}

// PATH lookup helper (cross-platform equivalent of bash `command -v`).
// Returns true when an executable named `bin` is reachable via $PATH. Used
// before async `spawn()` calls so the remnic → engram fallthrough actually
// happens when only the legacy CLI is installed — `spawn` emits ENOENT
// asynchronously via 'error', so a naive try/break can't see it (#1443 review).
function onPath(bin) {
  const PATH = process.env.PATH || process.env.Path || process.env.path || "";
  const sep = process.platform === "win32" ? ";" : ":";
  // Windows resolves names without an extension by appending PATHEXT entries.
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((e) => e.trim())
          .filter(Boolean)
      : [""];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const candidate = path.join(dir, bin + ext);
        const info = fs.statSync(candidate);
        if (info.isFile()) return true;
      } catch {
        /* try next */
      }
    }
  }
  return false;
}

// ── token resolution (per-plugin token store, then env) ────────────────────
// Env precedence is primary-before-legacy per AGENTS.md §9: the two current
// names (OPENCLAW_REMNIC_ACCESS_TOKEN, REMNIC_AUTH_TOKEN) before the two
// legacy aliases (OPENCLAW_ENGRAM_ACCESS_TOKEN, ENGRAM_AUTH_TOKEN), so a
// stale leftover from a pre-rename install cannot outrank the credential the
// daemon is actually running with. REMNIC_AUTH_TOKEN matters because the
// documented standalone-server setup authenticates the daemon with it alone
// and never mints a connector token.
function resolveToken() {
  for (const file of [
    path.join(HOME, ".remnic", "tokens.json"),
    path.join(HOME, ".engram", "tokens.json"),
  ]) {
    try {
      if (!fs.existsSync(file)) continue;
      const store = JSON.parse(fs.readFileSync(file, "utf8"));
      const tokens = Array.isArray(store.tokens) ? store.tokens : [];
      const byConnector = (c) => tokens.find((t) => t && t.connector === c);
      const tok =
        (byConnector("codex-cli") || {}).token ||
        (byConnector("codex") || {}).token ||
        (byConnector("openclaw") || {}).token ||
        store["codex-cli"] ||
        store["codex"] ||
        store["openclaw"] ||
        "";
      if (tok) return tok;
    } catch {
      /* try next file */
    }
  }
  return (
    process.env.OPENCLAW_REMNIC_ACCESS_TOKEN ||
    process.env.REMNIC_AUTH_TOKEN ||
    process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN ||
    process.env.ENGRAM_AUTH_TOKEN ||
    ""
  );
}

// ── Namespace chokepoint (#1571) ─────────────────────────────────────────────
// Single source of truth for the optional namespace override. EVERY observe and
// flush body MUST go through withNamespace() so a namespaced Codex install
// archives + flushes under one key — without it, buffered observations land on
// the default key while a namespaced flush drains a different (empty) queue, and
// most in-session memory never flushes before compaction.
function resolveNamespace() {
  return process.env.REMNIC_NAMESPACE || process.env.ENGRAM_NAMESPACE || "";
}
function withNamespace(body) {
  const ns = resolveNamespace();
  if (ns) body.namespace = ns;
  return body;
}

// Base path from the daemon URL (for reverse-proxy subpath mounts, e.g.
// REMNIC_DAEMON_URL=http://gw/remnic). Mirrors plugin-pi's daemon-URL + route
// concatenation — without this, a path-qualified base URL has its prefix
// silently dropped and requests hit the host root (#1571 review). Trailing
// slashes are stripped so "/remnic/" + "/engram/v1/observe" becomes
// "/remnic/engram/v1/observe"; a bare root ("/") yields "" (no prefix).
const DAEMON_BASE_PATH = DAEMON_URL ? DAEMON_URL.pathname.replace(/\/+$/, "") : "";

// ── HTTP helpers — return a real success signal (2xx) so callers can decide
// whether to advance/clear the cursor (fixes the data-loss bug in #1442).
//
// All requests route through the parsed DAEMON_URL (#1571), so a Codex host
// can target a remote/central daemon (Tailscale/LAN/VPN, plain or TLS) by
// setting REMNIC_DAEMON_URL — same transport contract as @remnic/plugin-pi. ─

function httpPost(urlPath, token, bodyObj, timeoutMs) {
  if (DAEMON_URL === null) {
    // Explicit-but-invalid REMNIC_DAEMON_URL — disabled, fail open (see
    // resolveDaemonUrl). Callers treat this like a dead daemon.
    return Promise.resolve({ ok: false, status: 0, body: "" });
  }
  const transport = DAEMON_URL.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    let data;
    try {
      data = Buffer.from(JSON.stringify(bodyObj), "utf8");
    } catch {
      resolve({ ok: false, status: 0, body: "" });
      return;
    }
    const req = transport.request(
      {
        protocol: DAEMON_URL.protocol,
        hostname: DAEMON_URL.hostname,
        port: DAEMON_URL.port || (DAEMON_URL.protocol === "https:" ? 443 : 80),
        path: DAEMON_BASE_PATH + urlPath,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Engram-Client-Id": "codex",
          "Content-Length": data.length,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode || 0,
            body,
          }),
        );
      },
    );
    req.on("error", () => resolve({ ok: false, status: 0, body: "" }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: "" });
    });
    req.write(data);
    req.end();
  });
}

// `token` is the caller's already-resolved credential, NOT a second
// resolveToken() call: the probe must authenticate with the exact bearer the
// operation it gates will send. Re-resolving could pick up a rotated
// tokens.json (or an inherited REMNIC_HOOK_TOKEN the foreground handlers
// ignore) and green-light a probe whose recall then 401s.
//
// When the daemon has an auth token configured, every route — including
// /engram/v1/health — returns 401 to unauthenticated requests, so an
// unauthenticated probe makes the hook wrongly report "daemon not running"
// and skip recall/observe. Unauthenticated daemons ignore the header.
function httpHealthy(timeoutMs, token) {
  if (DAEMON_URL === null) return Promise.resolve(false);
  const transport = DAEMON_URL.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const req = transport.request(
      {
        protocol: DAEMON_URL.protocol,
        hostname: DAEMON_URL.hostname,
        port: DAEMON_URL.port || (DAEMON_URL.protocol === "https:" ? 443 : 80),
        path: DAEMON_BASE_PATH + "/engram/v1/health",
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// ── git coding-context (mirrors @remnic/core git-context.ts) ───────────────
function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function stableHash(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Mirrors packages/remnic-core/src/coding/git-context.ts normalizeOriginUrl.
// Keep in sync so the hook-computed projectId matches the daemon's.
function normalizeOriginUrl(raw) {
  let u = (raw || "").trim();
  if (!u) return "";
  if (/\.git$/i.test(u)) u = u.slice(0, -4);
  if (/^[A-Za-z]:[\\/]/.test(u)) return u.toLowerCase();
  const proto = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?(\[[^\]]+\]|[^/:]*)(?::(\d+))?(\/.*)?$/i.exec(u);
  if (proto) {
    let host = proto[1] || "";
    const wasBracketed = host.startsWith("[") && host.endsWith("]");
    if (wasBracketed) host = host.slice(1, -1);
    const port = proto[2];
    const p = (proto[3] || "").replace(/^\/+/, "");
    const hostPort = port
      ? wasBracketed
        ? "[" + host + "]:" + port
        : host + ":" + port
      : host;
    const prefix = hostPort.length > 0 ? hostPort : "localhost";
    return (prefix + "/" + p).toLowerCase();
  }
  const scp = /^(?:([^@\s/]+)@)?(\[[^\]]+\]|[^:@\s/]+):(.+)$/.exec(u);
  if (scp) {
    let host = scp[2] || "";
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    const p = scp[3] || "";
    if (p.startsWith("//")) return u.toLowerCase();
    return (host + "/" + p.replace(/^\/+/, "")).toLowerCase();
  }
  return u.toLowerCase();
}

function resolveCodingContext(cwd) {
  try {
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return null;
    const top = git(["-C", cwd, "rev-parse", "--show-toplevel"], cwd);
    if (!top) return null;
    let branch = git(["-C", top, "rev-parse", "--abbrev-ref", "HEAD"], top);
    if (branch === "HEAD") branch = "";
    const origin = git(["-C", top, "remote", "get-url", "origin"], top);
    const defRef = git(["-C", top, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], top);
    const defaultBranch = defRef ? defRef.replace(/^refs\/remotes\/origin\//, "") : "";
    const normalized = normalizeOriginUrl(origin);
    const projectId = normalized ? "origin:" + stableHash(normalized) : "root:" + stableHash(top);
    return {
      projectId,
      branch: branch || null,
      rootPath: top,
      defaultBranch: defaultBranch || null,
    };
  } catch {
    return null;
  }
}

// ── transcript parsing ─────────────────────────────────────────────────────
function parseTranscript(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "user" && entry.type !== "assistant") continue;
      const msg = entry.message;
      if (!msg || typeof msg !== "object") continue;
      const role = msg.role;
      if (role !== "user" && role !== "assistant") continue;
      let text = "";
      if (typeof msg.content === "string") text = msg.content.trim();
      else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text.trim())
          .join("\n")
          .trim();
      }
      if (text) messages.push({ role, content: text });
    } catch {
      /* skip malformed line */
    }
  }
  return messages;
}

// ── cursor / lock state hardening (post-tool + session-end) ────────────────
const SELF_UID = typeof process.getuid === "function" ? process.getuid() : null;

function ownedByUs(info) {
  return SELF_UID === null || info.uid === SELF_UID;
}

// Returns { cursorFile, lockFile } or null if the state dir is unsafe.
function resolveState(sessionId, log) {
  const stateHome = process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state");
  const stateDir = path.join(stateHome, "remnic", "hooks");
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch {
    return null;
  }
  try {
    const info = fs.lstatSync(stateDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      log(`unsafe state directory ${stateDir}`);
      return null;
    }
    if (!ownedByUs(info)) {
      log(`unsafe state directory ${stateDir}`);
      return null;
    }
    if ((info.mode & 0o077) !== 0) {
      try {
        fs.chmodSync(stateDir, 0o700);
      } catch {
        /* best effort */
      }
    }
  } catch {
    return null;
  }
  let cursorFile = path.join(stateDir, `remnic-cursor-${sessionId}`);
  let lockFile = path.join(stateDir, `remnic-lock-${sessionId}.d`);
  const legacyCursor = path.join(stateDir, `engram-cursor-${sessionId}`);
  const legacyLock = path.join(stateDir, `engram-lock-${sessionId}.d`);
  // Mid-migration fallback: adopt the legacy engram-* cursor/lock so we don't
  // re-observe the whole transcript (CLAUDE.md rule #9).
  if (!fs.existsSync(cursorFile) && (fs.existsSync(legacyCursor) || fs.existsSync(legacyLock))) {
    cursorFile = legacyCursor;
    lockFile = legacyLock;
  }
  return { cursorFile, lockFile, legacyCursor, legacyLock };
}

// true if the cursor file is safe to read/write (or absent).
function cursorSafe(cursorFile) {
  try {
    const info = fs.lstatSync(cursorFile);
    if (info.isSymbolicLink() || !info.isFile()) return false;
    return ownedByUs(info);
  } catch (err) {
    return err && err.code === "ENOENT";
  }
}

function readCursor(cursorFile, log) {
  if (!cursorSafe(cursorFile)) {
    log(`unsafe cursor file ${cursorFile}`);
    return null;
  }
  try {
    const raw = fs.readFileSync(cursorFile, "utf8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeCursor(cursorFile, value, log) {
  if (!cursorSafe(cursorFile)) {
    log(`refusing unsafe cursor file ${cursorFile}`);
    return false;
  }
  try {
    const tmp = `${cursorFile}.tmp.${process.pid}.${Math.abs(stableHash(String(value)) | 0)}`;
    fs.writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
    fs.renameSync(tmp, cursorFile);
    return true;
  } catch {
    return false;
  }
}

function removeCursor(cursorFile, log) {
  if (!cursorSafe(cursorFile)) {
    log(`refusing unsafe cursor file ${cursorFile}`);
    return false;
  }
  try {
    fs.rmSync(cursorFile, { force: true });
  } catch {
    /* best effort */
  }
  return true;
}

// Adopt a higher /tmp cursor written by an older/cross-process run, then clean.
function migrateTmpCursor(sessionId, cursorFile, log) {
  for (const tmp of [
    path.join(os.tmpdir(), `remnic-cursor-${sessionId}`),
    path.join(os.tmpdir(), `engram-cursor-${sessionId}`),
    `/tmp/remnic-cursor-${sessionId}`,
    `/tmp/engram-cursor-${sessionId}`,
  ]) {
    try {
      if (!fs.existsSync(tmp)) continue;
      const info = fs.lstatSync(tmp);
      if (info.isSymbolicLink() || !info.isFile() || !ownedByUs(info)) continue;
      const raw = fs.readFileSync(tmp, "utf8").trim();
      if (!/^\d+$/.test(raw)) continue;
      const tmpVal = parseInt(raw, 10);
      const current = cursorSafe(cursorFile) ? readCursor(cursorFile, log) : -1;
      if (tmpVal > (current === null ? -1 : current)) writeCursor(cursorFile, tmpVal, log);
      fs.rmSync(tmp, { force: true });
    } catch {
      /* skip */
    }
  }
}

// mkdir-based mutex with stale-lock reaping (10 min). Returns true if acquired.
// `retries` bounds the synchronous wait (100ms each). The default (50 → ~5s)
// suits foreground hooks; PreCompact's tail drain passes a larger budget so it
// can outlast a detached PostToolUse observe worker holding the lock, ensuring
// the subsequent flush sees the worker's queued messages instead of racing.
// 0 means "try once, don't wait/retry" — a free lock is still taken; only a
// busy lock is skipped immediately (used by the 0-retry test/fleet path). This
// avoids the degenerate "0 retries skips acquisition entirely" case (#1571
// review) where a free lock would be wastefully bypassed.
function acquireLock(lockFile, log, retries = 50) {
  const attempts = Math.max(1, retries);
  for (let i = 0; i < attempts; i++) {
    try {
      fs.mkdirSync(lockFile);
      return true;
    } catch {
      if (i === 0) reapStaleLock(lockFile);
      sleepSync(100);
    }
  }
  return false;
}

function reapStaleLock(lockFile) {
  try {
    const info = fs.lstatSync(lockFile);
    if (info.isSymbolicLink() || !info.isDirectory() || !ownedByUs(info)) return;
    if (Date.now() - info.mtimeMs < 10 * 60 * 1000) return;
    fs.rmSync(lockFile, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function releaseLock(lockFile) {
  try {
    fs.rmdirSync(lockFile);
  } catch {
    /* best effort */
  }
}

function sleepSync(ms) {
  // Synchronous sleep without busy-spin (Atomics.wait on a throwaway buffer).
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* fallback spin */
    }
  }
}

// ── event handlers ─────────────────────────────────────────────────────────

async function handleSessionStart(input, token, log) {
  const sessionId = input.session_id || "";
  const cwd = input.cwd || "";
  const projectName = (cwd && path.basename(cwd)) || "unknown";
  const codingContext = resolveCodingContext(cwd);
  log(`session=${sessionId} project=${projectName} coding-context=${codingContext ? "yes" : ""}`);

  // Health check — start daemon if not running.
  if (!(await httpHealthy(2000, token))) {
    log("daemon not responding, attempting start...");
    // Try `remnic` first, fall through to legacy `engram` when only the older
    // CLI is on PATH. spawn() emits ENOENT *asynchronously* via 'error', so we
    // pre-check the binary with onPath() instead of relying on try/break
    // (#1443 review — the bare try/break never reached `engram`).
    for (const bin of ["remnic", "engram"]) {
      if (!onPath(bin)) continue;
      try {
        // Windows: `remnic`/`engram` are `.cmd` shims, which Node can only
        // launch via a shell (#1443 review). Args are fixed literals — safe.
        const child = spawn(bin, ["daemon", "start"], {
          detached: true,
          stdio: "ignore",
          shell: process.platform === "win32",
          windowsHide: true,
        });
        child.on("error", () => {});
        child.unref();
        break;
      } catch {
        /* try next */
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
    if (!(await httpHealthy(2000, token))) {
      log("daemon still not responding after start attempt");
      emit({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "[Remnic: daemon not running — start with: remnic daemon start]",
        },
      });
      return;
    }
  }

  if (!token) {
    log("skipping: no token found");
    emit({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "[Remnic: no auth token — run: remnic connectors install codex-cli]",
      },
    });
    return;
  }

  const query =
    `Starting a new coding session in project: ${projectName}. ` +
    "Recall relevant memories, preferences, decisions, patterns, and context about this project and the user.";

  // codingContext is explicitly null when absent so stale namespace routing is
  // cleared when a session moves out of a repo.
  let res = await httpPost(
    "/engram/v1/recall",
    token,
    withNamespace({ query, sessionKey: sessionId, topK: 12, mode: "auto", codingContext }),
    45000,
  );
  if (!res.ok || !res.body) {
    log(`full recall failed (http=${res.status}) — falling back to minimal`);
    res = await httpPost(
      "/engram/v1/recall",
      token,
      withNamespace({ query, sessionKey: sessionId, topK: 8, mode: "minimal", codingContext }),
      20000,
    );
    log(res.ok && res.body ? "minimal recall succeeded" : "minimal recall also failed");
  }

  let context;
  if (res.ok && res.body) {
    try {
      const d = JSON.parse(res.body);
      const ctx = d.context || "";
      const count = d.count || 0;
      const mode = d.mode || "";
      context = ctx
        ? `[Remnic Memory Recall — ${count} memories${mode ? `, ${mode} mode` : ""}]\n\n${ctx}`
        : "[Remnic: no relevant memories found for this session]";
    } catch {
      context = "[Remnic: recall parse error]";
    }
    log(`recall complete: ${context.split("\n")[0]}`);
  } else {
    context = "[Remnic: server unreachable — continuing without memory recall]";
    log(context);
  }

  emit({
    continue: true,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
  });
}

async function handleUserPromptRecall(input, token, log) {
  // No-token → bare continue (no banner noise on every prompt).
  if (!token) {
    emit({ continue: true });
    return;
  }
  const sessionId = input.session_id || "";
  const prompt = input.prompt || "";
  const wordCount = prompt.trim() ? prompt.trim().split(/\s+/).length : 0;
  if (wordCount < 4) {
    emit({ continue: true });
    return;
  }
  log(`session=${sessionId} words=${wordCount}`);

  const res = await httpPost(
    "/engram/v1/recall",
    token,
    withNamespace({ query: prompt, sessionKey: sessionId, topK: 8, mode: "minimal" }),
    20000,
  );
  if (!res.ok || !res.body) {
    log(`recall failed (http=${res.status})`);
    emit({ continue: true });
    return;
  }
  try {
    const d = JSON.parse(res.body);
    const ctx = d.context || "";
    const count = d.count || 0;
    if (!ctx || count === 0) {
      emit({ continue: true });
    } else {
      emit({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `<remnic-memory count="${count}">\n${ctx}\n</remnic-memory>`,
        },
      });
      log(`done: ${count} memories injected`);
    }
  } catch {
    emit({ continue: true });
  }
}

// Background worker: lock + cursor + observe the transcript delta. Detached
// from the foreground hook so a slow observe never blocks Codex past the
// PostToolUse timeout.
async function observeWorker(input, token, log) {
  const sessionId = input.session_id || "";
  const transcriptPath = input.transcript_path || "";
  const projectName = (input.cwd && path.basename(input.cwd)) || "unknown";
  const toolName = input.tool_name || "";

  if (!sessionId || /[^A-Za-z0-9._-]/.test(sessionId)) {
    log(`invalid session id: ${sessionId}`);
    return;
  }
  if (!transcriptPath || !fs.existsSync(transcriptPath) || !fs.statSync(transcriptPath).isFile()) {
    return;
  }
  const state = resolveState(sessionId, log);
  if (!state) return;
  const { cursorFile, lockFile } = state;

  if (!acquireLock(lockFile, log)) return;
  try {
    migrateTmpCursor(sessionId, cursorFile, log);
    const lastCount = readCursor(cursorFile, log);
    if (lastCount === null) return;

    let messages;
    try {
      messages = parseTranscript(transcriptPath);
    } catch {
      log(`parse failed for ${sessionId}`);
      return;
    }
    const newMessages = messages.slice(lastCount);
    if (newMessages.length === 0) {
      writeCursor(cursorFile, messages.length, log);
      return;
    }
    log(
      `observing ${newMessages.length} new messages (cursor ${lastCount}->${messages.length}) ` +
        `project=${projectName} tool=${toolName}`,
    );
    const res = await httpPost(
      "/engram/v1/observe",
      token,
      withNamespace({ sessionKey: sessionId, messages: newMessages }),
      120000,
    );
    if (res.ok) {
      log(`observe OK for ${sessionId}`);
      writeCursor(cursorFile, messages.length, log);
    } else {
      log(`observe failed (http=${res.status}) — cursor not advanced`);
    }
  } finally {
    releaseLock(lockFile);
  }
}

function handlePostToolObserve(rawInput, input, token, log) {
  // Return immediately — never block the tool.
  emit({ continue: true });
  if (!token) return;
  // Spawn a detached copy to do the observe in the background (mirrors the
  // original `( … ) & disown`). Pass the raw hook payload via the worker's
  // STDIN, not the environment — Windows caps the environment block at ~32 KB,
  // so large PostToolUse payloads (big file edits, command output) would fail
  // with E2BIG/ENAMETOOLONG and the observation would silently drop (#1443
  // review). Stdin has no comparable limit.
  try {
    const child = spawn(process.execPath, [__filename, OBSERVE_WORKER], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, REMNIC_HOOK_TOKEN: token },
    });
    child.on("error", (e) => log(`observe worker spawn error: ${e && e.message}`));
    child.stdin.on("error", () => {
      /* ignore EPIPE if the worker exits before we finish writing */
    });
    child.stdin.end(rawInput);
    child.unref();
  } catch (err) {
    log(`failed to spawn observe worker: ${err && err.message}`);
  }
}

async function handleSessionEnd(input, token, log) {
  // Acknowledge immediately.
  emit({ continue: true });

  const sessionId = input.session_id || "";
  const transcriptPath = input.transcript_path || "";
  const safe = sessionId !== "" && !/[^A-Za-z0-9._-]/.test(sessionId);

  let state = null;
  if (safe) state = resolveState(sessionId, log);

  let removeCursorAfterFlush = true;

  if (token && state && transcriptPath && fs.existsSync(transcriptPath)) {
    const { cursorFile } = state;
    migrateTmpCursor(sessionId, cursorFile, log);
    const lastCount = readCursor(cursorFile, log);
    if (lastCount === null) {
      log(`final flush skipped for ${sessionId} due to unsafe cursor`);
    } else {
      let newMessages = null;
      try {
        newMessages = parseTranscript(transcriptPath).slice(lastCount);
      } catch {
        log(`final flush parse failed for ${sessionId}; cursor retained for retry`);
        removeCursorAfterFlush = false;
      }
      if (newMessages && newMessages.length > 0) {
        log(`final flush for ${sessionId}`);
        const res = await httpPost(
          "/engram/v1/observe",
          token,
          withNamespace({ sessionKey: sessionId, messages: newMessages }),
          30000,
        );
        if (res.ok) {
          log(`final flush OK for ${sessionId}`);
        } else {
          // Critical: retain the cursor so the tail is retried, never lost.
          log(`final flush failed for ${sessionId} (http=${res.status}); cursor retained for retry`);
          removeCursorAfterFlush = false;
        }
      }
    }
  }

  // Cleanup — only remove the cursor when the flush succeeded or there was
  // nothing pending.
  if (state) {
    const { cursorFile, lockFile, legacyCursor, legacyLock } = state;
    if (removeCursorAfterFlush) removeCursor(cursorFile, log);
    releaseLock(lockFile);
    if (cursorFile !== legacyCursor) {
      try {
        const info = fs.lstatSync(legacyCursor);
        if (!info.isSymbolicLink()) fs.rmSync(legacyCursor, { force: true });
      } catch {
        /* absent */
      }
    }
    if (lockFile !== legacyLock) {
      try {
        fs.rmdirSync(legacyLock);
      } catch {
        /* absent */
      }
    }
  }

  runMaterialize(log);
}

// Drain any unobserved transcript tail to /engram/v1/observe under the
// session's cursor/lock, advancing the cursor only on a successful observe.
// Shared mid-session drain used by handlePreCompact (the session-end path in
// handleSessionEnd has its own cursor-removal cleanup and is intentionally not
// refactored onto this helper to avoid perturbing its retention semantics).
//
// Why this exists separately from the LCM flush: /engram/v1/lcm/compaction/flush
// can only drain work ALREADY queued by prior /observe calls. If a turn landed
// after the last PostToolUse (e.g. a long user prompt that triggers auto
// compaction without a Bash tool call in between), that tail is still only in
// the transcript and would be lost when Codex summarizes/replaces context. So
// PreCompact must observe the delta FIRST, then ask LCM to flush.
//
// Returns "busy" when the session lock could not be acquired within the
// caller's budget (a detached PostToolUse observe worker is still holding it),
// so handlePreCompact can SKIP the flush instead of letting it drain nothing
// and race the worker; true when the tail was observed (or nothing pending);
// false on parse/observe failure (cursor retained) so the caller can still
// flush already-queued work. Always fail-open.
//
// `lockRetries` (100ms each) bounds how long to wait for a busy worker.
// The observe body is scoped via withNamespace() so the tail lands on the same
// key the LCM flush drains (see the namespace chokepoint above).
async function drainTranscriptTail(sessionId, transcriptPath, token, log, lockRetries = 50) {
  const safe = sessionId !== "" && !/[^A-Za-z0-9._-]/.test(sessionId);
  if (!safe || !token || !transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }
  const state = resolveState(sessionId, log);
  if (!state) return false;
  const { cursorFile, lockFile } = state;
  // The lock guards against the detached post-tool observe worker racing this
  // drain. Wait up to the caller's budget for the worker to finish its /observe
  // and release the lock — once it does, either the worker already advanced the
  // cursor (nothing left to drain) or we observe the remaining delta, and in
  // both cases the subsequent flush sees all queued work. Only if the worker
  // outlasts our budget do we return "busy" so handlePreCompact SKIPS the flush
  // rather than racing ahead of the worker's in-flight /observe.
  if (!acquireLock(lockFile, log, lockRetries)) {
    log(`transcript tail drain skipped for ${sessionId}: lock busy (worker still running)`);
    return "busy";
  }
  try {
    migrateTmpCursor(sessionId, cursorFile, log);
    const lastCount = readCursor(cursorFile, log);
    if (lastCount === null) {
      log(`transcript tail drain skipped for ${sessionId}: unsafe cursor`);
      return false;
    }
    let newMessages;
    try {
      newMessages = parseTranscript(transcriptPath).slice(lastCount);
    } catch {
      log(`transcript tail parse failed for ${sessionId}; cursor retained`);
      return false;
    }
    if (newMessages.length === 0) return true;
    log(`transcript tail drain: ${newMessages.length} new message(s) for ${sessionId}`);
    const res = await httpPost(
      "/engram/v1/observe",
      token,
      withNamespace({ sessionKey: sessionId, messages: newMessages }),
      30000,
    );
    if (res.ok) {
      // Advance (not remove) the cursor — the session continues after compaction,
      // so the post-compact transcript must not re-observe this tail.
      writeCursor(cursorFile, lastCount + newMessages.length, log);
      return true;
    }
    log(`transcript tail drain failed for ${sessionId} (http=${res.status}); cursor retained`);
    return false;
  } finally {
    releaseLock(lockFile);
  }
}

// PreCompact (#1571) — coordinate with Remnic's LCM layer before Codex
// compacts the conversation. Mirrors @remnic/plugin-pi's session_before_compact
// handler, with one Codex-specific addition: because Codex observes
// asynchronously (PostToolUse on Bash + Stop), an unobserved transcript tail
// can exist when compaction fires mid-session. So we drain that tail to
// /engram/v1/observe FIRST, then POST /engram/v1/lcm/compaction/flush so the
// daemon flushes the now-complete observe buffer into long-term memory before
// the transcript is summarized. ALWAYS returns continue:true — a hook failure
// must never block Codex's compaction (the upstream contract notes
// continue:false stops the compact entirely), so this handler is fail-open
// end to end.
async function handlePreCompact(input, token, log) {
  const sessionId = input.session_id || "";
  const transcriptPath = input.transcript_path || "";
  const trigger = input.trigger || "auto";
  // Acknowledge first so Codex never waits on the network for compaction to
  // proceed — the drain + flush are best-effort coordination, not a gate.
  emit({ continue: true });
  if (!token) {
    log(`skipping pre-compact drain+flush: no token (session=${sessionId} trigger=${trigger})`);
    return;
  }
  // 1. Drain any unobserved transcript tail so it's archived before compaction.
  //    Wait up to PRECOMPACT_LOCK_RETRIES for a concurrent observe worker to
  //    release the session lock, so the flush below sees the worker's queued
  //    messages. If the worker outlasts us, drain returns "busy" and we SKIP
  //    the flush entirely — flushing now would drain nothing and the worker's
  //    in-flight observe would miss this compaction, so we defer to the next
  //    PreCompact/Stop rather than race.
  const drainResult = await drainTranscriptTail(
    sessionId,
    transcriptPath,
    token,
    log,
    PRECOMPACT_LOCK_RETRIES,
  );
  if (drainResult === "busy") {
    log(`skipping LCM flush: tail drain lock busy (session=${sessionId} trigger=${trigger}); deferring to next cycle`);
    return;
  }
  // 2. Ask the LCM layer to flush the (now-complete) observe buffer. The body is
  //    scoped via withNamespace() so it drains the same key the observes wrote.
  const res = await httpPost(
    "/engram/v1/lcm/compaction/flush",
    token,
    withNamespace({ sessionKey: sessionId }),
    20000,
  );
  if (res.ok) {
    log(`LCM compaction flush OK (session=${sessionId} trigger=${trigger})`);
  } else {
    // Fail-open: log and move on. Compaction proceeds regardless.
    log(`LCM compaction flush failed (http=${res.status}) — compaction proceeds`);
  }
}

// ── Codex-native memory materialization (#378) ─────────────────────────────
function runMaterialize(log) {
  if (process.env.REMNIC_CODEX_MATERIALIZE === "0") return;
  const hookDir = __dirname;

  // 1. explicit override → 2. packaged bin → 3. dev tsx fallback.
  let bin = process.env.REMNIC_CODEX_MATERIALIZE_BIN || "";
  if (!bin) {
    const candidate = path.join(hookDir, "..", "..", "bin", "materialize.cjs");
    try {
      if (fs.existsSync(candidate)) bin = fs.realpathSync(candidate);
    } catch {
      /* ignore */
    }
  }
  let repoRoot = process.env.REMNIC_REPO_ROOT || "";
  if (!repoRoot) {
    try {
      const candidateRoot = fs.realpathSync(path.join(hookDir, "..", "..", "..", ".."));
      if (fs.existsSync(path.join(candidateRoot, "scripts", "codex-materialize.ts"))) {
        repoRoot = candidateRoot;
      }
    } catch {
      /* ignore */
    }
  }

  // Force HOME to the home dir the runner resolved (HOME → USERPROFILE →
  // os.homedir()). The materializer resolves config paths from HOME and only
  // falls back to os.homedir(); on Windows, where HOME is typically unset,
  // passing it explicitly guarantees the child uses the SAME home as the hook
  // instead of diverging (#1443 review).
  const childEnv = { ...process.env, HOME };
  try {
    if (bin && fs.existsSync(bin)) {
      const r = spawnSync(process.execPath, [bin, "--reason", "session_end"], {
        stdio: "ignore",
        timeout: 60000,
        env: childEnv,
      });
      if (r.status !== 0) log(`codex-materialize session_end failed (packaged bin=${bin})`);
    } else if (repoRoot) {
      const r = spawnSync("npx", ["--yes", "tsx", "scripts/codex-materialize.ts", "--reason", "session_end"], {
        cwd: repoRoot,
        stdio: "ignore",
        timeout: 120000,
        shell: process.platform === "win32",
        env: childEnv,
      });
      if (r.status !== 0) log("codex-materialize session_end failed (dev script)");
    } else {
      log(`codex-materialize skipped — could not resolve packaged bin or REMNIC_REPO_ROOT (hook_dir=${hookDir})`);
    }
  } catch (err) {
    log(`codex-materialize error: ${err && err.message}`);
  }
}

// ── entrypoint ─────────────────────────────────────────────────────────────
async function main() {
  const event = process.argv[2] || "";

  // Detached background worker for post-tool-observe.
  if (event === OBSERVE_WORKER) {
    const log = makeLogger("post-tool-observe");
    try {
      const raw = readStdin();
      const input = parseInput(raw);
      const token = process.env.REMNIC_HOOK_TOKEN || resolveToken();
      if (token) await observeWorker(input, token, log);
    } catch (err) {
      log(`observe worker error: ${err && err.message}`);
    }
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(LOG_FILES, event)) {
    // Unknown event — fail open without side effects.
    emit({ continue: true });
    if (event) process.stderr.write(`remnic-codex-hook: unknown event "${event}"\n`);
    return;
  }

  const log = makeLogger(event);
  const raw = readStdin();
  const input = parseInput(raw);

  try {
    ensureMigrated();
    const token = resolveToken();
    switch (event) {
      case "session-start":
        await handleSessionStart(input, token, log);
        break;
      case "user-prompt-recall":
        await handleUserPromptRecall(input, token, log);
        break;
      case "post-tool-observe":
        handlePostToolObserve(raw, input, token, log);
        break;
      case "session-end":
        await handleSessionEnd(input, token, log);
        break;
      case "pre-compact":
        await handlePreCompact(input, token, log);
        break;
    }
  } catch (err) {
    log(`unhandled error in ${event}: ${err && err.message}`);
    // Best-effort fail-open: emit a bare continue only if we haven't already.
    if (!emitted) {
      try {
        emit({ continue: true });
      } catch {
        /* stdout already written */
      }
    }
  }
}

main();
