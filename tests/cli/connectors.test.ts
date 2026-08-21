/**
 * Tests for `remnic connectors list`, `remnic connectors status`, and
 * `remnic connectors run <name>` CLI helpers (issue #683 PR 6/N).
 *
 * All exercises pure functions from `connectors-cli.ts` — no orchestrator
 * needed.  Tests are organised into four suites:
 *
 *   1. Flag validation helpers
 *      (parseConnectorsFormat, parseConnectorsListOptions,
 *       parseConnectorsStatusOptions, parseConnectorsRunName)
 *   2. renderConnectorsList — text / markdown / json output
 *   3. renderConnectorsRunResult — text / markdown / json output
 *   4. Edge cases — empty lists, disabled connectors, error state
 *
 * Test data is fully synthetic (CLAUDE.md public-repo rule: no real
 * conversation content or user identifiers).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConnectorRowsFromDefinitions,
  parseConnectorsFormat,
  parseConnectorsListOptions,
  parseConnectorsRunName,
  parseConnectorsStatusOptions,
  renderConnectorsList,
  renderConnectorsRunResult,
  type ConnectorRow,
  type ConnectorRunResult,
} from "../../packages/remnic-core/src/connectors-cli.js";
import {
  GITHUB_CONNECTOR_ID,
  GMAIL_CONNECTOR_ID,
  GOOGLE_DRIVE_CONNECTOR_ID,
  NOTION_CONNECTOR_ID,
  type ConnectorState,
} from "../../packages/remnic-core/src/connectors/live/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<ConnectorState> = {}): ConnectorState {
  return {
    id: "google-drive",
    cursor: null,
    lastSyncAt: "2026-04-01T12:00:00.000Z",
    lastSyncStatus: "success",
    totalDocsImported: 42,
    updatedAt: "2026-04-01T12:00:00.000Z",
    ...overrides,
  };
}

function makeRow(overrides: Partial<ConnectorRow> = {}): ConnectorRow {
  return {
    id: "google-drive",
    displayName: "Google Drive",
    enabled: true,
    state: makeState(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Flag validation
// ─────────────────────────────────────────────────────────────────────────────

test("parseConnectorsFormat: returns default 'text' when value is undefined", () => {
  assert.equal(parseConnectorsFormat(undefined), "text");
});

test("parseConnectorsFormat: returns default 'json' when caller specifies it", () => {
  assert.equal(parseConnectorsFormat(undefined, "json"), "json");
});

test("parseConnectorsFormat: accepts all valid formats", () => {
  assert.equal(parseConnectorsFormat("text"), "text");
  assert.equal(parseConnectorsFormat("markdown"), "markdown");
  assert.equal(parseConnectorsFormat("json"), "json");
});

test("parseConnectorsFormat: throws on unknown format", () => {
  assert.throws(
    () => parseConnectorsFormat("csv"),
    /--format expects one of text, markdown, json/,
  );
});

test("parseConnectorsFormat: throws on non-string", () => {
  assert.throws(
    () => parseConnectorsFormat(42),
    /--format expects one of/,
  );
});

test("parseConnectorsListOptions: defaults to text format", () => {
  const opts = parseConnectorsListOptions({});
  assert.equal(opts.format, "text");
});

test("parseConnectorsListOptions: forwards format", () => {
  const opts = parseConnectorsListOptions({ format: "json" });
  assert.equal(opts.format, "json");
});

test("parseConnectorsListOptions: throws on bad format", () => {
  assert.throws(
    () => parseConnectorsListOptions({ format: "xml" }),
    /--format expects/,
  );
});

test("parseConnectorsStatusOptions: defaults to json format", () => {
  const opts = parseConnectorsStatusOptions({});
  assert.equal(opts.format, "json");
});

test("parseConnectorsStatusOptions: allows format override", () => {
  const opts = parseConnectorsStatusOptions({ format: "text" });
  assert.equal(opts.format, "text");
});

test("parseConnectorsRunName: returns trimmed name", () => {
  assert.equal(parseConnectorsRunName("  google-drive  "), "google-drive");
});

test("parseConnectorsRunName: throws on undefined", () => {
  assert.throws(
    () => parseConnectorsRunName(undefined),
    /connectors run: <name> is required/,
  );
});

test("parseConnectorsRunName: throws on empty string", () => {
  assert.throws(
    () => parseConnectorsRunName("   "),
    /connectors run: <name> is required/,
  );
});

test("parseConnectorsRunName: throws on non-string", () => {
  assert.throws(
    () => parseConnectorsRunName(123),
    /connectors run: <name> is required/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. renderConnectorsList
// ─────────────────────────────────────────────────────────────────────────────

test("renderConnectorsList: empty list → text fallback", () => {
  const out = renderConnectorsList([], "text");
  assert.ok(out.includes("No live connectors"));
  assert.ok(!out.includes("undefined"));
});

test("renderConnectorsList: empty list → markdown fallback", () => {
  const out = renderConnectorsList([], "markdown");
  assert.ok(out.includes("# Live connectors"));
  assert.ok(out.includes("No live connectors are configured"));
});

test("renderConnectorsList: empty list → json empty array", () => {
  const out = renderConnectorsList([], "json");
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 0);
});

test("renderConnectorsList text: shows connector id and key fields", () => {
  const rows: ConnectorRow[] = [makeRow()];
  const out = renderConnectorsList(rows, "text");
  assert.ok(out.includes("google-drive"));
  assert.ok(out.includes("Google Drive"));
  assert.ok(out.includes("enabled"));
  assert.ok(out.includes("2026-04-01"));
  assert.ok(out.includes("42"));
});

test("renderConnectorsList text: disabled connector shows disabled state", () => {
  const rows: ConnectorRow[] = [
    makeRow({ enabled: false, state: makeState({ lastSyncStatus: "never" }) }),
  ];
  const out = renderConnectorsList(rows, "text");
  assert.ok(out.includes("disabled"));
});

test("renderConnectorsList text: disabled connector does NOT produce 'disabled, disabled' (statusLabel regression)", () => {
  // Before the fix, statusLabel() returned "disabled" for enabled=false
  // connectors, producing "state: disabled, disabled" — the enabled/disabled
  // badge was already rendered by enabledStr, so the status label would
  // duplicate it.  Now statusLabel only maps sync statuses.
  const rows: ConnectorRow[] = [
    makeRow({ enabled: false, state: makeState({ lastSyncStatus: "never" }) }),
  ];
  const out = renderConnectorsList(rows, "text");
  // Must NOT contain the redundant double-label.
  assert.ok(
    !out.includes("disabled, disabled"),
    `output must not contain 'disabled, disabled': ${out}`,
  );
  // The state line should read "disabled, never synced".
  assert.ok(
    out.includes("disabled, never synced"),
    `expected 'disabled, never synced' in output: ${out}`,
  );
});

test("renderConnectorsList text: disabled connector with prior error shows real sync status", () => {
  // Disabled connectors that previously errored should show their real last
  // sync status (error), not just "disabled" in the status column.
  const rows: ConnectorRow[] = [
    makeRow({
      enabled: false,
      state: makeState({ lastSyncStatus: "error", lastSyncError: "auth_failed" }),
    }),
  ];
  const out = renderConnectorsList(rows, "text");
  assert.ok(out.includes("disabled"));
  assert.ok(out.includes("error"), `expected 'error' in output: ${out}`);
  assert.ok(!out.includes("disabled, disabled"), "must not duplicate disabled label");
});

test("renderConnectorsList markdown: disabled connector does not duplicate 'disabled' in Status column", () => {
  // In markdown, the Enabled column shows "no" for disabled connectors, so
  // the Status column must show the real sync status, not "disabled".
  const rows: ConnectorRow[] = [
    makeRow({ enabled: false, state: makeState({ lastSyncStatus: "never" }) }),
  ];
  const out = renderConnectorsList(rows, "markdown");
  // Enabled column shows "no".
  assert.ok(out.includes("no"));
  // Status column must not say "disabled" (that would duplicate the Enabled col).
  // It should say "never synced".
  assert.ok(
    out.includes("never synced"),
    `expected 'never synced' status in markdown: ${out}`,
  );
});

test("renderConnectorsList text: error state shows last_error", () => {
  const rows: ConnectorRow[] = [
    makeRow({
      state: makeState({
        lastSyncStatus: "error",
        lastSyncError: "rate limit exceeded",
      }),
    }),
  ];
  const out = renderConnectorsList(rows, "text");
  assert.ok(out.includes("rate limit exceeded"));
  assert.ok(out.includes("error"));
});

test("renderConnectorsList text: null state shows never polled", () => {
  const rows: ConnectorRow[] = [makeRow({ state: null })];
  const out = renderConnectorsList(rows, "text");
  assert.ok(out.includes("never polled") || out.includes("never synced") || out.includes("(never polled)"));
});

test("renderConnectorsList markdown: produces table with headers", () => {
  const rows: ConnectorRow[] = [makeRow()];
  const out = renderConnectorsList(rows, "markdown");
  assert.ok(out.includes("# Live connectors"));
  assert.ok(out.includes("| ID |"));
  assert.ok(out.includes("google-drive"));
  assert.ok(out.includes("yes")); // enabled
});

test("renderConnectorsList markdown: error row adds error sub-row", () => {
  const rows: ConnectorRow[] = [
    makeRow({
      state: makeState({
        lastSyncStatus: "error",
        lastSyncError: "auth_failed",
      }),
    }),
  ];
  const out = renderConnectorsList(rows, "markdown");
  assert.ok(out.includes("auth_failed"));
});

test("renderConnectorsList json: round-trips all fields", () => {
  const rows: ConnectorRow[] = [
    makeRow(),
    makeRow({
      id: "notion",
      displayName: "Notion",
      enabled: false,
      state: null,
    }),
  ];
  const out = renderConnectorsList(rows, "json");
  const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, "google-drive");
  assert.equal(parsed[0].enabled, true);
  assert.equal(parsed[0].lastSyncStatus, "success");
  assert.equal(parsed[0].totalDocsImported, 42);
  assert.equal(parsed[1].id, "notion");
  assert.equal(parsed[1].enabled, false);
  assert.equal(parsed[1].lastSyncStatus, "never");
  assert.equal(parsed[1].totalDocsImported, 0);
  assert.equal(parsed[1].lastSyncAt, null);
});

test("renderConnectorsList json: no lastSyncError field when state is null", () => {
  const rows: ConnectorRow[] = [makeRow({ state: null })];
  const out = renderConnectorsList(rows, "json");
  const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
  assert.equal(parsed[0].lastSyncError, null);
});

test("renderConnectorsList json: includes lastSyncError when present", () => {
  const rows: ConnectorRow[] = [
    makeRow({
      state: makeState({ lastSyncStatus: "error", lastSyncError: "network error" }),
    }),
  ];
  const out = renderConnectorsList(rows, "json");
  const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
  assert.equal(parsed[0].lastSyncError, "network error");
});

test("renderConnectorsList: multiple connectors sorted by id are all rendered", () => {
  const rows: ConnectorRow[] = [
    makeRow({ id: "notion", displayName: "Notion" }),
    makeRow({ id: "google-drive", displayName: "Google Drive" }),
  ];
  const out = renderConnectorsList(rows, "text");
  assert.ok(out.includes("notion"));
  assert.ok(out.includes("google-drive"));
});

test("buildConnectorRowsFromDefinitions includes Drive, Notion, Gmail, and GitHub rows", () => {
  const rows = buildConnectorRowsFromDefinitions(
    [
      { id: GOOGLE_DRIVE_CONNECTOR_ID, displayName: "Google Drive", enabled: true },
      { id: NOTION_CONNECTOR_ID, displayName: "Notion", enabled: true },
      { id: GMAIL_CONNECTOR_ID, displayName: "Gmail", enabled: true },
      { id: GITHUB_CONNECTOR_ID, displayName: "GitHub", enabled: true },
    ],
    [
      makeState({
        id: GMAIL_CONNECTOR_ID,
        totalDocsImported: 7,
      }),
    ],
  );

  assert.deepEqual(rows.map((row) => row.id), [
    GOOGLE_DRIVE_CONNECTOR_ID,
    NOTION_CONNECTOR_ID,
    GMAIL_CONNECTOR_ID,
    GITHUB_CONNECTOR_ID,
  ]);
  assert.equal(rows.find((row) => row.id === GMAIL_CONNECTOR_ID)?.state?.totalDocsImported, 7);

  const json = JSON.parse(renderConnectorsList(rows, "json")) as Array<{ id: string }>;
  assert.deepEqual(json.map((row) => row.id), [
    GOOGLE_DRIVE_CONNECTOR_ID,
    NOTION_CONNECTOR_ID,
    GMAIL_CONNECTOR_ID,
    GITHUB_CONNECTOR_ID,
  ]);
  assert.equal(parseConnectorsRunName(GMAIL_CONNECTOR_ID), GMAIL_CONNECTOR_ID);
  assert.equal(parseConnectorsRunName(GITHUB_CONNECTOR_ID), GITHUB_CONNECTOR_ID);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. renderConnectorsRunResult
// ─────────────────────────────────────────────────────────────────────────────

test("renderConnectorsRunResult text: success", () => {
  const result: ConnectorRunResult = { docsImported: 7 };
  const out = renderConnectorsRunResult("google-drive", result, "text");
  assert.ok(out.includes("google-drive"));
  assert.ok(out.includes("OK"));
  assert.ok(out.includes("7"));
});

test("renderConnectorsRunResult text: failure", () => {
  const result: ConnectorRunResult = { docsImported: 0, error: "invalid_token" };
  const out = renderConnectorsRunResult("notion", result, "text");
  assert.ok(out.includes("notion"));
  assert.ok(out.includes("FAILED"));
  assert.ok(out.includes("invalid_token"));
});

test("renderConnectorsRunResult markdown: success", () => {
  const result: ConnectorRunResult = { docsImported: 3 };
  const out = renderConnectorsRunResult("google-drive", result, "markdown");
  assert.ok(out.includes("# connectors run"));
  assert.ok(out.includes("success"));
  assert.ok(out.includes("3"));
  assert.ok(!out.includes("Error:"));
});

test("renderConnectorsRunResult markdown: failure includes error", () => {
  const result: ConnectorRunResult = { docsImported: 0, error: "timeout" };
  const out = renderConnectorsRunResult("notion", result, "markdown");
  assert.ok(out.includes("error"));
  assert.ok(out.includes("timeout"));
});

test("renderConnectorsRunResult text: error-state write failure does not claim docs were ingested", () => {
  const result: ConnectorRunResult = {
    docsImported: 0,
    error: "sync_failed",
    stateWriteError: "state_write_failed",
  };
  const out = renderConnectorsRunResult("github", result, "text");
  assert.ok(out.includes("sync_failed"));
  assert.ok(out.includes("state_write_failed"));
  assert.ok(out.includes("error state was not persisted"));
  assert.ok(!out.includes("docs were ingested"));
});

test("renderConnectorsRunResult json: success shape", () => {
  const result: ConnectorRunResult = { docsImported: 5 };
  const out = renderConnectorsRunResult("google-drive", result, "json");
  const parsed = JSON.parse(out) as Record<string, unknown>;
  assert.equal(parsed.connector, "google-drive");
  assert.equal(parsed.docsImported, 5);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.error, null);
});

test("renderConnectorsRunResult json: failure shape", () => {
  const result: ConnectorRunResult = { docsImported: 0, error: "creds_missing" };
  const out = renderConnectorsRunResult("notion", result, "json");
  const parsed = JSON.parse(out) as Record<string, unknown>;
  assert.equal(parsed.connector, "notion");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "creds_missing");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Edge cases
// ─────────────────────────────────────────────────────────────────────────────

test("renderConnectorsList: pipe characters in error message are escaped in markdown", () => {
  const rows: ConnectorRow[] = [
    makeRow({
      state: makeState({
        lastSyncStatus: "error",
        lastSyncError: "field1 | field2",
      }),
    }),
  ];
  const out = renderConnectorsList(rows, "markdown");
  // Pipes in the error should be escaped so the table doesn't break
  assert.ok(out.includes("field1 \\| field2"));
});

test("renderConnectorsList: zero docs imported is shown correctly", () => {
  const rows: ConnectorRow[] = [
    makeRow({ state: makeState({ totalDocsImported: 0 }) }),
  ];
  const out = renderConnectorsList(rows, "text");
  assert.ok(out.includes("0"));
});

test("renderConnectorsList json: connector with never-synced state has correct defaults", () => {
  const rows: ConnectorRow[] = [
    makeRow({
      id: "notion",
      displayName: "Notion",
      enabled: true,
      state: makeState({
        id: "notion",
        cursor: null,
        lastSyncAt: null,
        lastSyncStatus: "never",
        totalDocsImported: 0,
      }),
    }),
  ];
  const out = renderConnectorsList(rows, "json");
  const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
  assert.equal(parsed[0].lastSyncAt, null);
  assert.equal(parsed[0].lastSyncStatus, "never");
  assert.equal(parsed[0].totalDocsImported, 0);
});

test("parseConnectorsFormat: null value returns given default", () => {
  assert.equal(parseConnectorsFormat(null, "markdown"), "markdown");
});
