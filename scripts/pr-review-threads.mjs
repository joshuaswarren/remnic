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
 * two requests instead of 2N.
 *
 *   node scripts/pr-review-threads.mjs list  <owner/repo> <pr...>
 *   node scripts/pr-review-threads.mjs resolve <threadId...>
 *
 * `list` prints one `PR<number> <threadId> <author>` line per UNRESOLVED
 * thread, so the output pipes straight into `resolve`.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

/** Build a single query with one aliased pullRequest field per PR number. */
export function buildListQuery(owner, repo, prNumbers, cursors = {}) {
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
      const after = cursors[pr] ? `, after: "${cursors[pr]}"` : "";
      return (
        `  pr${pr}: pullRequest(number: ${pr}) { ` +
        `reviewThreads(first: 50${after}) { pageInfo { hasNextPage endCursor } ` +
        "nodes { id isResolved comments(first: 1) { nodes { author { login } } } } } }"
      );
    })
    .join("\n");
  return `query {\n repository(owner: "${owner}", name: "${repo}") {\n${fields}\n }\n}`;
}

/** Build a single mutation with one aliased resolveReviewThread per thread. */
export function uniqueThreadIds(threadIds) {
  const seen = new Set();
  for (const id of threadIds) {
    if (typeof id !== "string" || id.trim() === "" || id !== id.trim()) {
      throw new Error(
        `pr-review-threads: thread id must be a trimmed non-blank string, got ${JSON.stringify(id)}`,
      );
    }
    seen.add(id);
  }
  return [...seen];
}

export function buildResolveMutation(threadIds) {
  if (threadIds.length === 0) throw new Error("pr-review-threads: no thread ids given");
  const seen = new Set();
  const fields = [];
  for (const [index, id] of threadIds.entries()) {
    if (typeof id !== "string" || id.trim() === "" || id !== id.trim()) {
      throw new Error(`pr-review-threads: thread id must be a trimmed non-blank string, got ${JSON.stringify(id)}`);
    }
    // A duplicate id would collide on its alias and make the whole mutation
    // invalid, so drop repeats rather than sending a request that cannot run.
    if (seen.has(id)) continue;
    seen.add(id);
    fields.push(`  t${index}: resolveReviewThread(input: { threadId: "${id}" }) { thread { isResolved } }`);
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
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    if (stdout.includes("RATE_LIMIT") || stdout.includes("rate limit")) {
      throw new Error(
        "pr-review-threads: the GraphQL point budget is exhausted. Wait for it to " +
          "refill and re-run; this helper already batches requests, so there is " +
          "nothing smaller to retry.",
      );
    }
    throw new Error(`pr-review-threads: gh api graphql failed: ${stdout || error?.message || "unknown error"}`);
  }
  const parsed = JSON.parse(out);
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new Error(`pr-review-threads: GraphQL error ${first?.type ?? ""}: ${first?.message ?? "unknown"}`.trim());
  }
  return parsed;
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "list") {
    const [slug, ...prs] = rest;
    if (!slug || !slug.includes("/")) throw new Error("pr-review-threads list <owner/repo> <pr...>");
    const [owner, repo] = slug.split("/");
    const numbers = prs.map((pr) => Number(pr));
    const rows = [];
    let cursors = {};
    let pending = numbers;
    // Round 1 covers every PR in one request; later rounds only revisit the
    // PRs that reported another page, so the common case stays at one request.
    for (let round = 0; round < 20 && pending.length > 0; round += 1) {
      const page = gh(buildListQuery(owner, repo, pending, cursors));
      rows.push(...collectUnresolved(page));
      cursors = collectPageInfo(page);
      pending = Object.keys(cursors).map((pr) => Number(pr));
    }
    if (pending.length > 0) {
      throw new Error("pr-review-threads: thread pagination did not terminate");
    }
    rows.sort((a, b) => Number(a.pr) - Number(b.pr) || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));
    for (const row of rows) {
      console.log(`PR${row.pr} ${row.threadId} ${row.author}`);
    }
    return;
  }
  if (mode === "resolve") {
    const ids = rest.filter((token) => token.startsWith("PRRT_"));
    if (ids.length === 0) throw new Error("pr-review-threads resolve <threadId...>");
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
