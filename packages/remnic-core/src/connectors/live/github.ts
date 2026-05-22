/**
 * @remnic/core — GitHub live connector (issue #683 PR 5/6)
 *
 * Concrete `LiveConnector` implementation that incrementally imports notes
 * from a user's GitHub activity into Remnic. Fetches via the GitHub REST
 * API using raw `fetch` with a personal access token — no octokit dep,
 * per à-la-carte packaging rules (CLAUDE.md gotcha #57).
 *
 * What is imported:
 *   - Issue comments authored by `userLogin` on watched repos.
 *   - PR review comments authored by `userLogin` on watched repos.
 *   - Discussion comments authored by `userLogin` (optional, off by default).
 *
 * Design notes:
 *
 *   - **Auth.** GitHub personal access token via `connectors.github.token`.
 *     The token is accepted at config-parse time but never logged. Operators
 *     must populate it from a secret store; no real value may appear in
 *     tests, fixtures, or comments.
 *
 *   - **Cursor semantics.** The cursor encodes a per-repo, per-resource-type
 *     watermark (latest `updated_at` ISO 8601 string seen). On the very first
 *     sync (cursor=null) we seed the watermark from the current latest
 *     comment timestamp WITHOUT importing any content — mirrors Drive's
 *     `getStartPageToken` bootstrap pattern. Subsequent passes only import
 *     items created/updated after the stored watermark.
 *
 *   - **Watermark field.** All three GitHub resource types expose
 *     `updated_at` at the comment level. We always use `updated_at` (not
 *     `created_at`) so edits re-trigger ingestion.
 *
 *   - **Raw `fetch`.** We call `https://api.github.com/…` directly.
 *     `Authorization: Bearer <token>` + `User-Agent: remnic-connector` headers
 *     on every request. The `fetchFn` parameter is the test injection point —
 *     production callers omit it and the connector uses the global `fetch`.
 *
 *   - **Idempotency.** `ConnectorDocument.source.externalId` is
 *     `{repo}/{kind}/{commentId}` and `externalRevision` is `updated_at`, so
 *     downstream dedup (CLAUDE.md gotcha #44) can recognise repeat fetches.
 *
 *   - **Filtering by userLogin.** GitHub's `/issues/comments` endpoint does
 *     not support server-side author filtering in the public API. We filter
 *     client-side by comparing `comment.user.login` to the configured
 *     `userLogin`. This keeps the implementation free from authenticated
 *     user lookups and avoids an extra round-trip on first run.
 *
 *   - **Privacy.** No comment body is ever logged. Repo names and counts
 *     may be logged. The token is never exposed in logs, state, or errors.
 *
 *   - **Read-only.** This connector only reads. It never posts, edits,
 *     reacts to, or otherwise mutates any GitHub resource.
 *
 *   - **Error classification.** 429/5xx → transient (re-throw, cursor
 *     does NOT advance). 404/403/410 → terminal (skip repo/resource,
 *     continue). Network errors → transient.
 */

import type {
  ConnectorConfig,
  ConnectorCursor,
  ConnectorDocument,
  LiveConnector,
  SyncIncrementalArgs,
  SyncIncrementalResult,
} from "./framework.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Stable connector id. */
export const GITHUB_CONNECTOR_ID = "github";

/** Cursor `kind` emitted by this connector. */
export const GITHUB_CURSOR_KIND = "githubWatermark";

/** Default poll interval: 5 minutes. */
export const GITHUB_DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Hard cap on poll interval: 24 hours. */
const GITHUB_MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Hard cap on body text we'll accept for a single comment. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Maximum number of items (across all repos and resource types) per pass. */
const MAX_ITEMS_PER_PASS = 200;

/** Page size for GitHub list requests. Maximum allowed by the API. */
const GITHUB_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/**
 * Validated, frozen view of `connectors.github.*`.
 */
export interface GitHubConnectorConfig {
  /** Personal access token. Populate from a secret store; never commit. */
  readonly token: string;
  /** Only import comments authored by this GitHub login. Required. */
  readonly userLogin: string;
  /** Repos to poll, in `owner/repo` format. */
  readonly repos: readonly string[];
  /** Poll interval in ms. */
  readonly pollIntervalMs: number;
  /** Whether to import Discussion comments. Default false. */
  readonly includeDiscussions: boolean;
}

// ---------------------------------------------------------------------------
// Cursor payload
// ---------------------------------------------------------------------------

/**
 * JSON payload encoded into `ConnectorCursor.value`.
 *
 * Watermarks are stored per repo per resource kind. We use ISO 8601 strings
 * (which sort lexicographically) for all comparisons — no epoch math needed.
 */
interface GitHubCursorPayload {
  /**
   * Maps `{repo}/{kind}` → latest `updated_at` ISO string already ingested.
   * `kind` is one of `"issue-comment"`, `"pr-review-comment"`, `"discussion"`.
   */
  watermarks: Record<string, string>;
  /**
   * Same-second dedup map: maps `{repo}/{kind}/{commentId}` → `updated_at`
   * ISO string for every comment processed within the same second as the
   * current watermark. Cleared when the watermark advances past that second
   * boundary. Prevents re-importing comments whose `updated_at` matches the
   * watermark exactly — GitHub's `since=` filter is inclusive, so comments at
   * the exact watermark timestamp are re-returned on every subsequent poll.
   *
   * Mirrors the Gmail connector's `seenIds` pattern from #745.
   */
  seenIds: Record<string, string>;
}

// ---------------------------------------------------------------------------
// GitHub API response shapes (only the fields we consume)
// ---------------------------------------------------------------------------

export interface GitHubComment {
  readonly id: number;
  readonly body?: string | null;
  readonly user?: { readonly login?: string | null } | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly html_url?: string | null;
  /** Present on PR review comments. */
  readonly pull_request_url?: string | null;
  /** Present on issue comments. */
  readonly issue_url?: string | null;
}

export interface GitHubDiscussionComment {
  readonly id: number;
  readonly body?: string | null;
  readonly author?: { readonly login?: string | null } | null;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
  readonly url?: string | null;
}

// ---------------------------------------------------------------------------
// Fetch abstraction (test hook)
// ---------------------------------------------------------------------------

/**
 * Minimal fetch-compatible surface used by the connector. Tests inject a
 * stub; production delegates to global `fetch`.
 */
export type GitHubFetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/** Pattern for `owner/repo`. Both segments allow alphanumeric + `-` + `_` + `.`. */
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Validate and normalise raw config. Throws with a concrete message on any
 * malformed input — never silently defaults (CLAUDE.md gotcha #51).
 */
export function validateGitHubConfig(raw: unknown): GitHubConnectorConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(
      `github: config must be an object, got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw}`,
    );
  }
  const r = raw as Record<string, unknown>;

  // token
  if (typeof r.token !== "string") {
    throw new TypeError(`github: token must be a string (got ${typeof r.token})`);
  }
  const token = r.token.trim();
  if (token.length === 0) {
    throw new RangeError("github: token must be non-empty");
  }

  // userLogin
  if (typeof r.userLogin !== "string") {
    throw new TypeError(`github: userLogin must be a string (got ${typeof r.userLogin})`);
  }
  const userLogin = r.userLogin.trim();
  if (userLogin.length === 0) {
    throw new RangeError("github: userLogin must be non-empty");
  }

  // pollIntervalMs
  let pollIntervalMs: number;
  if (r.pollIntervalMs === undefined) {
    pollIntervalMs = GITHUB_DEFAULT_POLL_INTERVAL_MS;
  } else if (typeof r.pollIntervalMs !== "number" || !Number.isFinite(r.pollIntervalMs)) {
    throw new TypeError(
      `github: pollIntervalMs must be a finite number (got ${JSON.stringify(r.pollIntervalMs)})`,
    );
  } else if (!Number.isInteger(r.pollIntervalMs)) {
    throw new TypeError(`github: pollIntervalMs must be an integer (got ${r.pollIntervalMs})`);
  } else if (r.pollIntervalMs < 1_000) {
    throw new RangeError(`github: pollIntervalMs must be ≥1000ms; got ${r.pollIntervalMs}`);
  } else if (r.pollIntervalMs > GITHUB_MAX_POLL_INTERVAL_MS) {
    throw new RangeError(
      `github: pollIntervalMs must be ≤${GITHUB_MAX_POLL_INTERVAL_MS} (24h); got ${r.pollIntervalMs}`,
    );
  } else {
    pollIntervalMs = r.pollIntervalMs;
  }

  // repos
  let repos: readonly string[] = [];
  if (r.repos !== undefined) {
    if (!Array.isArray(r.repos)) {
      throw new TypeError(
        `github: repos must be an array of strings (got ${typeof r.repos})`,
      );
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of r.repos) {
      if (typeof value !== "string") {
        throw new TypeError(
          `github: repos entries must be strings; found ${typeof value}`,
        );
      }
      const trimmed = value.trim();
      if (!REPO_SLUG_PATTERN.test(trimmed)) {
        throw new RangeError(
          `github: repos entry ${JSON.stringify(value)} is not a valid "owner/repo" slug`,
        );
      }
      // Dedupe per CLAUDE.md gotcha #49.
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    repos = Object.freeze(out);
  }

  // includeDiscussions (optional, default false)
  let includeDiscussions = false;
  if (r.includeDiscussions !== undefined) {
    if (typeof r.includeDiscussions !== "boolean") {
      throw new TypeError(
        `github: includeDiscussions must be a boolean (got ${typeof r.includeDiscussions})`,
      );
    }
    includeDiscussions = r.includeDiscussions;
  }

  return Object.freeze({
    token,
    userLogin,
    repos,
    pollIntervalMs,
    includeDiscussions,
  });
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

function makeCursor(payload: GitHubCursorPayload): ConnectorCursor {
  return {
    kind: GITHUB_CURSOR_KIND,
    value: JSON.stringify(payload),
    updatedAt: new Date().toISOString(),
  };
}

function parseCursorPayload(cursor: ConnectorCursor): GitHubCursorPayload {
  if (cursor.kind !== GITHUB_CURSOR_KIND) {
    throw new Error(
      `github: unexpected cursor kind ${JSON.stringify(cursor.kind)}; expected ${GITHUB_CURSOR_KIND}`,
    );
  }
  // CLAUDE.md gotcha #18: validate after parse.
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor.value);
  } catch {
    throw new Error(`github: cursor value is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`github: cursor value does not match GitHubCursorPayload shape`);
  }
  const p = parsed as Record<string, unknown>;
  const watermarks =
    typeof p.watermarks === "object" && p.watermarks !== null && !Array.isArray(p.watermarks)
      ? (p.watermarks as Record<string, string>)
      : {};
  // seenIds: tolerate missing key (old cursors lack it).
  const seenIds: Record<string, string> =
    typeof p.seenIds === "object" && p.seenIds !== null && !Array.isArray(p.seenIds)
      ? (p.seenIds as Record<string, string>)
      : {};
  return { watermarks, seenIds };
}

function watermarkKey(repo: string, kind: string): string {
  return `${repo}/${kind}`;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a fetch error as transient (re-throw — cursor does NOT advance,
 * next poll retries) vs. terminal (skip this repo/resource and continue).
 *
 * Transient:
 *   - 429 (rate-limit — retry after backoff)
 *   - 5xx (GitHub backend error)
 *   - AbortError / network-layer errors
 *
 * Terminal (skip-and-continue):
 *   - 404 (repo deleted, comment gone, or no access)
 *   - 403 (permission denied)
 *   - 410 (gone)
 *   - any other 4xx that isn't 429
 */
export function isTransientGitHubError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    githubStatus?: unknown;
    message?: unknown;
  };

  // AbortError
  if (typeof e.name === "string" && e.name === "AbortError") return true;

  // HTTP status attached by our own error-throwing code.
  const status = pickNumericGitHubStatus(e);
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    // Any classified 4xx that isn't 429 is terminal.
    return false;
  }

  // Network-layer error codes.
  const codeStr = typeof e.code === "string" ? e.code : undefined;
  if (codeStr !== undefined) {
    const transientCodes = new Set([
      "ECONNRESET",
      "ECONNREFUSED",
      "ECONNABORTED",
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENETDOWN",
      "ERR_NETWORK",
      "ERR_NETWORK_CHANGED",
    ]);
    if (transientCodes.has(codeStr)) return true;
    return false;
  }

  // No status, no code — treat as transient (plain network failures).
  return true;
}

function pickNumericGitHubStatus(e: {
  status?: unknown;
  githubStatus?: unknown;
  code?: unknown;
}): number | undefined {
  if (typeof e.githubStatus === "number" && Number.isFinite(e.githubStatus)) {
    return e.githubStatus;
  }
  if (typeof e.status === "number" && Number.isFinite(e.status)) {
    return e.status;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// GitHub API client helpers
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("github: sync aborted");
    err.name = "AbortError";
    throw err;
  }
}

function makeGitHubApiError(status: number, message: string): Error & { githubStatus: number } {
  const err = new Error(`github: HTTP ${status}: ${message}`) as Error & {
    githubStatus: number;
  };
  err.githubStatus = status;
  return err;
}

/**
 * Execute a GET request against the GitHub REST API. Returns the parsed JSON
 * body on success. Throws a structured error on non-2xx responses.
 */
async function githubGet(
  fetchFn: GitHubFetchFn,
  token: string,
  url: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "remnic-connector",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal,
  });

  const data = await res.json();
  if (!res.ok) {
    const message =
      typeof data === "object" &&
      data !== null &&
      typeof (data as Record<string, unknown>).message === "string"
        ? ((data as Record<string, unknown>).message as string)
        : `HTTP ${res.status}`;
    throw makeGitHubApiError(res.status, message);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Sync result type
// ---------------------------------------------------------------------------

/**
 * Result of a single sync pass. Superset of `SyncIncrementalResult` for
 * richer test assertions.
 */
export interface GitHubSyncResult extends SyncIncrementalResult {
  readonly skippedOtherAuthor: number;
  readonly skippedEmpty: number;
  readonly skippedTooLarge: number;
}

// ---------------------------------------------------------------------------
// Connector factory
// ---------------------------------------------------------------------------

/**
 * Construct the GitHub connector. `fetchFn` is the test hook — production
 * callers omit it and the connector delegates to global `fetch`.
 */
export function createGitHubConnector(
  options: { fetchFn?: GitHubFetchFn } = {},
): LiveConnector {
  const fetchFn: GitHubFetchFn =
    options.fetchFn ??
    (globalThis.fetch as unknown as GitHubFetchFn);

  return {
    id: GITHUB_CONNECTOR_ID,
    displayName: "GitHub",
    description:
      "Imports issue comments, PR review comments, and discussion posts authored by the configured user from watched repos into Remnic.",

    validateConfig(raw: unknown): ConnectorConfig {
      return validateGitHubConfig(raw) as unknown as ConnectorConfig;
    },

    async syncIncremental(args: SyncIncrementalArgs): Promise<SyncIncrementalResult> {
      const config = validateGitHubConfig(args.config);
      throwIfAborted(args.abortSignal);

      // Short-circuit: nothing to do if no repos are configured.
      if (config.repos.length === 0) {
        const emptyPayload: GitHubCursorPayload = { watermarks: {}, seenIds: {} };
        const result: GitHubSyncResult = {
          newDocs: [],
          nextCursor: makeCursor(emptyPayload),
          skippedOtherAuthor: 0,
          skippedEmpty: 0,
          skippedTooLarge: 0,
        };
        return result;
      }

      // Parse or seed cursor.
      const isFirstSync = args.cursor === null;
      const payload: GitHubCursorPayload = isFirstSync
        ? { watermarks: {}, seenIds: {} }
        : parseCursorPayload(args.cursor);

      if (isFirstSync) {
        const seededPayload = await seedWatermarks(fetchFn, config, payload, args.abortSignal);
        return {
          newDocs: [],
          nextCursor: makeCursor(seededPayload),
          skippedOtherAuthor: 0,
          skippedEmpty: 0,
          skippedTooLarge: 0,
        } as GitHubSyncResult;
      }

      return await incrementalSync(fetchFn, config, payload, args.abortSignal);
    },
  };
}

// ---------------------------------------------------------------------------
// First-sync: seed watermarks without importing
// ---------------------------------------------------------------------------

/**
 * For each configured repo and resource type, query the current latest
 * item timestamp and record it as the starting watermark. Returns without
 * emitting any documents, mirroring Drive's `getStartPageToken` pattern.
 */
async function seedWatermarks(
  fetchFn: GitHubFetchFn,
  config: GitHubConnectorConfig,
  initial: GitHubCursorPayload,
  signal: AbortSignal | undefined,
): Promise<GitHubCursorPayload> {
  const watermarks = { ...initial.watermarks };
  // seenIds starts empty for first-sync; nothing has been processed yet.

  for (const repo of config.repos) {
    throwIfAborted(signal);

    // Issue comments
    try {
      const latest = await fetchLatestTimestamp(
        fetchFn,
        config.token,
        `${GITHUB_API_BASE}/repos/${repo}/issues/comments?sort=updated&direction=desc&per_page=1`,
        "updated_at",
        signal,
      );
      if (latest) watermarks[watermarkKey(repo, "issue-comment")] = latest;
    } catch (err) {
      if (isTransientGitHubError(err)) throw err;
      // 404/403 → repo inaccessible, skip silently.
    }

    throwIfAborted(signal);

    // PR review comments
    try {
      const latest = await fetchLatestTimestamp(
        fetchFn,
        config.token,
        `${GITHUB_API_BASE}/repos/${repo}/pulls/comments?sort=updated&direction=desc&per_page=1`,
        "updated_at",
        signal,
      );
      if (latest) watermarks[watermarkKey(repo, "pr-review-comment")] = latest;
    } catch (err) {
      if (isTransientGitHubError(err)) throw err;
    }

    // Discussions (GraphQL not used; we use the REST search endpoint for simplicity)
    if (config.includeDiscussions) {
      throwIfAborted(signal);
      try {
        const latest = await fetchLatestTimestamp(
          fetchFn,
          config.token,
          `${GITHUB_API_BASE}/repos/${repo}/discussions?sort=updated&direction=desc&per_page=1`,
          "updated_at",
          signal,
        );
        if (latest) watermarks[watermarkKey(repo, "discussion")] = latest;
      } catch (err) {
        if (isTransientGitHubError(err)) throw err;
      }
    }
  }

  return { watermarks, seenIds: {} };
}

/**
 * Fetch the first page of a sorted list and return the `updated_at` field of
 * the first item, or `undefined` if the list is empty.
 */
async function fetchLatestTimestamp(
  fetchFn: GitHubFetchFn,
  token: string,
  url: string,
  field: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const data = await githubGet(fetchFn, token, url, signal);
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  if (typeof first !== "object" || first === null) return undefined;
  const ts = (first as Record<string, unknown>)[field];
  return typeof ts === "string" && ts.length > 0 ? ts : undefined;
}

// ---------------------------------------------------------------------------
// Incremental sync
// ---------------------------------------------------------------------------

async function incrementalSync(
  fetchFn: GitHubFetchFn,
  config: GitHubConnectorConfig,
  payload: GitHubCursorPayload,
  signal: AbortSignal | undefined,
): Promise<GitHubSyncResult> {
  const fetchedAt = new Date().toISOString();
  const newDocs: ConnectorDocument[] = [];
  const updatedWatermarks = { ...payload.watermarks };
  let skippedOtherAuthor = 0;
  let skippedEmpty = 0;
  let skippedTooLarge = 0;
  let totalConsumed = 0;

  // P1 fix (same-timestamp dedup): carry seenIds forward from the cursor.
  // Maps `{repo}/{kind}/{commentId}` → `updated_at` ISO string for all
  // comments processed within the same second as their resource watermark.
  // Cleared per-resource when the watermark advances into a new second.
  const currentSeenIds: Record<string, string> = { ...payload.seenIds };
  // Accumulate seenIds updates for each resource; merged into nextSeenIds below.
  const updatedSeenIds: Record<string, string> = { ...payload.seenIds };

  for (const repo of config.repos) {
    if (totalConsumed >= MAX_ITEMS_PER_PASS) break;
    throwIfAborted(signal);

    // --- Issue comments ---
    {
      const wmKey = watermarkKey(repo, "issue-comment");
      const since = payload.watermarks[wmKey];
      try {
        const result = await fetchAndFilterComments(
          fetchFn,
          config.token,
          buildIssueCommentsUrl(repo, since),
          repo,
          "issue-comment",
          config.userLogin,
          since,
          fetchedAt,
          MAX_ITEMS_PER_PASS - totalConsumed,
          currentSeenIds,
          signal,
        );
        for (const doc of result.docs) newDocs.push(doc);
        skippedOtherAuthor += result.skippedOtherAuthor;
        skippedEmpty += result.skippedEmpty;
        skippedTooLarge += result.skippedTooLarge;
        totalConsumed += result.consumed;
        if (result.latestWatermark) {
          const prevWm = updatedWatermarks[wmKey];
          const nextWm = result.latestWatermark;
          updatedWatermarks[wmKey] = nextWm;
          // Clear seenIds for this resource if the watermark crossed a second
          // boundary; otherwise merge the newly-seen ids.
          if (prevWm && watermarkCrossedSecond(prevWm, nextWm)) {
            for (const k of Object.keys(updatedSeenIds)) {
              if (k.startsWith(`${repo}/issue-comment/`)) delete updatedSeenIds[k];
            }
          }
          for (const [k, v] of Object.entries(result.newSeenIds)) {
            updatedSeenIds[k] = v;
          }
        }
      } catch (err) {
        if (isTransientGitHubError(err)) throw err;
        // Terminal (404/403): skip this resource for this repo.
      }
    }

    if (totalConsumed >= MAX_ITEMS_PER_PASS) break;
    throwIfAborted(signal);

    // --- PR review comments ---
    {
      const wmKey = watermarkKey(repo, "pr-review-comment");
      const since = payload.watermarks[wmKey];
      try {
        const result = await fetchAndFilterComments(
          fetchFn,
          config.token,
          buildPrReviewCommentsUrl(repo, since),
          repo,
          "pr-review-comment",
          config.userLogin,
          since,
          fetchedAt,
          MAX_ITEMS_PER_PASS - totalConsumed,
          currentSeenIds,
          signal,
        );
        for (const doc of result.docs) newDocs.push(doc);
        skippedOtherAuthor += result.skippedOtherAuthor;
        skippedEmpty += result.skippedEmpty;
        skippedTooLarge += result.skippedTooLarge;
        totalConsumed += result.consumed;
        if (result.latestWatermark) {
          const prevWm = updatedWatermarks[wmKey];
          const nextWm = result.latestWatermark;
          updatedWatermarks[wmKey] = nextWm;
          if (prevWm && watermarkCrossedSecond(prevWm, nextWm)) {
            for (const k of Object.keys(updatedSeenIds)) {
              if (k.startsWith(`${repo}/pr-review-comment/`)) delete updatedSeenIds[k];
            }
          }
          for (const [k, v] of Object.entries(result.newSeenIds)) {
            updatedSeenIds[k] = v;
          }
        }
      } catch (err) {
        if (isTransientGitHubError(err)) throw err;
      }
    }

    // --- Discussion comments (optional) ---
    if (config.includeDiscussions && totalConsumed < MAX_ITEMS_PER_PASS) {
      throwIfAborted(signal);
      const wmKey = watermarkKey(repo, "discussion");
      const since = payload.watermarks[wmKey];
      try {
        const result = await fetchAndFilterComments(
          fetchFn,
          config.token,
          buildDiscussionsUrl(repo, since),
          repo,
          "discussion",
          config.userLogin,
          since,
          fetchedAt,
          MAX_ITEMS_PER_PASS - totalConsumed,
          currentSeenIds,
          signal,
        );
        for (const doc of result.docs) newDocs.push(doc);
        skippedOtherAuthor += result.skippedOtherAuthor;
        skippedEmpty += result.skippedEmpty;
        skippedTooLarge += result.skippedTooLarge;
        totalConsumed += result.consumed;
        if (result.latestWatermark) {
          const prevWm = updatedWatermarks[wmKey];
          const nextWm = result.latestWatermark;
          updatedWatermarks[wmKey] = nextWm;
          if (prevWm && watermarkCrossedSecond(prevWm, nextWm)) {
            for (const k of Object.keys(updatedSeenIds)) {
              if (k.startsWith(`${repo}/discussion/`)) delete updatedSeenIds[k];
            }
          }
          for (const [k, v] of Object.entries(result.newSeenIds)) {
            updatedSeenIds[k] = v;
          }
        }
      } catch (err) {
        if (isTransientGitHubError(err)) throw err;
      }
    }
  }

  return {
    newDocs,
    nextCursor: makeCursor({ watermarks: updatedWatermarks, seenIds: updatedSeenIds }),
    skippedOtherAuthor,
    skippedEmpty,
    skippedTooLarge,
  };
}

/**
 * Returns true when the new watermark has crossed into a new second relative
 * to the previous watermark. ISO 8601 strings sort lexicographically and the
 * second boundary is at the 19-character prefix (e.g. "2026-04-26T09:00:01").
 */
function watermarkCrossedSecond(prev: string, next: string): boolean {
  return prev.slice(0, 19) < next.slice(0, 19);
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

function buildIssueCommentsUrl(repo: string, since?: string): string {
  const base = `${GITHUB_API_BASE}/repos/${repo}/issues/comments?sort=updated&direction=asc&per_page=${GITHUB_PAGE_SIZE}`;
  return since ? `${base}&since=${encodeURIComponent(since)}` : base;
}

function buildPrReviewCommentsUrl(repo: string, since?: string): string {
  const base = `${GITHUB_API_BASE}/repos/${repo}/pulls/comments?sort=updated&direction=asc&per_page=${GITHUB_PAGE_SIZE}`;
  return since ? `${base}&since=${encodeURIComponent(since)}` : base;
}

function buildDiscussionsUrl(repo: string, since?: string): string {
  // GitHub Discussions REST API (available for repos with discussions enabled).
  // No server-side `since` filter exists, so we page and filter client-side.
  const base = `${GITHUB_API_BASE}/repos/${repo}/discussions?sort=updated&direction=asc&per_page=${GITHUB_PAGE_SIZE}`;
  return since ? `${base}&since=${encodeURIComponent(since)}` : base;
}

// ---------------------------------------------------------------------------
// Comment fetching + filtering
// ---------------------------------------------------------------------------

interface FetchAndFilterResult {
  docs: ConnectorDocument[];
  skippedOtherAuthor: number;
  skippedEmpty: number;
  skippedTooLarge: number;
  /** Count of items that were actually ingested (budget-counted). Skipped
   *  items (wrong author, empty body, too-large, seenIds dedup) do NOT
   *  consume budget — see P1 fix `PRRT_kwDORJXyws59sfBs`. */
  consumed: number;
  /** Latest `updated_at` we saw in this batch (includes skipped items so the
   *  watermark can advance past them). */
  latestWatermark: string | undefined;
  /**
   * New seenId entries accumulated during this pass. Maps
   * `{repo}/{kind}/{commentId}` → `updated_at` ISO string for every ingested
   * comment. Used by the caller to build the next cursor's `seenIds` map
   * (P1 fix `PRRT_kwDORJXyws59sfBq`).
   */
  newSeenIds: Record<string, string>;
}

/**
 * Page through the comments at `firstPageUrl`, filter to comments authored
 * by `userLogin`, and build `ConnectorDocument` instances. Respects the
 * per-pass cap via `remainingBudget`.
 *
 * Budget fix (P1 `PRRT_kwDORJXyws59sfBs`): only count ingested records
 * against the budget. Items skipped for wrong author, empty/too-large body,
 * or same-second seenId dedup do NOT advance the cap counter — they should
 * not starve valid records.
 *
 * Same-timestamp dedup (P1 `PRRT_kwDORJXyws59sfBq`): `seenIds` carries
 * comment ids already processed within the same second as the current
 * watermark. If GitHub re-returns them because `since=` is inclusive and
 * matches the exact watermark second, we skip them without re-importing.
 *
 * Uses `since` as a client-side lower-bound filter in addition to the
 * server-side `?since=` param (the server may return items exactly at
 * the watermark that we already ingested).
 */
async function fetchAndFilterComments(
  fetchFn: GitHubFetchFn,
  token: string,
  firstPageUrl: string,
  repo: string,
  kind: string,
  userLogin: string,
  since: string | undefined,
  fetchedAt: string,
  remainingBudget: number,
  seenIds: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<FetchAndFilterResult> {
  const docs: ConnectorDocument[] = [];
  let skippedOtherAuthor = 0;
  let skippedEmpty = 0;
  let skippedTooLarge = 0;
  let consumed = 0;
  let latestWatermark: string | undefined = undefined;
  const newSeenIds: Record<string, string> = {};
  let nextUrl: string | undefined = firstPageUrl;

  while (nextUrl && consumed < remainingBudget) {
    throwIfAborted(signal);

    const data = await githubGet(fetchFn, token, nextUrl, signal);
    if (!Array.isArray(data)) break;

    for (const item of data) {
      if (consumed >= remainingBudget) break;
      throwIfAborted(signal);

      const comment = normalizeGitHubComment(item, kind);
      if (!comment) {
        continue;
      }

      // Skip items strictly before the watermark. Items whose `updated_at`
      // equals the watermark second must pass through so the seenIds check
      // below can distinguish already-ingested comments from new ones at the
      // same timestamp. Using `<` (strict) here is intentional — `<=` would
      // make seenIds unreachable for boundary items, permanently dropping any
      // comment that arrives in the same second as the current watermark.
      if (since && comment.updated_at < since) {
        continue;
      }

      // Same-second dedup: skip only if this exact (id, updated_at) pair was
      // already ingested on a prior pass. A later edit of the same comment
      // produces a newer `updated_at`, so we must NOT gate on id alone — we
      // must also confirm the timestamp matches before skipping. This prevents
      // silent data loss when a comment is edited after its first ingestion.
      const seenKey = `${repo}/${kind}/${comment.id}`;
      if (seenIds[seenKey] === comment.updated_at) {
        continue;
      }

      // Author filter (client-side). Not counted against budget —
      // P1 fix `PRRT_kwDORJXyws59sfBs`: only ingested records consume budget.
      const authorLogin = comment.user?.login ?? null;
      if (authorLogin !== userLogin) {
        skippedOtherAuthor++;
        // Still track watermark for non-matching items to prevent re-fetching
        // them on every subsequent poll.
        if (!latestWatermark || comment.updated_at > latestWatermark) {
          latestWatermark = comment.updated_at;
        }
        continue;
      }

      // Body validation. Also not counted against budget.
      const body = comment.body ?? "";
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        skippedEmpty++;
        if (!latestWatermark || comment.updated_at > latestWatermark) {
          latestWatermark = comment.updated_at;
        }
        continue;
      }
      if (trimmed.length > MAX_BODY_BYTES) {
        skippedTooLarge++;
        if (!latestWatermark || comment.updated_at > latestWatermark) {
          latestWatermark = comment.updated_at;
        }
        continue;
      }

      // This item will be ingested — count it against the budget.
      consumed++;

      // Build document.
      const doc = buildDocument(comment, repo, kind, fetchedAt);
      docs.push(doc);

      if (!latestWatermark || comment.updated_at > latestWatermark) {
        latestWatermark = comment.updated_at;
      }

      // Record in newSeenIds for same-second dedup on subsequent polls.
      newSeenIds[seenKey] = comment.updated_at;
    }

    // Follow GitHub's `Link: <url>; rel="next"` header for pagination.
    // We don't have direct header access via the minimal fetch abstraction,
    // so pagination is signaled by a full page being returned. If the page
    // has fewer items than GITHUB_PAGE_SIZE we've reached the end.
    // This is conservative but correct — a short page always means "no more".
    if (data.length < GITHUB_PAGE_SIZE) {
      nextUrl = undefined;
    } else {
      // Full page received — there may be more. Advance via page parameter.
      nextUrl = advancePageUrl(nextUrl);
    }
  }

  return { docs, skippedOtherAuthor, skippedEmpty, skippedTooLarge, consumed, latestWatermark, newSeenIds };
}

function normalizeGitHubComment(
  item: unknown,
  kind: string,
): GitHubComment | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  if (kind !== "discussion") {
    return item as GitHubComment;
  }
  const discussion = item as GitHubDiscussionComment;
  const updatedAt = discussion.updatedAt ?? discussion.createdAt;
  if (typeof discussion.id !== "number" || typeof updatedAt !== "string") {
    return null;
  }
  return {
    id: discussion.id,
    body: discussion.body,
    user: discussion.author,
    created_at: discussion.createdAt ?? updatedAt,
    updated_at: updatedAt,
    html_url: discussion.url,
  };
}

/**
 * Advance a paginated GitHub URL by incrementing the `page` query parameter.
 * GitHub uses 1-based page numbers; if no `page` param is present we assume
 * we're on page 1 and bump to page 2.
 */
function advancePageUrl(url: string): string {
  try {
    const u = new URL(url);
    const page = parseInt(u.searchParams.get("page") ?? "1", 10);
    u.searchParams.set("page", String(isNaN(page) ? 2 : page + 1));
    return u.toString();
  } catch {
    // If URL parsing fails, bail — don't loop infinitely.
    return "";
  }
}

// ---------------------------------------------------------------------------
// Document builder
// ---------------------------------------------------------------------------

function buildDocument(
  comment: GitHubComment,
  repo: string,
  kind: string,
  fetchedAt: string,
): ConnectorDocument {
  const externalId = `${repo}/${kind}/${comment.id}`;
  const externalUrl =
    typeof comment.html_url === "string" && comment.html_url.length > 0
      ? comment.html_url
      : undefined;
  const title = buildTitle(repo, kind, comment);

  return {
    id: externalId,
    title,
    content: (comment.body ?? "").trim(),
    source: {
      connector: GITHUB_CONNECTOR_ID,
      externalId,
      externalRevision: comment.updated_at,
      externalUrl,
      fetchedAt,
    },
  };
}

/**
 * Build a short human-readable title for the comment document.
 * We avoid fetching the issue/PR title to keep the connector read-light.
 */
function buildTitle(repo: string, kind: string, comment: GitHubComment): string {
  const kindLabel =
    kind === "issue-comment"
      ? "Issue comment"
      : kind === "pr-review-comment"
        ? "PR review comment"
        : "Discussion comment";
  return `${kindLabel} in ${repo} (#${comment.id})`;
}
