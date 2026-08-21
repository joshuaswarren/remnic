#!/usr/bin/env node
/**
 * Batched review-thread queries and resolves (GraphQL budget survival).
 *
 * The naive loop — one GraphQL query per PR to list threads, then one
 * mutation per thread to resolve — exhausts the GraphQL point budget fast
 * when several PRs are in flight, and `unresolved-review-threads` then stays
 * red for as long as the budget takes to refill. One agent run lost roughly
 * two and a half hours to three separate rate-limit waits doing exactly that.
 *
 * This helper issues ONE query for every PR (aliased sub-selections) and ONE
 * mutation for every thread (aliased mutations), which is the same work in
 * two requests instead of 2N — plus one extra query per additional page for
 * any PR with more than 50 threads.
 *
 *   node scripts/pr-review-threads.mjs list  <owner/repo> <pr...>
 *   node scripts/pr-review-threads.mjs resolve <threadId...>
 *
 * `list` prints one `PR<number> <threadId> <author>` line per UNRESOLVED
 * thread. `resolve` takes ids on argv, or reads them from stdin, so both
 * `list | resolve` and `resolve $(list ... | awk ...)` work.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Printed by `list` after its final row: proof the query completed. */
export const LIST_SENTINEL = "# pr-review-threads: end of list";
import path from "node:path";
import process from "node:process";

/**
 * Serialize a value as a GraphQL string literal. execFileSync passes argv
 * without a shell, so the risk here is GraphQL injection, not shell
 * injection: a quote or brace in an interpolated value can change the
 * operation that runs under the configured gh credential.
 */
export function graphqlString(value, field) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`pr-review-threads: ${field} must be a non-empty string`);
  }
  return JSON.stringify(value);
}

/** GitHub owner/repo charset. Anything else is refused before interpolation. */
export function assertRepoIdentifier(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(
      `pr-review-threads: ${field} must match [A-Za-z0-9._-]+, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Build a single query with one aliased pullRequest field per PR number. */
export function buildListQuery(owner, repo, prNumbers, cursors = {}) {
  assertRepoIdentifier(owner, "owner");
  assertRepoIdentifier(repo, "repo");
  if (prNumbers.length === 0) throw new Error("pr-review-threads: no PR numbers given");
  for (const pr of prNumbers) {
    if (!Number.isInteger(pr) || pr <= 0) {
      throw new Error(`pr-review-threads: PR number must be a positive integer, got ${pr}`);
    }
  }
  const fields = prNumbers
    .map((pr) => {
      // A PR with more than one page of threads (resolved ones count) would
      // otherwise silently truncate, and the helper would report "none
      // unresolved" while the review guard stayed red.
      const after = cursors[pr] ? `, after: ${graphqlString(cursors[pr], "cursor")}` : "";
      return (
        `  pr${pr}: pullRequest(number: ${pr}) { ` +
        `reviewThreads(first: 50${after}) { pageInfo { hasNextPage endCursor } ` +
        "nodes { id isResolved comments(first: 1) { nodes { author { login } } } } } }"
      );
    })
    .join("\n");
  return (
    `query {\n repository(owner: ${graphqlString(owner, "owner")}, ` +
    `name: ${graphqlString(repo, "repo")}) {\n${fields}\n }\n}`
  );
}

/** Build a single mutation with one aliased resolveReviewThread per thread. */
/** Node ids are opaque base64url-ish tokens; anything else is refused. */
export function assertThreadId(id) {
  if (typeof id !== "string" || id.trim() === "" || id !== id.trim()) {
    throw new Error(
      `pr-review-threads: thread id must be a trimmed non-blank string, got ${JSON.stringify(id)}`,
    );
  }
  if (!/^[A-Za-z0-9_=-]+$/.test(id)) {
    throw new Error(
      `pr-review-threads: thread id must match [A-Za-z0-9_=-]+, got ${JSON.stringify(id)}`,
    );
  }
  return id;
}

export function uniqueThreadIds(threadIds) {
  const seen = new Set();
  for (const id of threadIds) {
    assertThreadId(id);
    seen.add(id);
  }
  return [...seen];
}

export function buildResolveMutation(threadIds) {
  if (threadIds.length === 0) throw new Error("pr-review-threads: no thread ids given");
  const seen = new Set();
  const fields = [];
  for (const [index, id] of threadIds.entries()) {
    assertThreadId(id);
    // A duplicate id would collide on its alias and make the whole mutation
    // invalid, so drop repeats rather than sending a request that cannot run.
    if (seen.has(id)) continue;
    seen.add(id);
    fields.push(
      `  t${index}: resolveReviewThread(input: { threadId: ${graphqlString(id, "thread id")} }) ` +
        "{ thread { isResolved } }",
    );
  }
  return `mutation {\n${fields.join("\n")}\n}`;
}

export function collectPageInfo(data) {
  const repository = data?.data?.repository ?? {};
  const more = {};
  for (const [alias, pr] of Object.entries(repository)) {
    if (!alias.startsWith("pr") || pr === null || typeof pr !== "object") continue;
    const info = pr.reviewThreads?.pageInfo;
    if (info?.hasNextPage === true && typeof info.endCursor === "string") {
      more[alias.slice(2)] = info.endCursor;
    }
  }
  return more;
}

export function collectUnresolved(data) {
  const repository = data?.data?.repository ?? {};
  const rows = [];
  for (const [alias, pr] of Object.entries(repository)) {
    if (!alias.startsWith("pr") || pr === null || typeof pr !== "object") continue;
    const number = alias.slice(2);
    for (const node of pr.reviewThreads?.nodes ?? []) {
      if (node?.isResolved !== false) continue;
      rows.push({
        pr: number,
        threadId: node.id,
        author: node.comments?.nodes?.[0]?.author?.login ?? "unknown",
      });
    }
  }
  // Deterministic: PR ascending (numeric), then thread id.
  rows.sort((a, b) => (Number(a.pr) - Number(b.pr)) || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));
  return rows;
}

function gh(query) {
  let out;
  try {
    out = execFileSync("gh", ["api", "graphql", "-f", `query=${query}`], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    // A rate limit is the condition this helper exists to survive, so report
    // it as one line instead of a raw execFileSync stack trace.
    // gh writes the concise diagnostic to stderr and the JSON body to stdout,
    // so both streams must be inspected before classifying the failure.
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const combined = `${stdout}\n${stderr}`;
    if (combined.includes("RATE_LIMIT") || /rate limit/i.test(combined)) {
      throw new Error(
        "pr-review-threads: the GraphQL point budget is exhausted. Wait for it to " +
          "refill and re-run; this helper already batches requests, so there is " +
          "nothing smaller to retry.",
      );
    }
    const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(" | ");
    throw new Error(`pr-review-threads: gh api graphql failed: ${detail || error?.message || "unknown error"}`);
  }
  const parsed = JSON.parse(out);
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new Error(`pr-review-threads: GraphQL error ${first?.type ?? ""}: ${first?.message ?? "unknown"}`.trim());
  }
  return parsed;
}

/**
 * Throw when a PR returns a cursor it has already returned. Tracks the whole
 * set per PR so a cycle longer than one step is caught too.
 */
export function assertCursorsAdvance(seenCursors, cursors) {
  for (const [pr, cursor] of Object.entries(cursors)) {
    let seen = seenCursors.get(pr);
    if (!seen) {
      seen = new Set();
      seenCursors.set(pr, seen);
    }
    if (seen.has(cursor)) {
      throw new Error(
        `pr-review-threads: PR ${pr} returned cursor ${cursor} twice; pagination is looping`,
      );
    }
    seen.add(cursor);
  }
  return seenCursors;
}

/**
 * Parse a PR number from its ORIGINAL token. `Number("0x10")` is 16 and
 * `Number("1e2")` is 100, so a malformed token would silently report a
 * different PR's thread state than the caller asked for.
 */
export function parsePrNumber(token) {
  if (typeof token !== "string" || !/^[0-9]{1,12}$/.test(token)) {
    throw new Error(
      `pr-review-threads: PR number must be decimal digits, got ${JSON.stringify(token)}`,
    );
  }
  const value = Number(token);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`pr-review-threads: PR number must be a positive integer, got ${JSON.stringify(token)}`);
  }
  return value;
}

/** Split `owner/repo`, refusing anything that is not exactly two components. */
export function parseRepoSlug(slug) {
  const parts = typeof slug === "string" ? slug.split("/") : [];
  if (parts.length !== 2 || parts.some((part) => part === "")) {
    throw new Error(
      `pr-review-threads: expected exactly owner/repo, got ${JSON.stringify(slug)}`,
    );
  }
  return { owner: assertRepoIdentifier(parts[0], "owner"), repo: assertRepoIdentifier(parts[1], "repo") };
}

/**
 * Extract thread ids from piped `list` output.
 * `null` means nothing was piped at all (interactive run); `[]` means a pipe
 * delivered no unresolved threads, which is a success, not a usage error.
 */
export function threadIdsFromStdin(readStdin = defaultReadStdin) {
  const text = readStdin();
  if (text === null) return null;
  return text.split(/\s+/).filter((token) => token.startsWith("PRRT_"));
}

let lastStdinText = null;

function readPipedThreadIds() {
  lastStdinText = defaultReadStdin();
  if (lastStdinText === null) return null;
  return lastStdinText.split(/\s+/).filter((token) => token.startsWith("PRRT_"));
}

function pipedRanToCompletion() {
  return typeof lastStdinText === "string" && lastStdinText.includes(LIST_SENTINEL);
}

function defaultReadStdin() {
  // A TTY means no pipe: distinct from a pipe that carried no rows.
  if (process.stdin.isTTY) return null;
  try {
    return readFileSync(0, "utf8");
  } catch {
    // A pipe that delivered nothing can raise EAGAIN/EOF here. stdin was
    // still redirected, so this is an empty pipe, not an interactive run.
    return "";
  }
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "list") {
    const [slug, ...prs] = rest;
    if (!slug) throw new Error("pr-review-threads list <owner/repo> <pr...>");
    // owner/repo/extra previously queried owner/repo and presented the result
    // as the requested repository's thread state.
    const { owner, repo } = parseRepoSlug(slug);
    // `list owner/repo` with no numbers previously exited 0 with no output,
    // which is indistinguishable from "no unresolved threads".
    if (prs.length === 0) {
      throw new Error("pr-review-threads list <owner/repo> <pr...>: at least one PR number is required");
    }
    const numbers = prs.map((pr) => parsePrNumber(pr));
    const rows = [];
    let cursors = {};
    let pending = numbers;
    // Round 1 covers every PR in one request; later rounds only revisit the
    // PRs that reported another page, so the common case stays at one request.
    // No page cap: a valid cursor chain must be allowed to finish however long
    // it is. A cursor that repeats for the same PR is a real loop, and that is
    // what terminates instead.
    // Every cursor ever seen for a PR, not just the previous one: a C1 -> C2 ->
    // C1 cycle would otherwise pass an adjacent-duplicate check and keep
    // issuing requests until the rate limiter stopped it.
    const seenCursors = new Map();
    while (pending.length > 0) {
      const page = gh(buildListQuery(owner, repo, pending, cursors));
      rows.push(...collectUnresolved(page));
      cursors = collectPageInfo(page);
      assertCursorsAdvance(seenCursors, cursors);
      pending = Object.keys(cursors).map((pr) => Number(pr));
    }
    rows.sort((a, b) => Number(a.pr) - Number(b.pr) || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));
    for (const row of rows) {
      console.log(`PR${row.pr} ${row.threadId} ${row.author}`);
    }
    // Proof of completion. Without it, a `list` that died early (rate limit,
    // inaccessible PR) hands `resolve` empty stdin, and in a pipeline without
    // pipefail the run reports success having queried nothing.
    console.log(LIST_SENTINEL);
    return;
  }
  if (mode === "resolve") {
    // The documented `list | resolve` pipe puts the rows on stdin, so read it
    // when no ids are given on argv rather than telling the user it worked.
    // Every argv token must be a valid id. Filtering invalid ones away
    // resolved the rest and reported success while a requested thread stayed
    // unresolved.
    const argvIds = rest.length > 0 ? rest.map((token) => assertThreadId(token)) : [];
    let ids = argvIds;
    if (ids.length === 0) {
      const piped = readPipedThreadIds();
      if (piped === null) {
        // Nothing on argv and nothing piped: the invocation is incomplete.
        throw new Error("pr-review-threads resolve <threadId...>  (or pipe `list` output in)");
      }
      if (piped.length === 0) {
        // Empty input is only clean when `list` says it finished. Otherwise
        // the upstream failed and this must not report success.
        if (!pipedRanToCompletion()) {
          throw new Error(
            "pr-review-threads: empty input without the end-of-list marker — `list` did not finish, " +
              "so there is no evidence the queried PRs are clean",
          );
        }
        console.log("[pr-review-threads] list finished with no unresolved threads; nothing to resolve");
        return;
      }
      ids = piped;
    }
    // Compare against the UNIQUE ids actually sent: buildResolveMutation
    // deduplicates, so GraphQL returns one result per unique id and using the
    // caller's raw count would fail a run that resolved everything.
    const unique = uniqueThreadIds(ids);
    const result = gh(buildResolveMutation(ids));
    const resolved = Object.values(result?.data ?? {}).filter((entry) => entry?.thread?.isResolved === true);
    console.log(`[pr-review-threads] resolved ${resolved.length}/${unique.length} in one request`);
    if (resolved.length !== unique.length) process.exit(1);
    return;
  }
  throw new Error("usage: pr-review-threads.mjs list <owner/repo> <pr...> | resolve <threadId...>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2));
}
