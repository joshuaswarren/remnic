#!/usr/bin/env node
/**
 * Remnic unified Claude Code hook runner (issue #1518).
 *
 * A single cross-platform Node.js implementation of all four Claude Code
 * hooks. Thin `.sh` (POSIX) and `.ps1` (Windows) wrappers exec this file with
 * the event name as argv[2]:
 *
 *   node remnic-cc-hook.cjs <event>
 *
 * Events: session-start | user-prompt-recall | post-tool-observe | session-end
 *
 * This is a faithful port of the original four bash scripts — same endpoints,
 * env vars, token resolution, cursor/lock hardening, engram→remnic migration,
 * daemon health/auto-start, and git coding-context projectId derivation. Node
 * replaces the per-script `node -e` one-liners and Unix tools
 * (curl/git/sed/mktemp/…) so the exact same logic runs on Windows, macOS, and
 * Linux. This mirrors the proven @remnic/plugin-codex runner (issue #1440);
 * the only differences are the client-id header, token connector priority,
 * log tags, and the absence of Codex-native memory materialization.
 *
 * Security note (issue #1518 "guard shell interpolation"): every value that
 * originates from the hook payload (session id, cwd, transcript path, prompt,
 * tool name) is passed to child processes via argv or stdin — NEVER via a
 * string-interpolated shell command. `spawn`/`spawnSync` are called with
 * fixed literal argument arrays and `shell: false` (except on Windows, where
 * `.cmd` shims require `shell: true` with fixed literal args), so a payload
 * field containing shell metacharacters cannot achieve command injection.
 *
 * Fail-open everywhere: any unexpected error degrades to `{"continue":true}`.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync, spawn, spawnSync } = require("child_process");

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const HOST = process.env.REMNIC_HOST || process.env.ENGRAM_HOST || "127.0.0.1";
const PORT = process.env.REMNIC_PORT || process.env.ENGRAM_PORT || "4318";

// Internal re-entrant mode: post-tool-observe spawns a detached copy of itself
// so the (slow) observe runs in the background and never blocks Claude Code
// past the short PostToolUse timeout — mirroring the original `( … ) & disown`.
const OBSERVE_WORKER = "__observe-worker__";

const LOG_FILES = {
  "session-start": "remnic-session-recall.log",
  "user-prompt-recall": "remnic-user-prompt-recall.log",
  "post-tool-observe": "remnic-post-tool-observe.log",
  "session-end": "remnic-cc-session-end.log",
};
const LOG_TAGS = {
  "session-start": "cc-session-start",
  "user-prompt-recall": "cc-user-prompt",
  "post-tool-observe": "cc-post-tool",
  "session-end": "cc-stop",
};

function makeLogger(event) {
  const file = path.join(HOME, ".remnic", "logs", LOG_FILES[event] || "remnic-cc-hook.log");
  const tag = LOG_TAGS[event] || "cc-hook";
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
  // Claude Code on fd 0; the detached observe worker gets it from the pipe the
  // foreground writes. We deliberately do NOT consult an env var here — an
  // inherited REMNIC_HOOK_INPUT in the parent environment would otherwise
  // override the piped payload and the worker could observe stale/empty input.
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
    // distinguish "missing" from "migration failed".
    // On Windows the CLIs are `.cmd` shims, which Node can only launch via a
    // shell. Timeout is 5 min so a large migration can complete. Args are
    // fixed literals — safe under a shell.
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
// asynchronously via 'error', so a naive try/break can't see it.
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
// and never mints a connector token — without it the health probe 401s and
// the hook wrongly reports "daemon not running", silently skipping
// recall/observe.
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
        (byConnector("claude-code") || {}).token ||
        (byConnector("openclaw") || {}).token ||
        store["claude-code"] ||
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

// ── HTTP helpers — return a real success signal (2xx) so callers can decide
// whether to advance/clear the cursor. ─────────────────────────────────────
function httpPost(urlPath, token, bodyObj, timeoutMs) {
  return new Promise((resolve) => {
    let data;
    try {
      // Namespace targeting for namespaced daemons: when REMNIC_NAMESPACE (or
      // ENGRAM_NAMESPACE) is set, include it in the request body. On the REST
      // surface the namespace is read from the body, not a header, and the
      // "claude-code" client id otherwise resolves to the adapter's own
      // (empty) namespace — so recall/observe silently return nothing. Opt-in:
      // when the env var is unset this is a no-op and behaviour is unchanged.
      // An explicit bodyObj.namespace still takes precedence.
      const ns = process.env.REMNIC_NAMESPACE || process.env.ENGRAM_NAMESPACE;
      const outBody =
        ns && bodyObj && typeof bodyObj === "object" && !Array.isArray(bodyObj)
          ? { namespace: ns, ...bodyObj }
          : bodyObj;
      data = Buffer.from(JSON.stringify(outBody), "utf8");
    } catch {
      resolve({ ok: false, status: 0, body: "" });
      return;
    }
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: urlPath,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Engram-Client-Id": "claude-code",
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
// When the daemon has an auth token configured (REMNIC_AUTH_TOKEN), every
// route — including /engram/v1/health — returns 401 to unauthenticated
// requests, so an unauthenticated probe makes the hook wrongly report
// "daemon not running" and skip recall/observe. Unauthenticated daemons
// ignore the header.
function httpHealthy(timeoutMs, token) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: "/engram/v1/health",
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

// Adopt a higher os.tmpdir() cursor written by an older/cross-process run.
function migrateTmpCursor(sessionId, cursorFile, log) {
  for (const tmp of [
    path.join(os.tmpdir(), `remnic-cursor-${sessionId}`),
    path.join(os.tmpdir(), `engram-cursor-${sessionId}`),
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
function acquireLock(lockFile, log) {
  for (let i = 0; i < 50; i++) {
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
    // pre-check the binary with onPath() instead of relying on try/break.
    for (const bin of ["remnic", "engram"]) {
      if (!onPath(bin)) continue;
      try {
        // Windows: `remnic`/`engram` are `.cmd` shims, which Node can only
        // launch via a shell. Args are fixed literals — safe.
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
        additionalContext: "[Remnic: no auth token — run: remnic connectors install claude-code]",
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
    { query, sessionKey: sessionId, topK: 12, mode: "auto", codingContext },
    45000,
  );
  if (!res.ok || !res.body) {
    log(`full recall failed (http=${res.status}) — falling back to minimal`);
    res = await httpPost(
      "/engram/v1/recall",
      token,
      { query, sessionKey: sessionId, topK: 8, mode: "minimal", codingContext },
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
    { query: prompt, sessionKey: sessionId, topK: 8, mode: "minimal" },
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
// from the foreground hook so a slow observe never blocks Claude Code past the
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
      { sessionKey: sessionId, messages: newMessages },
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
  // with E2BIG/ENAMETOOLONG and the observation would silently drop. Stdin has
  // no comparable limit.
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

  // NOTE: Claude Code does not currently emit a Stop/SessionEnd event. This
  // handler runs only when invoked manually or once Claude Code adds the
  // event. It is kept here so the final-flush + cursor-cleanup parity with
  // the Codex runner is in place from day one (issue #1518).
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
          { sessionKey: sessionId, messages: newMessages },
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
    if (event) process.stderr.write(`remnic-cc-hook: unknown event "${event}"\n`);
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
