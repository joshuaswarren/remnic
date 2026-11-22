"use strict";

/**
 * Shared Remnic host hook runner (issues #1440, #1518, #2483).
 *
 * One parameterized cross-platform Node.js implementation of the host hook
 * contract (session-start | user-prompt-recall | post-tool-observe |
 * session-end [+ pre-compact where the host emits it]). Each host package
 * ships a byte-identical copy of this file next to a thin wrapper that calls
 * `run(config)` with the per-host knobs: client id, token connector
 * priority, connector install hint, log file/tag names, and the Codex-only
 * events (pre-compact drain+flush, session-end materialization).
 *
 * CANONICAL SOURCE: scripts/hook-runner/remnic-hook-core.cjs. The copies in
 * packages/plugin-claude-code/hooks/bin/ and packages/plugin-codex/hooks/bin/
 * are generated — edit the canonical file, then run
 * `npm run sync:hook-runner` (CI fails on drift via
 * `npm run check:hook-runner-sync`).
 *
 * Fail-open everywhere: any unexpected error degrades to `{"continue":true}`.
 *
 * Security note (issue #1518 "guard shell interpolation"): every value that
 * originates from the hook payload (session id, cwd, transcript path, prompt,
 * tool name) is passed to child processes via argv or stdin — NEVER via a
 * string-interpolated shell command. `spawn`/`spawnSync` are called with
 * fixed literal argument arrays and `shell: false` (except on Windows, where
 * `.cmd` shims require `shell: true` with fixed literal args), so a payload
 * field containing shell metacharacters cannot achieve command injection.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFileSync, spawn, spawnSync } = require("child_process");

// it re-enters through the same per-host config. When the core is required
// by a wrapper, `require.main` is the wrapper's module.
const ENTRY_FILE = (require.main && require.main.filename) || __filename;

function run(config) {
  const CLIENT_ID = config.client;
  const TOKEN_CONNECTORS = config.tokenConnectors;
  const CONNECTOR_INSTALL = config.connectorInstall;
  const PROG_NAME = config.progName;
  const LOG_FILES = config.logFiles;
  const LOG_TAGS = config.logTags;
  const DEFAULT_LOG_FILE = config.defaultLogFile;
  // agy, "DEVIN_PROJECT_DIR" for Devin). The active host's variable wins so
  // a stray cross-host variable cannot reroute another host's recall; the
  // shared fallbacks below only apply when the host's own variable is unset.
  const PROJECT_DIR_ENV = config.projectDirEnv || "";

  const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

  // @remnic/plugin-pi's `remnicDaemonUrl`). A full REMNIC_DAEMON_URL
  // (e.g. "http://host.tailnet:4318" or "https://remnic.internal:443")
  // takes precedence and lets a host talk to a shared central daemon over
  // Tailscale/LAN/VPN. The legacy REMNIC_HOST/REMNIC_PORT pair remains
  // supported as a backward-compat fallback so existing installs and the
  // test harness (which spins a mock on 127.0.0.1:<port>) keep working.
  const RAW_DAEMON_URL = process.env.REMNIC_DAEMON_URL || process.env.ENGRAM_DAEMON_URL || "";
  const HOST = process.env.REMNIC_HOST || process.env.ENGRAM_HOST || "127.0.0.1";
  const PORT = process.env.REMNIC_PORT || process.env.ENGRAM_PORT || "4318";

  // for TLS daemons (common for remote/private deployments behind a proxy).
  //
  // An EXPLICIT but invalid REMNIC_DAEMON_URL (missing scheme, typo, e.g.
  // "host:4318") must NOT silently fall through to REMNIC_HOST/REMNIC_PORT —
  // that would route recall/observe/flush to a local daemon and corrupt the
  // wrong memory store. Instead we disable the daemon entirely (all HTTP
  // calls fail open) and surface the misconfiguration once on stderr so the
  // operator fixes the URL rather than debugging silent cross-store writes
  // (#1571 review).
  let DAEMON_CONFIG_ERROR = "";
  const DAEMON_URL = (function resolveDaemonUrl() {
    if (RAW_DAEMON_URL) {
      try {
        const parsed = new URL(RAW_DAEMON_URL);
        // protocol "host:" and would otherwise silently route to localhost.
        if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed;
      } catch {
        /* handled below */
      }
      DAEMON_CONFIG_ERROR =
        'REMNIC_DAEMON_URL="' + RAW_DAEMON_URL + '" is not a valid http(s) URL — ' +
        "daemon disabled (recall/observe/flush will no-op). Set a valid " +
        "http(s):// URL or unset REMNIC_DAEMON_URL to use REMNIC_HOST/REMNIC_PORT.";
      if (process.env.REMNIC_HOOK_QUIET !== "1") {
        try { process.stderr.write(`[${PROG_NAME}] ${DAEMON_CONFIG_ERROR}\n`); } catch {}
      }
      return null;
    }
    try {
      return new URL(`http://${HOST}:${PORT}`);
    } catch {
      return new URL("http://127.0.0.1:4318");
    }
  })();

  // REMNIC_DAEMON_URL=http://gw/remnic). Mirrors plugin-pi's daemon-URL +
  // route concatenation — without this, a path-qualified base URL has its
  // prefix silently dropped and requests hit the host root (#1571 review).
  // Trailing slashes are stripped so "/remnic/" + "/engram/v1/observe"
  // becomes "/remnic/engram/v1/observe"; a bare root ("/") yields "".
  const DAEMON_BASE_PATH = DAEMON_URL ? DAEMON_URL.pathname.replace(/\/+$/, "") : "";

  // URL.hostname keeps the brackets on IPv6 literals ("[::1]"); Node's
  // http(s).request options.hostname does not accept them, so strip them
  // once here for every request path below.
  const DAEMON_HOSTNAME = DAEMON_URL
    ? DAEMON_URL.hostname.replace(/^\[|\]$/g, "")
    : "";

  // cleartext. Remote-daemon-over-http is a supported deployment shape
  // (trusted LAN/Tailscale), so this warns rather than refuses — but the
  // operator should see the exposure once per hook invocation batch.
  if (DAEMON_URL && DAEMON_URL.protocol === "http:" && !isLoopbackHost(DAEMON_HOSTNAME)) {
    if (process.env.REMNIC_HOOK_QUIET !== "1") {
      try {
        process.stderr.write(
          `[${PROG_NAME}] REMNIC_DAEMON_URL uses plain http:// to a non-loopback host; ` +
            "the bearer token will be sent cleartext — prefer https:// for remote daemons.\n",
        );
      } catch {}
    }
  }

  function isLoopbackHost(hostname) {
    const h = (hostname || "").toLowerCase();
    if (h === "localhost") return true;
    if (h === "::1") return true;
    return /^127(?:\.\d{1,3}){3}$/.test(h);
  }

  // itself so the (slow) observe runs in the background and never blocks the
  // host past the short PostToolUse timeout — mirroring the original
  // `( … ) & disown`.
  const OBSERVE_WORKER = "__observe-worker__";

  // contention. The foreground session-end hook gives up after ~5s so the
  // host is never blocked; this worker waits longer for a still-running
  // observe worker to release the session lock, then performs the same
  // drain + cursor cleanup.
  const SESSION_END_DRAIN = "__session-end-drain__";

  // drain: an in-flight observe worker's /engram/v1/observe can take up to
  // 120s, so the drain waits roughly that long before giving up and leaving
  // cursor state for the stale-lock reaper.
  const _sedRaw = process.env.REMNIC_SESSION_END_DRAIN_LOCK_RETRIES;
  const _sedParsed = _sedRaw != null && _sedRaw !== "" ? Number.parseInt(_sedRaw, 10) : 1200;
  const SESSION_END_DRAIN_LOCK_RETRIES = Number.isFinite(_sedParsed) && _sedParsed >= 0 ? _sedParsed : 1200;

  // long handlePreCompact waits for a detached PostToolUse observe worker
  // (whose own /observe can run up to 120s) to release the session lock
  // before skipping the drain+flush. 15s covers a typical observe round-trip
  // on a healthy daemon; a pathologically slow worker that outlasts this is
  // left for the next cycle rather than blocking compaction indefinitely.
  const _pcRaw = process.env.REMNIC_PRECOMPACT_LOCK_RETRIES;
  const _pcParsed = _pcRaw != null && _pcRaw !== "" ? Number.parseInt(_pcRaw, 10) : 150;
  const PRECOMPACT_LOCK_RETRIES = Number.isFinite(_pcParsed) && _pcParsed >= 0 ? _pcParsed : 150;

  function makeLogger(event) {
    const file = path.join(HOME, ".remnic", "logs", LOG_FILES[event] || DEFAULT_LOG_FILE);
    const tag = LOG_TAGS[event] || PROG_NAME;
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
    // the host on fd 0; the detached observe worker gets it from the pipe the
    // foreground writes. We deliberately do NOT consult an env var here — an
    // inherited REMNIC_HOOK_INPUT in the parent environment would otherwise
    // override the piped payload and the worker could observe stale/empty
    // input (#1443 review).
    try {
      return fs.readFileSync(0, "utf8");
    } catch {
      return "";
    }
  }

  // Antigravity CLI documents camelCase payload fields (conversationId,
  // transcriptPath, lastUserInput). Apply them only when the snake_case key
  // is absent so existing host payloads are unchanged.
  // JSON.parse only yields plain objects, arrays, and primitives, so
  // Object.prototype.toString is the exact string test here.
  function isHookString(v) {
    return Object.prototype.toString.call(v) === "[object String]";
  }

  function normalizeHookInput(input) {
    if (input.session_id === undefined || input.session_id === "") {
      if (isHookString(input.conversationId) && input.conversationId) {
        input.session_id = input.conversationId;
      }
    }
    if (input.prompt === undefined || input.prompt === "") {
      if (isHookString(input.lastUserInput) && input.lastUserInput) {
        input.prompt = input.lastUserInput;
      }
    }
    return input;
  }

  function parseInput(raw) {
    try {
      const d = JSON.parse(raw);
      return d && typeof d === "object" ? d : {};
    } catch {
      return {};
    }
  }

  function ensureMigrated() {
    try {
      if (fs.existsSync(path.join(HOME, ".remnic", ".migrated-from-engram"))) return;
      const hasEngram =
        fs.existsSync(path.join(HOME, ".engram")) ||
        fs.existsSync(path.join(HOME, ".config", "engram", "config.json"));
      if (!hasEngram) return;
      // Try `remnic` first, fall through to legacy `engram` when missing on
      // PATH. Pre-check PATH with onPath() (which is .cmd/.exe-aware on
      // Windows) rather than relying on spawnSync ENOENT — under `shell: true`
      // a missing command yields a non-zero shell exit, not ENOENT, so an
      // exit-code check couldn't distinguish "missing" from "migration
      // failed" (#1443 review). On Windows the CLIs are `.cmd` shims, which
      // Node can only launch via a shell. Timeout is 5 min so a large
      // migration can complete. Args are fixed literals — safe under a shell.
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
  // asynchronously via 'error', so a naive try/break can't see it (#1443
  // review).
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

  // names (OPENCLAW_REMNIC_ACCESS_TOKEN, REMNIC_AUTH_TOKEN) before the two
  // legacy aliases (OPENCLAW_ENGRAM_ACCESS_TOKEN, ENGRAM_AUTH_TOKEN), so a
  // stale leftover from a pre-rename install cannot outrank the credential
  // the daemon is actually running with. REMNIC_AUTH_TOKEN matters because
  // the documented standalone-server setup authenticates the daemon with it
  // alone and never mints a connector token — without it the health probe
  // 401s and the hook wrongly reports "daemon not running", silently
  // skipping recall/observe.
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
        // lookups in TOKEN_CONNECTORS order, then the same order against the
        // legacy flat store keys.
        let tok = "";
        for (const c of TOKEN_CONNECTORS) {
          const t = (byConnector(c) || {}).token;
          if (t) {
            tok = t;
            break;
          }
        }
        if (!tok) {
          for (const c of TOKEN_CONNECTORS) {
            if (store[c]) {
              tok = store[c];
              break;
            }
          }
        }
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

  // whether to advance/clear the cursor (fixes the data-loss bug in #1442).
  //
  // All requests route through the parsed DAEMON_URL (#1571), so a host can
  // target a remote/central daemon (Tailscale/LAN/VPN, plain or TLS) by
  // setting REMNIC_DAEMON_URL — same transport contract as @remnic/plugin-pi.
  //
  // Namespace chokepoint (#1571): every observe/recall/flush body carries the
  // optional REMNIC_NAMESPACE / ENGRAM_NAMESPACE override so a namespaced
  // install archives + flushes under one key — without it, buffered
  // observations land on the default key while a namespaced flush drains a
  // different (empty) queue, and most in-session memory never flushes before
  // compaction. An explicit bodyObj.namespace still takes precedence.
  // One deadline for the whole request: connect, response headers, and body.
  // req.setTimeout() is an idle timer that does not arm until the socket
  // connects and restarts on every byte, so a daemon address that drops
  // packets, or a front that accepts and then trickles, held the hook far
  // past its budget. On expiry the request is destroyed and `onTimeout`
  // reports the same failure the caller already handles for a dead daemon.
  function armRequestDeadline(req, timeoutMs, onTimeout) {
    const timer = setTimeout(() => {
      req.destroy();
      onTimeout();
    }, timeoutMs);
    req.on("close", () => clearTimeout(timer));
  }

  function httpPost(urlPath, token, bodyObj, timeoutMs) {
    if (DAEMON_URL === null) {
      // resolveDaemonUrl). Callers treat this like a dead daemon.
      return Promise.resolve({ ok: false, status: 0, body: "" });
    }
    const transport = DAEMON_URL.protocol === "https:" ? https : http;
    return new Promise((resolve) => {
      let data;
      try {
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
      const req = transport.request(
        {
          protocol: DAEMON_URL.protocol,
          hostname: DAEMON_HOSTNAME,
          port: DAEMON_URL.port || (DAEMON_URL.protocol === "https:" ? 443 : 80),
          path: DAEMON_BASE_PATH + urlPath,
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Engram-Client-Id": CLIENT_ID,
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
      armRequestDeadline(req, timeoutMs, () => resolve({ ok: false, status: 0, body: "" }));
      req.write(data);
      req.end();
    });
  }

  // resolveToken() call: the probe must authenticate with the exact bearer
  // the operation it gates will send. Re-resolving could pick up a rotated
  // tokens.json (or an inherited REMNIC_HOOK_TOKEN the foreground handlers
  // ignore) and green-light a probe whose recall then 401s.
  //
  // When the daemon has an auth token configured, every route — including
  // /engram/v1/live — returns 401 to unauthenticated requests, so an
  // unauthenticated probe makes the hook wrongly report "daemon not running"
  // and skip recall/observe. Unauthenticated daemons ignore the header.
  //
  // One aggregate budget: readiness-gated /engram/v1/live first, and only a
  // 404 (daemon predating the live route) retries the legacy diagnostic
  // /engram/v1/health with the remaining time. 401/503 are final answers.
  // Diagnostic health can outlive this liveness probe's deadline, which is
  // why the gate probes liveness at all (#3257).
  function httpHealthy(timeoutMs, token) {
    if (DAEMON_URL === null) return Promise.resolve(false);
    const transport = DAEMON_URL.protocol === "https:" ? https : http;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const deadline = Date.now() + timeoutMs;
    const probe = (path, budget) => new Promise((resolve) => {
      const req = transport.request(
        {
          protocol: DAEMON_URL.protocol,
          hostname: DAEMON_HOSTNAME,
          port: DAEMON_URL.port || (DAEMON_URL.protocol === "https:" ? 443 : 80),
          path: DAEMON_BASE_PATH + path,
          method: "GET",
          headers,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode || 0);
        },
      );
      req.on("error", () => resolve(0));
      armRequestDeadline(req, budget, () => resolve(0));
      req.end();
    });
    return probe("/engram/v1/live", timeoutMs).then((status) => {
      if (status !== 404) return status >= 200 && status < 300;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      return probe("/engram/v1/health", remaining).then((legacy) => legacy >= 200 && legacy < 300);
    });
  }

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

  // JSONL hosts (Claude Code, Codex): one JSON object per line with
  // {type:"user"|"assistant", message:{role, content}}.
  function parseJsonlTranscript(transcriptPath) {
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

  // ATIF hosts (Devin CLI): a single JSON document
  // {schema_version, session_id, steps:[{source, message, tool_calls,
  // observation, ...}]}. Agent steps carry tool_calls and observation
  // results alongside the assistant text; we fold a bounded rendering of
  // both into the observed content so tool activity reaches memory, not
  // just prose. System steps are skipped (they are prompt scaffolding).
  const ATIF_MESSAGE_CAP = 8000;
  const ATIF_TOOL_CALL_ARG_CAP = 500;
  const ATIF_TOOL_RESULT_CAP = 2000;
  // JSON.parse only yields plain objects, arrays, and primitives, so
  // `instanceof Object && !Array.isArray` is an exact plain-object test.
  function isJsonObject(v) {
    return v instanceof Object && !Array.isArray(v);
  }
  function isString(v) {
    return Object.prototype.toString.call(v) === "[object String]";
  }
  // ATIF `message` and `content` are a string or an array of ContentPart
  // objects. Return the concatenated text of text parts; images are skipped.
  function atifText(v) {
    if (isString(v)) return v;
    if (!Array.isArray(v)) return "";
    return v
      .filter((p) => isJsonObject(p) && p.type === "text" && isString(p.text))
      .map((p) => p.text)
      .join("\n");
  }
  function parseAtifTranscript(transcriptPath) {
    const doc = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));
    const steps = doc && Array.isArray(doc.steps) ? doc.steps : [];
    const messages = [];
    for (const step of steps) {
      if (!isJsonObject(step)) continue;
      const source = step.source;
      if (source !== "user" && source !== "agent") continue;
      const parts = [];
      const message = atifText(step.message).trim();
      if (message) {
        parts.push(message);
      }
      if (source === "agent") {
        const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        for (const tc of toolCalls) {
          if (!isJsonObject(tc)) continue;
          const name = tc.function_name || tc.name || "tool";
          let argStr = "";
          try {
            argStr = isString(tc.arguments)
              ? tc.arguments
              : JSON.stringify(tc.arguments);
          } catch {
            argStr = "";
          }
          if (argStr && argStr !== "{}") {
            parts.push(`[tool call] ${name}(${argStr.slice(0, ATIF_TOOL_CALL_ARG_CAP)})`);
          } else {
            parts.push(`[tool call] ${name}`);
          }
        }
        const results =
          step.observation && Array.isArray(step.observation.results)
            ? step.observation.results
            : [];
        for (const r of results) {
          const content = isJsonObject(r) ? atifText(r.content) : "";
          if (content.trim()) {
            parts.push(`[tool result] ${content.trim().slice(0, ATIF_TOOL_RESULT_CAP)}`);
          }
        }
      }
      const content = parts.join("\n").trim();
      if (!content) continue;
      messages.push({
        role: source === "user" ? "user" : "assistant",
        content: content.slice(0, ATIF_MESSAGE_CAP),
      });
    }
    return messages;
  }

  function parseTranscript(transcriptPath) {
    // Hosts with non-file transcripts (agy: SQLite conversation db) can
    // supply config.parseTranscript(transcriptPath) to decode them. The
    // override must return the same [{role, content}] shape in stable order
    // so cursor counting works unchanged.
    if (config.parseTranscript instanceof Function) {
      const custom = config.parseTranscript(transcriptPath);
      if (custom !== undefined) return custom;
    }
    if (config.transcriptFormat === "atif") return parseAtifTranscript(transcriptPath);
    return parseJsonlTranscript(transcriptPath);
  }

  // Hosts that do not put transcript_path in the hook payload (Devin CLI)
  // can supply config.resolveTranscriptPath(input) to derive it — e.g. from
  // the session id and a well-known transcript directory.
  function transcriptPathFor(input) {
    // Antigravity CLI documents camelCase payload fields (transcriptPath);
    // snake_case wins when both are present so existing hosts are unchanged.
    const transcriptPath = input.transcript_path || input.transcriptPath || "";
    if (isString(transcriptPath) && transcriptPath) {
      // A payload path that exists is authoritative. A missing path falls
      // through to the host resolver: agy sends a transcriptPath pointing
      // at a .jsonl file that never materializes, while the real transcript
      // lives in the host-resolved SQLite db.
      try {
        if (fs.existsSync(transcriptPath) && fs.statSync(transcriptPath).isFile()) {
          return transcriptPath;
        }
      } catch {
        /* fall through to host resolver */
      }
    }
    if (config.resolveTranscriptPath instanceof Function) {
      try {
        const resolved = config.resolveTranscriptPath(input);
        return isString(resolved) ? resolved : "";
      } catch {
        return "";
      }
    }
    return "";
  }

  // env var (Devin: DEVIN_PROJECT_DIR; Claude Code compat: CLAUDE_PROJECT_DIR;
  // Antigravity: AGY_PROJECT_DIR).
  // Hosts that omit cwd from the hook payload still export a project-dir
  // env var. The active host's variable (config.projectDirEnv) wins; the
  // shared fallbacks preserve the pre-existing hosts' behavior when the
  // host's own variable is unset. AGY_PROJECT_DIR is intentionally absent
  // from the shared fallback — agy reaches it through its own projectDirEnv,
  // so a stray AGY variable can never reroute another host's recall.
  function cwdFor(input) {
    const cwd = input.cwd || "";
    if (isString(cwd) && cwd) return cwd;
    if (PROJECT_DIR_ENV && isString(process.env[PROJECT_DIR_ENV]) && process.env[PROJECT_DIR_ENV]) {
      return process.env[PROJECT_DIR_ENV];
    }
    return process.env.DEVIN_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || "";
  }

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
    const doneFile = path.join(stateDir, `remnic-done-${sessionId}`);
    return { cursorFile, lockFile, doneFile, legacyCursor, legacyLock };
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

  // flush succeeds (or there is nothing left to flush). Its content is the
  // observed-message checkpoint, which handleSessionStart restores into the
  // cursor when a session resumes under the same id. Detached observe
  // workers queued behind the session lock check this under the lock and
  // exit instead of treating the missing cursor as 0 and replaying the
  // whole transcript. The file is tiny and persists for the life of the
  // state dir, like leftover locks from crashed sessions.
  function sessionDone(doneFile) {
    try {
      const info = fs.lstatSync(doneFile);
      return !info.isSymbolicLink() && info.isFile() && ownedByUs(info);
    } catch {
      return false;
    }
  }

  function markSessionDone(doneFile, checkpoint, log) {
    try {
      const tmp = `${doneFile}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, `${checkpoint}\n`, { mode: 0o600 });
      fs.renameSync(tmp, doneFile);
      return true;
    } catch (err) {
      log(`failed to write session-done marker ${doneFile}: ${err && err.message}`);
      return false;
    }
  }

  function readDoneCheckpoint(doneFile) {
    try {
      const n = parseInt(fs.readFileSync(doneFile, "utf8").trim(), 10);
      return Number.isFinite(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  // Adopt a higher os.tmpdir() (or /tmp) cursor written by an older
  // cross-process run, then clean.
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


  async function handleSessionStart(input, token, log) {
    const sessionId = input.session_id || "";
    const cwd = cwdFor(input);
    const projectName = (cwd && path.basename(cwd)) || "unknown";
    const codingContext = resolveCodingContext(cwd);
    log(`session=${sessionId} project=${projectName} coding-context=${codingContext ? "yes" : ""}`);

    // Claude Code reuse the id across resume. Restore the observation
    // checkpoint stored in the done tombstone into the cursor, then clear
    // the tombstone so queued and future workers observe the new tail
    // instead of exiting early. Without this, a resumed session would never
    // observe again.
    if (sessionId && !/[^A-Za-z0-9._-]/.test(sessionId)) {
      const st = resolveState(sessionId, log);
      if (st && sessionDone(st.doneFile)) {
        const checkpoint = readDoneCheckpoint(st.doneFile);
        if (checkpoint !== null) writeCursor(st.cursorFile, checkpoint, log);
        try {
          fs.rmSync(st.doneFile, { force: true });
        } catch {
          /* best effort */
        }
        log(`cleared done marker for session ${sessionId} (checkpoint=${checkpoint})`);
      }
    }

    if (!(await httpHealthy(2000, token))) {
      log("daemon not responding, attempting start...");
      // Try `remnic` first, fall through to legacy `engram` when only the
      // older CLI is on PATH. spawn() emits ENOENT *asynchronously* via
      // 'error', so we pre-check the binary with onPath() instead of relying
      // on try/break (#1443 review — the bare try/break never reached
      // `engram`).
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
          additionalContext: `[Remnic: no auth token — run: remnic connectors install ${CONNECTOR_INSTALL}]`,
        },
      });
      return;
    }

    const query =
      `Starting a new coding session in project: ${projectName}. ` +
      "Recall relevant memories, preferences, decisions, patterns, and context about this project and the user.";

    // is cleared when a session moves out of a repo.
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

  // from the foreground hook so a slow observe never blocks the host past the
  // PostToolUse timeout.
  async function observeWorker(input, token, log) {
    const sessionId = input.session_id || "";
    const transcriptPath = transcriptPathFor(input);
    const projectName = (cwdFor(input) && path.basename(cwdFor(input))) || "unknown";
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
      // cursor must not treat the missing cursor as 0 and replay the whole
      // transcript — the done tombstone marks completed sessions.
      if (sessionDone(state.doneFile)) {
        log(`session ${sessionId} already flushed; skipping queued observe`);
        return;
      }
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

  function handlePostToolObserve(input, token, log, rawInput) {
    emit({ continue: true });
    if (!token) return;
    // original `( … ) & disown`). Pass the raw hook payload via the worker's
    // STDIN, not the environment — Windows caps the environment block at
    // ~32 KB, so large PostToolUse payloads (big file edits, command output)
    // would fail with E2BIG/ENAMETOOLONG and the observation would silently
    // drop (#1443 review). Stdin has no comparable limit.
    try {
      const child = spawn(process.execPath, [ENTRY_FILE, OBSERVE_WORKER], {
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

  async function handleSessionEnd(input, token, log, raw, opts) {
    const drainRetry = !!(opts && opts.drainRetry);
    emit({ continue: true });

    const sessionId = input.session_id || "";
    const transcriptPath = transcriptPathFor(input);
    const safe = sessionId !== "" && !/[^A-Za-z0-9._-]/.test(sessionId);

    let state = null;
    if (safe) state = resolveState(sessionId, log);

    // still-running detached observe worker cannot race the cursor read,
    // duplicate the tail observation, or have its lock removed mid-flight.
    // The foreground hook waits ~5s; on contention it hands the drain to a
    // detached worker with a much longer budget so messages that land after
    // the in-flight worker's snapshot are still observed before the session
    // state is cleaned up. If even that worker gives up, cursor and lock stay
    // for the stale-lock reaper — a forced cleanup could drop queued work.
    let lockAcquired = false;
    if (state) {
      lockAcquired = acquireLock(
        state.lockFile,
        log,
        drainRetry ? SESSION_END_DRAIN_LOCK_RETRIES : 50,
      );
      if (!lockAcquired) {
        log(`final flush skipped for ${sessionId}: session lock busy`);
        if (!drainRetry && raw) {
          try {
            const child = spawn(process.execPath, [ENTRY_FILE, SESSION_END_DRAIN], {
              detached: true,
              stdio: ["pipe", "ignore", "ignore"],
              env: { ...process.env, REMNIC_HOOK_TOKEN: token || "" },
            });
            child.on("error", (e) => log(`session-end drain spawn error: ${e && e.message}`));
            child.stdin.on("error", () => {
              /* ignore EPIPE if the worker exits before we finish writing */
            });
            child.stdin.end(raw);
            child.unref();
          } catch (err) {
            log(`failed to spawn session-end drain: ${err && err.message}`);
          }
        }
        if (config.enableMaterialize && !drainRetry) runMaterialize(log);
        return;
      }
    }

    // empty — the done tombstone (which stores the observed-message
    // checkpoint) is written solely then. The cursor is removed only after
    // the marker lands; if marker creation fails the checkpointed cursor
    // stays, so a queued worker reads the observed count instead of
    // replaying from 0. When the drain cannot run at all (no token, no
    // transcript, unsafe cursor, parse or observe failure) neither the
    // marker nor the cursor changes, leaving state intact for a retry.
    let finalized = false;
    let checkpoint = 0;

    try {
      if (state && sessionDone(state.doneFile)) {
        log(`final flush skipped for ${sessionId}: session already marked done`);
      } else if (state && token && transcriptPath && fs.existsSync(transcriptPath)) {
        const { cursorFile } = state;
        migrateTmpCursor(sessionId, cursorFile, log);
        const lastCount = readCursor(cursorFile, log);
        if (lastCount === null) {
          log(`final flush skipped for ${sessionId} due to unsafe cursor`);
        } else {
          let messages = null;
          try {
            messages = parseTranscript(transcriptPath);
          } catch {
            log(`final flush parse failed for ${sessionId}; cursor retained for retry`);
          }
          const newMessages = messages ? messages.slice(lastCount) : null;
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
              writeCursor(cursorFile, messages.length, log);
              checkpoint = messages.length;
              finalized = true;
            } else {
              log(`final flush failed for ${sessionId} (http=${res.status}); cursor retained for retry`);
            }
          } else if (newMessages) {
            writeCursor(cursorFile, messages.length, log);
            checkpoint = messages.length;
            finalized = true;
          }
        }
      } else {
        log(`final flush skipped for ${sessionId}: drain unavailable; cursor retained`);
      }

      // in `finally`.
      if (state) {
        const { cursorFile, doneFile, legacyCursor, legacyLock } = state;
        if (finalized && markSessionDone(doneFile, checkpoint, log)) {
          removeCursor(cursorFile, log);
        }
        if (cursorFile !== legacyCursor) {
          try {
            const info = fs.lstatSync(legacyCursor);
            if (!info.isSymbolicLink()) fs.rmSync(legacyCursor, { force: true });
          } catch {
            /* absent */
          }
        }
        if (state.lockFile !== legacyLock) {
          try {
            fs.rmdirSync(legacyLock);
          } catch {
            /* absent */
          }
        }
      }
    } finally {
      if (lockAcquired && state) releaseLock(state.lockFile);
    }

    if (config.enableMaterialize) runMaterialize(log);
  }

  // session's cursor/lock, advancing the cursor only on a successful observe.
  // Shared mid-session drain used by handlePreCompact (the session-end path in
  // handleSessionEnd has its own cursor-removal cleanup and is intentionally
  // not refactored onto this helper to avoid perturbing its retention
  // semantics).
  //
  // Why this exists separately from the LCM flush: /engram/v1/lcm/compaction/flush
  // can only drain work ALREADY queued by prior /observe calls. If a turn
  // landed after the last PostToolUse (e.g. a long user prompt that triggers
  // auto compaction without a Bash tool call in between), that tail is still
  // only in the transcript and would be lost when the host summarizes/replaces
  // context. So PreCompact must observe the delta FIRST, then ask LCM to
  // flush.
  //
  // Returns "busy" when the session lock could not be acquired within the
  // caller's budget (a detached PostToolUse observe worker is still holding
  // it), so handlePreCompact can SKIP the flush instead of letting it drain
  // nothing and race the worker; true when the tail was observed (or nothing
  // pending); false on parse/observe failure (cursor retained) so the caller
  // can still flush already-queued work. Always fail-open.
  //
  // `lockRetries` (100ms each) bounds how long to wait for a busy worker.
  async function drainTranscriptTail(sessionId, transcriptPath, token, log, lockRetries = 50) {
    const safe = sessionId !== "" && !/[^A-Za-z0-9._-]/.test(sessionId);
    if (!safe || !token || !transcriptPath || !fs.existsSync(transcriptPath)) {
      return false;
    }
    const state = resolveState(sessionId, log);
    if (!state) return false;
    const { cursorFile, lockFile } = state;
    // this drain. Wait up to the caller's budget for the worker to finish its
    // /observe and release the lock — once it does, either the worker already
    // advanced the cursor (nothing left to drain) or we observe the remaining
    // delta, and in both cases the subsequent flush sees all queued work.
    // Only if the worker outlasts our budget do we return "busy" so
    // handlePreCompact SKIPS the flush rather than racing ahead of the
    // worker's in-flight /observe.
    if (!acquireLock(lockFile, log, lockRetries)) {
      log(`transcript tail drain skipped for ${sessionId}: lock busy (worker still running)`);
      return "busy";
    }
    try {
      if (sessionDone(state.doneFile)) return true;
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
        { sessionKey: sessionId, messages: newMessages },
        30000,
      );
      if (res.ok) {
        // compaction, so the post-compact transcript must not re-observe this
        // tail.
        writeCursor(cursorFile, lastCount + newMessages.length, log);
        return true;
      }
      log(`transcript tail drain failed for ${sessionId} (http=${res.status}); cursor retained`);
      return false;
    } finally {
      releaseLock(lockFile);
    }
  }

  // compacts the conversation. Mirrors @remnic/plugin-pi's
  // session_before_compact handler, with one host-specific addition: because
  // the host observes asynchronously (PostToolUse on Bash + Stop), an
  // unobserved transcript tail can exist when compaction fires mid-session.
  // So we drain that tail to /engram/v1/observe FIRST, then POST
  // /engram/v1/lcm/compaction/flush so the daemon flushes the now-complete
  // observe buffer into long-term memory before the transcript is summarized.
  // ALWAYS returns continue:true — a hook failure must never block the
  // host's compaction (the upstream contract notes continue:false stops the
  // compact entirely), so this handler is fail-open end to end.
  async function handlePreCompact(input, token, log) {
    const sessionId = input.session_id || "";
    const transcriptPath = transcriptPathFor(input);
    const trigger = input.trigger || "auto";
    // to proceed — the drain + flush are best-effort coordination, not a gate.
    emit({ continue: true });
    if (!token) {
      log(`skipping pre-compact drain+flush: no token (session=${sessionId} trigger=${trigger})`);
      return;
    }
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
    const res = await httpPost(
      "/engram/v1/lcm/compaction/flush",
      token,
      { sessionKey: sessionId },
      20000,
    );
    if (res.ok) {
      log(`LCM compaction flush OK (session=${sessionId} trigger=${trigger})`);
    } else {
      log(`LCM compaction flush failed (http=${res.status}) — compaction proceeds`);
    }
  }

  function runMaterialize(log) {
    if (process.env.REMNIC_CODEX_MATERIALIZE === "0") return;
    const hookDir = __dirname;

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
    // os.homedir()). The materializer resolves config paths from HOME and
    // only falls back to os.homedir(); on Windows, where HOME is typically
    // unset, passing it explicitly guarantees the child uses the SAME home
    // as the hook instead of diverging (#1443 review).
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

  async function main() {
    const event = process.argv[2] || "";

    if (event === OBSERVE_WORKER) {
      const log = makeLogger("post-tool-observe");
      try {
        const raw = readStdin();
        const input = normalizeHookInput(parseInput(raw));
        const token = process.env.REMNIC_HOOK_TOKEN || resolveToken();
        if (token) await observeWorker(input, token, log);
      } catch (err) {
        log(`observe worker error: ${err && err.message}`);
      }
      return;
    }

    if (event === SESSION_END_DRAIN) {
      const log = makeLogger("session-end");
      try {
        const raw = readStdin();
        const input = normalizeHookInput(parseInput(raw));
        const token = process.env.REMNIC_HOOK_TOKEN || resolveToken();
        await handleSessionEnd(input, token, log, raw, { drainRetry: true });
      } catch (err) {
        log(`session-end drain error: ${err && err.message}`);
      }
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(LOG_FILES, event)) {
      emit({ continue: true });
      if (event) process.stderr.write(`${PROG_NAME}: unknown event "${event}"\n`);
      return;
    }

    const log = makeLogger(event);
    const raw = readStdin();
    const input = normalizeHookInput(parseInput(raw));

    const handlers = {
      "session-start": handleSessionStart,
      "user-prompt-recall": handleUserPromptRecall,
      "post-tool-observe": handlePostToolObserve,
      "session-end": handleSessionEnd,
    };
    if (config.enablePreCompact) {
      handlers["pre-compact"] = handlePreCompact;
      // Devin CLI emits PostCompaction (after the fact) rather than a
      // pre-compact event; the drain+flush is equally correct there.
      handlers["post-compaction"] = handlePreCompact;
    }

    try {
      ensureMigrated();
      const token = resolveToken();
      const handler = handlers[event];
      if (handler) await handler(input, token, log, raw);
    } catch (err) {
      log(`unhandled error in ${event}: ${err && err.message}`);
      if (!emitted) {
        try {
          emit({ continue: true });
        } catch {
          /* stdout already written */
        }
      }
    }
  }

  main().catch((err) => {
    // its internal try/catch (rule: a hook error must never block the host).
    try {
      process.stderr.write(`${PROG_NAME}: unhandled error: ${err && err.message}\n`);
    } catch {
      /* stderr already closed */
    }
    if (!emitted) {
      try {
        emit({ continue: true });
      } catch {
        /* stdout already written */
      }
    }
  });
}

module.exports = { run };
