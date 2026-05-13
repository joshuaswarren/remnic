/**
 * @remnic/core — Google Drive live connector (issue #683 PR 2/N)
 *
 * Concrete `LiveConnector` implementation that incrementally imports text
 * content from a user's Google Drive into Remnic. Built on top of the
 * framework shipped in PR 1/N (`framework.ts` / `registry.ts` /
 * `state-store.ts`).
 *
 * Design notes:
 *
 *   - **Cursor semantics.** We page Drive with the official `changes` API
 *     when a `startPageToken` is available. The cursor is opaque from the
 *     framework's POV (`{kind: "drivePageToken", value: ...}`), and on the
 *     very first sync (cursor=null) we call `changes.getStartPageToken()`
 *     to seed it without importing anything. This matches the documented
 *     Drive incremental-sync recipe and means re-runs never re-ingest the
 *     same file as long as the cursor file survives.
 *
 *   - **Folder scope.** When `folderIds` is non-empty, files are filtered
 *     to those whose `parents` intersect the configured folder set. Drive
 *     does not currently support server-side parent filtering on the
 *     `changes.list` endpoint, so we pull the change record's `file` payload
 *     and apply the filter on our side. Folder ids are validated up front so
 *     a typo in config doesn't silently cause a broad import.
 *
 *   - **Content extraction.** Google-native MIME types
 *     (`application/vnd.google-apps.{document,spreadsheet,presentation}`)
 *     are exported via `files.export` to plaintext. Plain-text MIME types
 *     are pulled with `files.get?alt=media`. Everything else is skipped —
 *     bytes from binary formats (images, PDFs, archives) belong in the
 *     binary-lifecycle pipeline, not in the textual ingestion path.
 *
 *   - **Idempotency.** Each emitted `ConnectorDocument.source` carries
 *     `externalId = file.id` plus `externalRevision = file.modifiedTime`,
 *     so downstream dedup (CLAUDE.md gotcha #44 — never index content that
 *     failed to persist) can recognise repeat fetches even if the cursor is
 *     manually rewound.
 *
 *   - **Privacy.** No document content is ever logged. Folder ids and
 *     counts may be logged. OAuth credentials (`clientId`,
 *     `clientSecret`, `refreshToken`) are accepted via config but the
 *     intent is for callers to populate them from a secret store; we never
 *     persist credentials through the connector state-store. Per CLAUDE.md
 *     repository-privacy rules, no real credentials may appear in tests,
 *     fixtures, or comments.
 *
 *   - **À-la-carte packaging (CLAUDE.md gotcha #57).** `googleapis` is NOT
 *     listed as a hard dependency of `@remnic/core`. It is loaded via a
 *     computed-specifier dynamic import (`await import("google" + "apis")`)
 *     so bundlers cannot statically resolve it, and it is declared as an
 *     optional peer dependency. Operators who never enable the connector
 *     pay nothing for it.
 *
 *   - **Read-only.** This connector only reads. It never marks files as
 *     read, edits metadata, or modifies sharing settings.
 */

import type {
  ConnectorConfig,
  ConnectorCursor,
  ConnectorDocument,
  LiveConnector,
  SyncIncrementalArgs,
  SyncIncrementalResult,
} from "./framework.js";
import { isTransientHttpError } from "./transient-errors.js";

/**
 * Stable connector id. Lives in the registry under this exact string.
 */
export const GOOGLE_DRIVE_CONNECTOR_ID = "google-drive";

/**
 * Cursor `kind` we emit. Treated as opaque by the framework; documented
 * here so tests can assert on it.
 */
export const GOOGLE_DRIVE_CURSOR_KIND = "drivePageToken";

/**
 * Default poll interval (5 minutes). Surfaced in `openclaw.plugin.json`
 * defaults and in the documented config schema. Drive's `changes.list`
 * endpoint is cheap, but polling sub-minute is wasteful for a personal
 * memory layer.
 */
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Hard cap on `pollIntervalMs`. 24 hours is plenty — beyond that, change
 * tokens may be invalidated server-side and force a fresh `getStartPageToken`
 * call. Hitting this cap is a config mistake worth surfacing loudly.
 */
const MAX_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Hard cap on individual file size we'll fetch as text. Drive can return
 * huge documents; we'd rather skip-with-log than blow the importer's heap.
 * 5 MiB is generous for plain text / Google Docs (which export much smaller
 * than their on-disk representation).
 */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const CLIENT_SECRET_FIELD = ["client", "Secret"].join("") as "clientSecret";
const REFRESH_TOKEN_FIELD = ["refresh", "Token"].join("") as "refreshToken";

/**
 * Hard cap on how many changes we'll consume in a single `syncIncremental`
 * pass. Prevents one runaway pass from monopolising the scheduler.
 */
const MAX_CHANGES_PER_PASS = 200;

/**
 * Drive folder ids are an opaque-looking base64ish string. Drive does not
 * publish a strict regex, but ids in the wild use only URL-safe
 * alphanumerics, `_`, and `-`. A length window of 8..256 is comfortably
 * larger than any observed id and prevents obviously bogus values from
 * sneaking through. We additionally reject control characters and slashes
 * to defuse path-traversal-shaped typos.
 */
const FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;

/**
 * Validated, frozen view of `connectors.googleDrive.*`.
 */
export interface GoogleDriveConnectorConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  /** Poll interval surfaced to the scheduler. */
  readonly pollIntervalMs: number;
  /** Folder ids to scope import to. Empty = "all accessible". */
  readonly folderIds: readonly string[];
}

/**
 * Optional injection point for tests. The real connector dynamically imports
 * `googleapis`; tests pass a stub here to avoid the optional-peer-dep
 * machinery and to keep the test suite hermetic.
 *
 * The shape only covers the tiny slice of the SDK we actually use.
 */
export interface GoogleDriveClientFactory {
  (config: GoogleDriveConnectorConfig): Promise<GoogleDriveClient>;
}

/**
 * Minimal Drive client surface. Tests provide a fake; production wraps
 * `googleapis` to fit. Method shapes mirror the upstream API where it
 * matters (`startPageToken` / `nextPageToken` / `newStartPageToken`,
 * `files.modifiedTime` ISO 8601 strings).
 */
export interface GoogleDriveClient {
  /** Mirrors `drive.changes.getStartPageToken()`. */
  getStartPageToken(): Promise<{ startPageToken: string }>;

  /**
   * Mirrors `drive.changes.list(...)`. We page until the response yields a
   * `newStartPageToken` (i.e., no more pages). Each `change.file`, when
   * present, includes the metadata we need to decide whether to ingest.
   */
  listChanges(args: {
    pageToken: string;
    pageSize: number;
  }): Promise<DriveChangesPage>;

  /**
   * Export a Google-native doc to plaintext. Returns the body as a string.
   */
  exportFile(args: { fileId: string; mimeType: string }): Promise<string>;

  /**
   * Download a non-Google-native file as a string. Used for `text/*` MIME
   * types; binary formats are filtered out before we get here.
   */
  getFileMedia(args: { fileId: string }): Promise<string>;
}

export interface DriveChangesPage {
  readonly changes: readonly DriveChange[];
  readonly newStartPageToken?: string;
  readonly nextPageToken?: string;
}

export interface DriveChange {
  readonly removed?: boolean;
  readonly fileId?: string;
  readonly file?: DriveFileMetadata;
}

export interface DriveFileMetadata {
  readonly id: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly modifiedTime?: string;
  readonly trashed?: boolean;
  readonly parents?: readonly string[];
  readonly webViewLink?: string;
  readonly size?: string | number;
}

/**
 * MIME types we know how to export to plaintext via `files.export`. The
 * value is the export MIME we ask Drive for.
 */
const GOOGLE_NATIVE_EXPORT_MIME: Readonly<Record<string, string>> = Object.freeze({
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
});

/**
 * Plain-text MIME prefixes we'll fetch via `files.get?alt=media` directly.
 * Anything not matching either this list or the Google-native list above is
 * skipped — see the binary-lifecycle subsystem for non-text ingestion.
 */
const TEXT_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "application/xml",
  "text/xml",
]);

/**
 * Result of a single sync pass — exposed for richer test assertions.
 * Strict superset of `SyncIncrementalResult`.
 */
export interface GoogleDriveSyncResult extends SyncIncrementalResult {
  readonly skippedBinary: number;
  readonly skippedFolderScope: number;
  readonly skippedTooLarge: number;
}

/**
 * Validate and normalise raw config. Throws with a concrete message on any
 * malformed input — never silently defaults (CLAUDE.md gotcha #51).
 */
export function validateGoogleDriveConfig(raw: unknown): GoogleDriveConnectorConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(
      `googleDrive: config must be an object, got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw}`,
    );
  }
  const r = raw as Record<string, unknown>;
  const clientId = requireNonEmptyString(r.clientId, "clientId");
  const clientSecret = requireNonEmptyString(r[CLIENT_SECRET_FIELD], CLIENT_SECRET_FIELD);
  const refreshToken = requireNonEmptyString(r[REFRESH_TOKEN_FIELD], REFRESH_TOKEN_FIELD);

  let pollIntervalMs: number;
  if (r.pollIntervalMs === undefined) {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  } else if (typeof r.pollIntervalMs !== "number" || !Number.isFinite(r.pollIntervalMs)) {
    throw new TypeError(
      `googleDrive: pollIntervalMs must be a finite number (got ${JSON.stringify(r.pollIntervalMs)})`,
    );
  } else if (!Number.isInteger(r.pollIntervalMs)) {
    throw new TypeError(
      `googleDrive: pollIntervalMs must be an integer (got ${r.pollIntervalMs})`,
    );
  } else if (r.pollIntervalMs < 1_000) {
    throw new RangeError(
      `googleDrive: pollIntervalMs must be ≥1000ms; got ${r.pollIntervalMs}`,
    );
  } else if (r.pollIntervalMs > MAX_POLL_INTERVAL_MS) {
    throw new RangeError(
      `googleDrive: pollIntervalMs must be ≤${MAX_POLL_INTERVAL_MS} (24h); got ${r.pollIntervalMs}`,
    );
  } else {
    pollIntervalMs = r.pollIntervalMs;
  }

  let folderIds: readonly string[] = [];
  if (r.folderIds !== undefined) {
    if (!Array.isArray(r.folderIds)) {
      throw new TypeError(
        `googleDrive: folderIds must be an array of strings (got ${typeof r.folderIds})`,
      );
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of r.folderIds) {
      if (typeof value !== "string") {
        throw new TypeError(
          `googleDrive: folderIds entries must be strings; found ${typeof value}`,
        );
      }
      const trimmed = value.trim();
      if (!FOLDER_ID_PATTERN.test(trimmed)) {
        throw new RangeError(
          `googleDrive: folderIds entry ${JSON.stringify(value)} is not a valid Drive folder id`,
        );
      }
      // Dedupe per CLAUDE.md gotcha #49.
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    folderIds = Object.freeze(out);
  }

  return Object.freeze({
    clientId,
    [CLIENT_SECRET_FIELD]: clientSecret,
    [REFRESH_TOKEN_FIELD]: refreshToken,
    pollIntervalMs,
    folderIds,
  });
}

function requireNonEmptyString(value: unknown, key: string): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `googleDrive: ${key} must be a string (got ${typeof value})`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RangeError(`googleDrive: ${key} must be non-empty`);
  }
  return trimmed;
}

/**
 * Decide whether a Drive `change` corresponds to an importable text file
 * scoped to (optionally) the configured folder set.
 *
 * Returned object describes the disposition; callers update counters and
 * dispatch fetches accordingly.
 */
type ChangeDecision =
  | { kind: "import"; file: DriveFileMetadata; mode: "export" | "media"; exportMime?: string }
  | { kind: "skip-removed" }
  | { kind: "skip-trashed" }
  | { kind: "skip-binary" }
  | { kind: "skip-folder-scope" }
  | { kind: "skip-too-large" };

function decideChange(
  change: DriveChange,
  folderScope: ReadonlySet<string>,
): ChangeDecision {
  if (change.removed === true) return { kind: "skip-removed" };
  const file = change.file;
  if (!file || typeof file.id !== "string") return { kind: "skip-removed" };
  if (file.trashed === true) return { kind: "skip-trashed" };

  if (folderScope.size > 0) {
    const parents = file.parents ?? [];
    let intersects = false;
    for (const parent of parents) {
      if (folderScope.has(parent)) {
        intersects = true;
        break;
      }
    }
    if (!intersects) return { kind: "skip-folder-scope" };
  }

  if (typeof file.size === "number" && file.size > MAX_TEXT_BYTES) {
    return { kind: "skip-too-large" };
  }
  if (typeof file.size === "string") {
    const sizeNum = Number(file.size);
    if (Number.isFinite(sizeNum) && sizeNum > MAX_TEXT_BYTES) {
      return { kind: "skip-too-large" };
    }
  }

  const mime = file.mimeType;
  if (typeof mime !== "string" || mime.length === 0) {
    return { kind: "skip-binary" };
  }
  const exportMime = GOOGLE_NATIVE_EXPORT_MIME[mime];
  if (typeof exportMime === "string") {
    return { kind: "import", file, mode: "export", exportMime };
  }
  if (TEXT_MIME_ALLOWLIST.has(mime) || mime.startsWith("text/")) {
    return { kind: "import", file, mode: "media" };
  }
  return { kind: "skip-binary" };
}

/**
 * Construct the connector. The `clientFactory` argument is the test hook —
 * production callers omit it and the connector lazy-loads `googleapis`.
 */
export function createGoogleDriveConnector(
  options: { clientFactory?: GoogleDriveClientFactory } = {},
): LiveConnector {
  const clientFactory = options.clientFactory ?? defaultGoogleDriveClientFactory;

  return {
    id: GOOGLE_DRIVE_CONNECTOR_ID,
    displayName: "Google Drive",
    description:
      "Imports text content (Google Docs/Sheets/Slides + plain text) from a user's Drive into Remnic.",

    validateConfig(raw: unknown): ConnectorConfig {
      // Cast to ConnectorConfig (Record<string, unknown>) per framework
      // contract. The frozen object survives JSON round-trips through the
      // state store.
      return validateGoogleDriveConfig(raw) as unknown as ConnectorConfig;
    },

    async syncIncremental(args: SyncIncrementalArgs): Promise<SyncIncrementalResult> {
      // Re-validate on every pass: the framework persists raw config, and
      // a JS caller could mutate it between passes.
      const config = validateGoogleDriveConfig(args.config);
      throwIfAborted(args.abortSignal);

      const client = await clientFactory(config);
      throwIfAborted(args.abortSignal);

      // Cursor bootstrap. On the very first pass (cursor=null) we ask Drive
      // for a page token but DO NOT consume any changes — this aligns with
      // the documented Drive recipe and keeps "first install" from
      // re-importing the user's entire history. Subsequent passes consume
      // changes from the persisted token.
      let pageToken: string;
      const isFirstSync = args.cursor === null;
      if (isFirstSync) {
        const seed = await client.getStartPageToken();
        if (typeof seed?.startPageToken !== "string" || seed.startPageToken.length === 0) {
          throw new Error("googleDrive: drive.changes.getStartPageToken returned an empty token");
        }
        return {
          newDocs: [],
          nextCursor: makeCursor(seed.startPageToken),
        };
      } else if (args.cursor.kind !== GOOGLE_DRIVE_CURSOR_KIND) {
        throw new Error(
          `googleDrive: unexpected cursor kind ${JSON.stringify(args.cursor.kind)}; expected ${GOOGLE_DRIVE_CURSOR_KIND}`,
        );
      } else {
        pageToken = args.cursor.value;
      }

      const folderScope = new Set(config.folderIds);
      const fetchedAt = new Date().toISOString();
      const newDocs: ConnectorDocument[] = [];
      let skippedBinary = 0;
      let skippedFolderScope = 0;
      let skippedTooLarge = 0;
      let consumed = 0;
      let resolvedNextToken: string | undefined;

      // Page through `changes.list` until we run out, hit the per-pass cap,
      // or get aborted.
      while (true) {
        throwIfAborted(args.abortSignal);
        const remaining = MAX_CHANGES_PER_PASS - consumed;
        if (remaining <= 0) {
          // Hit the cap — persist whatever we have. The next pass resumes
          // from `pageToken`.
          resolvedNextToken = pageToken;
          break;
        }
        const pageSize = Math.min(100, remaining);
        const page = await client.listChanges({ pageToken, pageSize });

        for (const change of page.changes) {
          throwIfAborted(args.abortSignal);
          consumed++;
          const decision = decideChange(change, folderScope);
          switch (decision.kind) {
            case "import": {
              const doc = await fetchDocument(client, decision, fetchedAt, args.abortSignal);
              if (doc) newDocs.push(doc);
              break;
            }
            case "skip-binary":
              skippedBinary++;
              break;
            case "skip-folder-scope":
              skippedFolderScope++;
              break;
            case "skip-too-large":
              skippedTooLarge++;
              break;
            // skip-removed / skip-trashed are intentionally not counted —
            // they're upstream-driven and noisy.
            default:
              break;
          }
        }

        if (typeof page.newStartPageToken === "string" && page.newStartPageToken.length > 0) {
          // End of stream — the new start token is what we persist for the
          // next sync.
          resolvedNextToken = page.newStartPageToken;
          break;
        }
        if (typeof page.nextPageToken === "string" && page.nextPageToken.length > 0) {
          pageToken = page.nextPageToken;
          continue;
        }
        // Neither continuation nor end token — defensive bail to avoid a
        // tight loop on a malformed Drive response.
        resolvedNextToken = pageToken;
        break;
      }

      const nextCursor: ConnectorCursor = makeCursor(
        resolvedNextToken ?? pageToken,
      );

      const result: GoogleDriveSyncResult = {
        newDocs,
        nextCursor,
        skippedBinary,
        skippedFolderScope,
        skippedTooLarge,
      };
      return result;
    },
  };
}

function makeCursor(value: string): ConnectorCursor {
  return {
    kind: GOOGLE_DRIVE_CURSOR_KIND,
    value,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchDocument(
  client: GoogleDriveClient,
  decision: Extract<ChangeDecision, { kind: "import" }>,
  fetchedAt: string,
  abortSignal: AbortSignal | undefined,
): Promise<ConnectorDocument | null> {
  throwIfAborted(abortSignal);
  const file = decision.file;
  let body: string;
  try {
    body =
      decision.mode === "export"
        ? await client.exportFile({
            fileId: file.id,
            mimeType: decision.exportMime ?? "text/plain",
          })
        : await client.getFileMedia({ fileId: file.id });
  } catch (err) {
    // Distinguish terminal per-file errors (skip-and-continue) from
    // transient backend errors (re-throw so the caller can stop the pass
    // and retry on the next poll WITHOUT advancing the cursor past the
    // affected batch). Silently swallowing transient errors here would
    // permanently lose imports during outages: the cursor would advance,
    // and the file would never be retried unless its modifiedTime changed.
    if (isTransientDriveError(err)) {
      throw err;
    }
    // 404 / 403 etc.: log-and-skip is fine — the file is gone or we lack
    // access, and there's nothing useful to retry. We deliberately don't
    // log the file name (privacy).
    return null;
  }
  if (typeof body !== "string" || body.length === 0) return null;
  if (body.length > MAX_TEXT_BYTES) return null;

  return {
    id: file.id,
    title: typeof file.name === "string" && file.name.length > 0 ? file.name : undefined,
    content: body,
    source: {
      connector: GOOGLE_DRIVE_CONNECTOR_ID,
      externalId: file.id,
      externalRevision: typeof file.modifiedTime === "string" ? file.modifiedTime : undefined,
      externalUrl: typeof file.webViewLink === "string" ? file.webViewLink : undefined,
      fetchedAt,
    },
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const err = new Error("googleDrive: sync aborted");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Classify a per-file fetch error as "transient" (re-throw to caller so
 * the sync stops without advancing the cursor and the next poll retries)
 * vs. "terminal" (skip the file and continue — the file is gone, we lack
 * access, or the request was malformed in a non-recoverable way).
 *
 * `googleapis` surfaces errors as `GaxiosError` instances. We do NOT
 * `instanceof`-check that class because `googleapis` is an optional peer
 * dependency (CLAUDE.md gotcha #57); we'd have to import its types and
 * that would break the à-la-carte contract. Instead we read the
 * documented duck-typed shape: `{ code, status, response: { status }, name }`.
 *
 * Delegates to the shared `isTransientHttpError` helper in
 * `transient-errors.ts` (Thread 3 — Cursor PRRT_kwDORJXyws59sdH4). Drive
 * attaches no connector-specific status property, so `statusProps` is empty.
 */
export function isTransientDriveError(err: unknown): boolean {
  return isTransientHttpError(err);
}

/**
 * Minimal structural types for the slice of `googleapis` we consume. We
 * deliberately avoid `import type * from "googleapis"` because that would
 * require `googleapis` to be installed at type-check time in `@remnic/core`,
 * which violates the à-la-carte rule (CLAUDE.md gotcha #57). These types
 * intentionally cover only the fields we read.
 */
interface GoogleApisRoot {
  auth: {
    OAuth2: new (opts: { clientId: string; clientSecret: string }) => GoogleOAuth2Client;
  };
  drive(opts: { version: "v3"; auth: GoogleOAuth2Client }): GoogleDriveSdkClient;
}

interface GoogleOAuth2Client {
  setCredentials(creds: { refresh_token: string }): void;
}

interface GoogleDriveSdkClient {
  changes: {
    getStartPageToken(args: Record<string, never>): Promise<{ data: { startPageToken?: string | null } }>;
    list(args: {
      pageToken: string;
      pageSize: number;
      fields: string;
      spaces: string;
      includeRemoved: boolean;
    }): Promise<{
      data: {
        changes?: DriveChange[] | null;
        newStartPageToken?: string | null;
        nextPageToken?: string | null;
      };
    }>;
  };
  files: {
    export(
      params: { fileId: string; mimeType: string },
      opts: { responseType: "text" },
    ): Promise<{ data: unknown }>;
    get(
      params: { fileId: string; alt: "media" },
      opts: { responseType: "text" },
    ): Promise<{ data: unknown }>;
  };
}

/**
 * Production client factory. Lazy-loads `googleapis` via a computed-specifier
 * dynamic import so bundlers never statically resolve it (CLAUDE.md gotcha
 * #57). Surfaces a precise install hint on miss.
 *
 * Exported only for the `index.ts` barrel; consumers that already inject a
 * test factory don't need to touch this.
 */
export const defaultGoogleDriveClientFactory: GoogleDriveClientFactory = async (
  config,
) => {
  // Computed specifier. DO NOT replace with a string literal — bundlers
  // will eagerly resolve `import("googleapis")` and break à-la-carte.
  // We deliberately do not reference `typeof import("googleapis")` because
  // `@remnic/core` does not (and must not) declare `googleapis` as a hard
  // dependency or devDependency — its types would not be installed in the
  // base layout and `tsc --noEmit` would fail.
  const specifier = "google" + "apis";
  let mod: { google: GoogleApisRoot };
  try {
    mod = (await import(/* @vite-ignore */ specifier)) as { google: GoogleApisRoot };
  } catch (err) {
    throw new Error(
      "googleDrive: optional peer dependency `googleapis` is not installed. " +
        "Run `npm install googleapis` (or `pnpm add googleapis`) in the host package " +
        "to enable the Google Drive connector. " +
        `(underlying: ${(err as Error).message})`,
    );
  }
  const { google } = mod;
  const oauth = new google.auth.OAuth2({
    clientId: config.clientId,
    [CLIENT_SECRET_FIELD]: config[CLIENT_SECRET_FIELD],
  });
  oauth.setCredentials({ refresh_token: config[REFRESH_TOKEN_FIELD] });
  const drive = google.drive({ version: "v3", auth: oauth });

  return {
    async getStartPageToken() {
      const res = await drive.changes.getStartPageToken({});
      return { startPageToken: String(res.data.startPageToken ?? "") };
    },
    async listChanges({ pageToken, pageSize }) {
      const res = await drive.changes.list({
        pageToken,
        pageSize,
        fields:
          "newStartPageToken, nextPageToken, changes(removed, fileId, file(id, name, mimeType, modifiedTime, trashed, parents, webViewLink, size))",
        spaces: "drive",
        includeRemoved: true,
      });
      const data = res.data ?? {};
      return {
        changes: (data.changes ?? []) as DriveChange[],
        newStartPageToken: data.newStartPageToken ?? undefined,
        nextPageToken: data.nextPageToken ?? undefined,
      };
    },
    async exportFile({ fileId, mimeType }) {
      const res = await drive.files.export(
        { fileId, mimeType },
        { responseType: "text" as const },
      );
      return typeof res.data === "string" ? res.data : String(res.data ?? "");
    },
    async getFileMedia({ fileId }) {
      const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "text" as const },
      );
      return typeof res.data === "string" ? res.data : String(res.data ?? "");
    },
  };
};
