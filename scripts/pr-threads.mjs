#!/usr/bin/env node
/**
 * Print PR review threads with IDs and full bodies (issue #2441).
 *
 *   node scripts/pr-threads.mjs <pr> [--all] [--json]
 *
 * Default: unresolved threads. `--all` includes resolved. `--json` emits an
 * array of { id, author, isResolved, body }. Bodies are never truncated.
 *
 * `gh` is resolved the same way as scripts/pr-wait-settled.sh (issue #2423):
 * skip mise shims, honor REMNIC_GH_BIN, and strip a leading mise banner or
 * other non-JSON lines before parse.
 */
import { accessSync, closeSync, constants, openSync, readSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const USAGE = "Usage: node scripts/pr-threads.mjs <pr> [--all] [--json]";
const DEFAULT_REPO = "joshuaswarren/remnic";
const MISE_GH_BANNER =
  /^[ \t]*mise[ \t].*config\.toml[ \t]+tools:[ \t]+gh@[^\s]+[ \t]*$/;

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $pr: Int!, $after: String = null) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { author { login } body }
          }
        }
      }
    }
  }
}`;

export function parseArgs(argv) {
  let pr = null;
  let all = false;
  let json = false;
  for (const arg of argv) {
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}\n${USAGE}`);
    }
    if (pr != null) {
      throw new Error(`Unexpected argument: ${arg}\n${USAGE}`);
    }
    pr = arg;
  }
  const n = Number(pr);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(USAGE);
  }
  return { pr: n, all, json, help: false };
}

export function stripGhBanner(text) {
  const lines = String(text).split(/\r?\n/);
  let started = false;
  const out = [];
  for (const line of lines) {
    if (!started && MISE_GH_BANNER.test(line)) continue;
    started = true;
    out.push(line);
  }
  return out.join("\n");
}

export function stripLeadingNonJson(text) {
  const lines = String(text).split(/\r?\n/);
  let started = false;
  const out = [];
  for (const line of lines) {
    if (!started) {
      if (!/^[ \t]*[\[{]/.test(line)) continue;
      started = true;
    }
    out.push(line);
  }
  return out.join("\n");
}

function isExecutable(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fileLooksLikeMiseWrapper(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, 512, 0);
    const head = buf.subarray(0, n).toString("utf8");
    return head.startsWith("#!") && head.includes("mise");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function resolveMiseGh() {
  const result = spawnSync("mise", ["which", "gh"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const candidate = (result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1);
  return candidate && isExecutable(candidate) ? candidate : null;
}

export function resolveGh(env = process.env) {
  if (env.REMNIC_GH_BIN) return env.REMNIC_GH_BIN;
  const names = process.platform === "win32" ? ["gh.exe", "gh.cmd", "gh"] : ["gh"];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (!isExecutable(candidate)) continue;
      const posix = candidate.replaceAll("\\", "/");
      if (posix.endsWith("/shims/gh") || posix.endsWith("/shims/gh.exe")) {
        const resolved = resolveMiseGh();
        if (resolved) return resolved;
        continue;
      }
      if (fileLooksLikeMiseWrapper(candidate)) {
        const resolved = resolveMiseGh();
        if (resolved) return resolved;
        continue;
      }
      return candidate;
    }
  }
  return "gh";
}

export function parseGhJson(stdout) {
  const text = stripLeadingNonJson(stripGhBanner(stdout ?? ""));
  if (!text.trim()) {
    throw new Error("gh returned empty output");
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`gh returned non-JSON: ${err.message}`);
  }
}

function repositoryPayload(payload) {
  if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") {
    return payload.data.repository;
  }
  return payload?.repository;
}

export function threadsFromPayload(payload) {
  const repository = repositoryPayload(payload);
  const pullRequest = repository?.pullRequest;
  if (!pullRequest) {
    throw new Error("PR not found");
  }
  const nodes = pullRequest.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map((thread) => {
    const comment = thread?.comments?.nodes?.[0];
    return {
      id: typeof thread?.id === "string" ? thread.id : "",
      author: comment?.author?.login ?? "unknown",
      isResolved: thread?.isResolved === true,
      body: typeof comment?.body === "string" ? comment.body : "",
    };
  });
}

export function selectThreads(threads, { all = false } = {}) {
  return all ? threads : threads.filter((thread) => !thread.isResolved);
}

export function nextPageCursor(pageInfo, after) {
  if (!pageInfo?.hasNextPage) return null;
  const cursor = pageInfo.endCursor;
  if (typeof cursor !== "string" || cursor.length === 0 || cursor === after) {
    throw new Error("reviewThreads pagination cursor is missing or repeated");
  }
  return cursor;
}

export function formatHuman(threads) {
  return threads
    .map((thread) => `id: ${thread.id}\nauthor: ${thread.author}\nisResolved: ${thread.isResolved}\n\n${thread.body}\n`)
    .join("\n");
}

function runGhJson(ghBin, args, env) {
  const result = spawnSync(ghBin, args, { encoding: "utf8", env });
  if (result.error) {
    throw new Error(result.error.message);
  }
  const stderr = stripGhBanner(result.stderr ?? "").trim();
  if (result.status !== 0) {
    throw new Error(stderr || `gh exited ${result.status}`);
  }
  return parseGhJson(result.stdout);
}

function fetchThreads({ ghBin, owner, name, pr, env }) {
  const threads = [];
  let after = null;
  for (;;) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `pr=${pr}`,
    ];
    if (after) {
      args.push("-f", `after=${after}`);
    }
    const payload = runGhJson(ghBin, args, env);
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      const message = payload.errors.map((err) => err?.message).filter(Boolean).join("; ");
      throw new Error(message || "GraphQL error");
    }
    threads.push(...threadsFromPayload(payload));
    const pageInfo = repositoryPayload(payload)?.pullRequest?.reviewThreads?.pageInfo;
    after = nextPageCursor(pageInfo, after);
    if (!after) break;
  }
  return threads;
}

export function main(argv = process.argv.slice(2), io = console, env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    io.error(USAGE);
    return 0;
  }
  const repo = env.REMNIC_REPO || DEFAULT_REPO;
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) {
    throw new Error("REMNIC_REPO must be owner/name");
  }
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  const threads = selectThreads(
    fetchThreads({
      ghBin: resolveGh(env),
      owner,
      name,
      pr: args.pr,
      env,
    }),
    args,
  );
  if (args.json) {
    io.log(JSON.stringify(threads, null, 2));
  } else {
    const text = formatHuman(threads);
    if (text) io.log(text);
  }
  return 0;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
