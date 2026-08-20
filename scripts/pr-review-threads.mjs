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
export function buildListQuery(owner, repo, prNumbers) {
  if (prNumbers.length === 0) throw new Error("pr-review-threads: no PR numbers given");
  for (const pr of prNumbers) {
    if (!Number.isInteger(pr) || pr <= 0) {
      throw new Error(`pr-review-threads: PR number must be a positive integer, got ${pr}`);
    }
  }
  const fields = prNumbers
    .map(
      (pr) =>
        `  pr${pr}: pullRequest(number: ${pr}) { ` +
        "reviewThreads(first: 50) { nodes { id isResolved comments(first: 1) { nodes { author { login } } } } } }",
    )
    .join("\n");
  return `query {\n repository(owner: "${owner}", name: "${repo}") {\n${fields}\n }\n}`;
}

/** Build a single mutation with one aliased resolveReviewThread per thread. */
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
  const out = execFileSync("gh", ["api", "graphql", "-f", `query=${query}`], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "list") {
    const [slug, ...prs] = rest;
    if (!slug || !slug.includes("/")) throw new Error("pr-review-threads list <owner/repo> <pr...>");
    const [owner, repo] = slug.split("/");
    const query = buildListQuery(owner, repo, prs.map((pr) => Number(pr)));
    for (const row of collectUnresolved(gh(query))) {
      console.log(`PR${row.pr} ${row.threadId} ${row.author}`);
    }
    return;
  }
  if (mode === "resolve") {
    const ids = rest.filter((token) => token.startsWith("PRRT_"));
    if (ids.length === 0) throw new Error("pr-review-threads resolve <threadId...>");
    const result = gh(buildResolveMutation(ids));
    const resolved = Object.values(result?.data ?? {}).filter((entry) => entry?.thread?.isResolved === true);
    console.log(`[pr-review-threads] resolved ${resolved.length}/${ids.length} in one request`);
    if (resolved.length !== ids.length) process.exit(1);
    return;
  }
  throw new Error("usage: pr-review-threads.mjs list <owner/repo> <pr...> | resolve <threadId...>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2));
}
