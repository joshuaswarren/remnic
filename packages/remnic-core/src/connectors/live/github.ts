
import type {
  ConnectorConfig,
  ConnectorCursor,
  ConnectorDocument,
  LiveConnector,
  SyncIncrementalArgs,
  SyncIncrementalResult,
} from "./framework.js";
import { throwIfAborted } from "../../abort-error.js";

// ---------------------------------------------------------------------------

export const GITHUB_CONNECTOR_ID = "github";

export const GITHUB_CURSOR_KIND = "githubWatermark";

export const GITHUB_DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

const GITHUB_MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

const MAX_BODY_BYTES = 5 * 1024 * 1024;

const MAX_ITEMS_PER_PASS = 200;

/** Page size for GitHub list requests. Maximum allowed by the API. */
const GITHUB_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

interface GitHubCursorPayload {
  watermarks: Record<string, string>;
  seenIds: Record<string, string>;
}

// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

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

  if (typeof r.token !== "string") {
    throw new TypeError(`github: token must be a string (got ${typeof r.token})`);
  }
  const token = r.token.trim();
  if (token.length === 0) {
    throw new RangeError("github: token must be non-empty");
  }

  if (typeof r.userLogin !== "string") {
    throw new TypeError(`github: userLogin must be a string (got ${typeof r.userLogin})`);
  }
  const userLogin = r.userLogin.trim();
  if (userLogin.length === 0) {
    throw new RangeError("github: userLogin must be non-empty");
  }

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

  if (typeof e.name === "string" && e.name === "AbortError") return true;

  const status = pickNumericGitHubStatus(e);
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false;
  }

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
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";

function makeGitHubApiError(status: number, message: string): Error & { githubStatus: number } {
  const err = new Error(`github: HTTP ${status}: ${message}`) as Error & {
    githubStatus: number;
  };
  err.githubStatus = status;
  return err;
}

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

    persistConfig(validated: ConnectorConfig): ConnectorConfig {
      const config = validateGitHubConfig(validated);
      return Object.freeze({
        userLogin: config.userLogin,
        repos: config.repos,
        pollIntervalMs: config.pollIntervalMs,
        includeDiscussions: config.includeDiscussions,
      });
    },

    async syncIncremental(args: SyncIncrementalArgs): Promise<SyncIncrementalResult> {
      const config = validateGitHubConfig(args.config);
      throwIfAborted(args.abortSignal, "github: sync aborted");

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
// ---------------------------------------------------------------------------

async function seedWatermarks(
  fetchFn: GitHubFetchFn,
  config: GitHubConnectorConfig,
  initial: GitHubCursorPayload,
  signal: AbortSignal | undefined,
): Promise<GitHubCursorPayload> {
  const watermarks = { ...initial.watermarks };

  for (const repo of config.repos) {
    throwIfAborted(signal, "github: sync aborted");

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

    throwIfAborted(signal, "github: sync aborted");

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

    if (config.includeDiscussions) {
      throwIfAborted(signal, "github: sync aborted");
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

  const currentSeenIds: Record<string, string> = { ...payload.seenIds };
  const updatedSeenIds: Record<string, string> = { ...payload.seenIds };

  for (const repo of config.repos) {
    if (totalConsumed >= MAX_ITEMS_PER_PASS) break;
    throwIfAborted(signal, "github: sync aborted");

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
    throwIfAborted(signal, "github: sync aborted");

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

    if (config.includeDiscussions && totalConsumed < MAX_ITEMS_PER_PASS) {
      throwIfAborted(signal, "github: sync aborted");
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

function watermarkCrossedSecond(prev: string, next: string): boolean {
  return prev.slice(0, 19) < next.slice(0, 19);
}

// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

interface FetchAndFilterResult {
  docs: ConnectorDocument[];
  skippedOtherAuthor: number;
  skippedEmpty: number;
  skippedTooLarge: number;
  consumed: number;
  latestWatermark: string | undefined;
  newSeenIds: Record<string, string>;
}

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
    throwIfAborted(signal, "github: sync aborted");

    const data = await githubGet(fetchFn, token, nextUrl, signal);
    if (!Array.isArray(data)) break;

    for (const item of data) {
      if (consumed >= remainingBudget) break;
      throwIfAborted(signal, "github: sync aborted");

      const comment = normalizeGitHubComment(item, kind);
      if (!comment) {
        continue;
      }

      if (since && comment.updated_at < since) {
        continue;
      }

      const seenKey = `${repo}/${kind}/${comment.id}`;
      if (seenIds[seenKey] === comment.updated_at) {
        continue;
      }

      const authorLogin = comment.user?.login ?? null;
      if (authorLogin !== userLogin) {
        skippedOtherAuthor++;
        if (!latestWatermark || comment.updated_at > latestWatermark) {
          latestWatermark = comment.updated_at;
        }
        continue;
      }

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

      consumed++;

      const doc = buildDocument(comment, repo, kind, fetchedAt);
      docs.push(doc);

      if (!latestWatermark || comment.updated_at > latestWatermark) {
        latestWatermark = comment.updated_at;
      }

      newSeenIds[seenKey] = comment.updated_at;
    }

    if (data.length < GITHUB_PAGE_SIZE) {
      nextUrl = undefined;
    } else {
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

function advancePageUrl(url: string): string {
  try {
    const u = new URL(url);
    const page = parseInt(u.searchParams.get("page") ?? "1", 10);
    u.searchParams.set("page", String(isNaN(page) ? 2 : page + 1));
    return u.toString();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
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

function buildTitle(repo: string, kind: string, comment: GitHubComment): string {
  const kindLabel =
    kind === "issue-comment"
      ? "Issue comment"
      : kind === "pr-review-comment"
        ? "PR review comment"
        : "Discussion comment";
  return `${kindLabel} in ${repo} (#${comment.id})`;
}
