#!/usr/bin/env node
// Unified Remnic Codex hook runner — cross-platform replacement for .sh scripts.
// Dispatches by event name from argv[2]: session-start, post-tool-observe,
// user-prompt-recall, session-end.

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const readline = require("readline");
const { spawnSync } = require("child_process");

const eventName = process.argv[2] || "";
const home = process.env.HOME || process.env.USERPROFILE || "";

function output(value) {
  process.stdout.write(JSON.stringify(value));
}

function log(name, message) {
  try {
    const logDir = path.join(home, ".remnic", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, name),
      new Date().toISOString() + " " + message + "\n"
    );
  } catch {}
}

function readInput() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {}
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function baseUrl() {
  if (process.env.REMNIC_DAEMON_URL) {
    return process.env.REMNIC_DAEMON_URL.replace(/\/+$/, "");
  }
  const host = process.env.REMNIC_HOST || process.env.ENGRAM_HOST || "127.0.0.1";
  const port = process.env.REMNIC_PORT || process.env.ENGRAM_PORT || "4318";
  return "http://" + host + ":" + port;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function getToken() {
  const tokenFiles = [
    path.join(home, ".remnic", "tokens.json"),
    path.join(home, ".engram", "tokens.json"),
  ];
  for (const tokenFile of tokenFiles) {
    const store = readJson(tokenFile, {});
    const tokens = Array.isArray(store.tokens) ? store.tokens : [];
    for (const connector of ["codex-cli", "codex", "openclaw"]) {
      const match = tokens.find((entry) => entry && entry.connector === connector && entry.token);
      if (match) return String(match.token);
      if (store[connector]) return String(store[connector]);
    }
  }
  return (
    process.env.OPENCLAW_REMNIC_ACCESS_TOKEN ||
    process.env.OPENCLAW_ENGRAM_ACCESS_TOKEN ||
    process.env.REMNIC_AUTH_TOKEN ||
    ""
  );
}

function requestJson(endpointPath, token, body, timeoutMs) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(baseUrl() + endpointPath);
    } catch {
      resolve(null);
      return;
    }
    const client = target.protocol === "https:" ? https : http;
    const payload = JSON.stringify(body);
    const req = client.request(
      target,
      {
        method: "POST",
        timeout: timeoutMs,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "X-Engram-Client-Id": "codex",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.write(payload);
    req.end();
  });
}

async function transcriptMessages(transcriptPath, startLine) {
  const messages = [];
  let lineNumber = 0;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return { messages, totalLines: 0 };
  const stream = fs.createReadStream(transcriptPath, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    lineNumber++;
    if (lineNumber <= startLine) continue;
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const msg = entry.message;
    if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
    let text = typeof msg.content === "string" ? msg.content.trim() : "";
    if (!text && Array.isArray(msg.content)) {
      text = msg.content
        .filter((block) => block && block.type === "text" && block.text)
        .map((block) => String(block.text).trim())
        .join("\n")
        .trim();
    }
    if (text) messages.push({ role: msg.role, content: text });
  }
  return { messages, totalLines: lineNumber };
}

function stateDir() {
  const root = process.env.XDG_STATE_HOME || path.join(home, ".local", "state");
  const dir = path.join(root, "remnic", "hooks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cursorPath(sessionId) {
  return path.join(stateDir(), "remnic-cursor-" + sessionId);
}

function readCursor(sessionId) {
  try {
    const raw = fs.readFileSync(cursorPath(sessionId), "utf8").trim();
    return /^\d+$/.test(raw) ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

function writeCursor(sessionId, value) {
  try {
    fs.writeFileSync(cursorPath(sessionId), String(value) + "\n", { mode: 0o600 });
  } catch {}
}

function clearSessionState(sessionId) {
  try {
    fs.rmSync(cursorPath(sessionId), { force: true });
  } catch {}
  try {
    fs.rmSync(path.join(stateDir(), "remnic-lock-" + sessionId + ".d"), {
      force: true,
      recursive: true,
    });
  } catch {}
}

function stableHash(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalizeOriginUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  if (/\.git$/i.test(value)) value = value.slice(0, -4);
  return value.toLowerCase();
}

function gitCodingContext(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const git = process.platform === "win32" ? "git.exe" : "git";
  function run(args) {
    const result = spawnSync(git, ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout.trim() : "";
  }
  const rootPath = run(["rev-parse", "--show-toplevel"]);
  if (!rootPath) return null;
  const branchRaw = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const origin = run(["remote", "get-url", "origin"]);
  return {
    projectId:
      (origin ? "origin:" : "root:") +
      stableHash(normalizeOriginUrl(origin) || rootPath.toLowerCase()),
    branch: branchRaw && branchRaw !== "HEAD" ? branchRaw : null,
    rootPath,
    defaultBranch: null,
  };
}

async function sessionStart(input, token) {
  const cwd = input.cwd || "";
  const projectName = cwd ? path.basename(cwd) : "unknown";
  const body = {
    query:
      "Starting a new coding session in project: " +
      projectName +
      ". Recall relevant memories, preferences, decisions, patterns, and context about this project and the user.",
    sessionKey: input.session_id || "",
    topK: 12,
    mode: "auto",
    codingContext: gitCodingContext(cwd),
  };
  let response = await requestJson("/engram/v1/recall", token, body, 45000);
  if (!response) {
    body.mode = "minimal";
    body.topK = 8;
    response = await requestJson("/engram/v1/recall", token, body, 20000);
  }
  let context = "[Remnic: server unreachable - continuing without memory recall]";
  if (response && response.context) {
    context =
      "[Remnic Memory Recall - " +
      (response.count || 0) +
      " memories]\n\n" +
      response.context;
  } else if (response) {
    context = "[Remnic: no relevant memories found for this session]";
  }
  log(
    "remnic-session-recall.log",
    "[codex-session-start] session=" +
      (input.session_id || "") +
      " project=" +
      projectName
  );
  output({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
}

async function userPromptRecall(input, token) {
  const prompt = input.prompt || "";
  if (prompt.trim().split(/\s+/).filter(Boolean).length < 4) {
    output({ continue: true });
    return;
  }
  const response = await requestJson(
    "/engram/v1/recall",
    token,
    {
      query: prompt,
      sessionKey: input.session_id || "",
      topK: 8,
      mode: "minimal",
    },
    20000
  );
  if (!response || !response.context || !response.count) {
    output({ continue: true });
    return;
  }
  output({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        '<remnic-memory count="' +
        response.count +
        '">\n' +
        response.context +
        "\n</remnic-memory>",
    },
  });
}

async function observeTranscript(input, token, isFinal) {
  const sessionId = input.session_id || "";
  const transcriptPath = input.transcript_path || "";
  if (
    !token ||
    !/^[A-Za-z0-9._-]+$/.test(sessionId) ||
    !transcriptPath ||
    !fs.existsSync(transcriptPath)
  )
    return;
  const cursor = readCursor(sessionId);
  const { messages: newMessages, totalLines } = await transcriptMessages(transcriptPath, cursor);
  if (newMessages.length > 0) {
    const response = await requestJson(
      "/engram/v1/observe",
      token,
      { sessionKey: sessionId, messages: newMessages },
      isFinal ? 30000 : 120000
    );
    if (response !== null && !isFinal) writeCursor(sessionId, totalLines);
  } else if (!isFinal) {
    writeCursor(sessionId, totalLines);
  }
  if (isFinal) clearSessionState(sessionId);
}

async function main() {
  const input = readInput();
  const token = getToken();
  if (
    !token &&
    (eventName === "session-start" || eventName === "user-prompt-recall")
  ) {
    output({
      continue: true,
      hookSpecificOutput: {
        hookEventName:
          eventName === "session-start" ? "SessionStart" : "UserPromptSubmit",
        additionalContext:
          "[Remnic: no auth token - run: remnic connectors install codex-cli]",
      },
    });
    return;
  }
  if (eventName === "session-start") return sessionStart(input, token);
  if (eventName === "user-prompt-recall") return userPromptRecall(input, token);
  if (eventName === "post-tool-observe") { await observeTranscript(input, token, false); output({ continue: true }); return; }
  if (eventName === "session-end") { await observeTranscript(input, token, true); output({ continue: true }); return; }
  output({ continue: true });
}

main().catch((error) => {
  log(
    "remnic-codex-hook.log",
    "[codex-hook] " + (error && error.stack ? error.stack : String(error))
  );
  output({ continue: true });
});
