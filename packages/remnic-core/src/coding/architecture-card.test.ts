/**
 * Tests for the architecture-card pure builder (issue #1548 Track A PR 3).
 *
 * Contract under test:
 *  - Deterministic: two runs over the same fixture produce byte-identical
 *    output (rule 38 — everything sorted before serialising).
 *  - Capped: card truncated with a visible marker when it exceeds the
 *    byte limit (rule 34 — never silently incomplete).
 *  - Invalid input rejected with a tagged failure (rule 51).
 *  - LLM summary: opt-in, deterministic card ships unchanged on failure
 *    (rules 13, 48).
 *
 * All fixtures are synthetic temp dirs — no real repos (public-repo policy).
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildArchitectureCard,
  createArchitectureCardSummariser,
  type ArchitectureCardLlmClient,
  ARCHITECTURE_CARD_MAX_BYTES,
} from "./architecture-card.js";

// ──────────────────────────────────────────────────────────────────────────
// Fixture builder — synthetic repo tree in a temp dir
// ──────────────────────────────────────────────────────────────────────────

async function makeFixtureRepo(overrides: {
  files?: Array<{ path: string; content?: string }>;
  dirs?: string[];
} = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "archcard-"));
  for (const d of overrides.dirs ?? []) {
    await mkdir(path.join(dir, d), { recursive: true });
  }
  for (const f of overrides.files ?? []) {
    const fullPath = path.join(dir, f.path);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, f.content ?? "", "utf-8");
  }
  return dir;
}

const NOW = new Date("2026-07-05T12:00:00.000Z");

// ──────────────────────────────────────────────────────────────────────────
// Determinism — byte-stable across two runs (rule 38)
// ──────────────────────────────────────────────────────────────────────────

test("deterministic: two runs over the same fixture produce byte-identical output", async () => {
  const repo = await makeFixtureRepo({
    dirs: ["src", "tests", "docs", "node_modules", ".git"],
    files: [
      { path: "package.json", content: JSON.stringify({ name: "test-repo", main: "src/index.ts", scripts: { start: "node ." } }) },
      { path: "src/index.ts", content: "export const x = 1;" },
      { path: "src/utils.ts", content: "export const y = 2;" },
      { path: "src/helper.py", content: "x = 1" },
      { path: "tests/a.test.ts", content: "test;" },
      { path: "README.md", content: "# Test" },
    ],
  });
  try {
    const result1 = await buildArchitectureCard(repo, { now: NOW });
    const result2 = await buildArchitectureCard(repo, { now: NOW });
    assert.equal(result1.ok, true);
    assert.equal(result2.ok, true);
    if (!result1.ok || !result2.ok) return;
    assert.equal(result1.card.content, result2.card.content, "byte-identical content");
    assert.equal(result1.card.generatedAt, NOW.toISOString());
    assert.equal(result1.card.byteSize, result2.card.byteSize);
    assert.equal(result1.card.truncated, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Sorted output — directories, manifests, histogram all sorted (rule 38)
// ──────────────────────────────────────────────────────────────────────────

test("sorted: top-level directories appear in lexicographic order", async () => {
  const repo = await makeFixtureRepo({
    dirs: ["zebra", "alpha", "monkey", "node_modules"],
    files: [{ path: "package.json", content: "{}" }],
  });
  try {
    const result = await buildArchitectureCard(repo, { now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.card.content.includes("alpha"), "alpha present");
    const alphaIdx = result.card.content.indexOf("alpha");
    const monkeyIdx = result.card.content.indexOf("monkey");
    const zebraIdx = result.card.content.indexOf("zebra");
    assert.ok(alphaIdx < monkeyIdx, "alpha before monkey");
    assert.ok(monkeyIdx < zebraIdx, "monkey before zebra");
    assert.equal(result.card.content.includes("node_modules"), false, "node_modules skipped");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("sorted: language histogram by count desc, then ext alpha", async () => {
  const repo = await makeFixtureRepo({
    dirs: ["src"],
    files: [
      { path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" },
      { path: "src/a.py" }, { path: "src/b.py" },
      { path: "src/a.js" },
    ],
  });
  try {
    const result = await buildArchitectureCard(repo, { now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // .ts (3) should appear before .py (2) before .js (1)
    const tsIdx = result.card.content.indexOf(".ts:");
    const pyIdx = result.card.content.indexOf(".py:");
    const jsIdx = result.card.content.indexOf(".js:");
    assert.ok(tsIdx > -1 && pyIdx > -1 && jsIdx > -1, "all exts present");
    assert.ok(tsIdx < pyIdx, ".ts before .py");
    assert.ok(pyIdx < jsIdx, ".py before .js");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Byte cap — truncation marker visible (rule 34)
// ──────────────────────────────────────────────────────────────────────────

test("capped: card truncated with visible marker when exceeding maxBytes", async () => {
  const dirs = Array.from({ length: 200 }, (_, i) => `dir${String(i).padStart(3, "0")}`);
  const files = dirs.map((d) => ({ path: `${d}/file.txt`, content: "x".repeat(50) }));
  const repo = await makeFixtureRepo({ dirs, files });
  try {
    const result = await buildArchitectureCard(repo, { now: NOW, maxBytes: 500 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.card.truncated, true);
    assert.ok(result.card.content.includes("truncated"), "truncation marker visible");
    assert.ok(result.card.byteSize <= 500, "byte size within cap");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("uncapped: normal fixture fits without truncation", async () => {
  const repo = await makeFixtureRepo({
    files: [{ path: "package.json", content: JSON.stringify({ name: "small" }) }],
  });
  try {
    const result = await buildArchitectureCard(repo, { now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.card.truncated, false);
    assert.ok(result.card.byteSize <= ARCHITECTURE_CARD_MAX_BYTES);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Invalid input — tagged failures (rule 51)
// ──────────────────────────────────────────────────────────────────────────

test("invalid: empty repoRoot rejected with invalid_root", async () => {
  const result = await buildArchitectureCard("");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "invalid_root");
});

test("invalid: non-existent path rejected with invalid_root", async () => {
  const result = await buildArchitectureCard("/definitely/does/not/exist/repo-xyz");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "invalid_root");
});

test("invalid: path that is a file, not a directory, rejected", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "archcard-file-"));
  const filePath = path.join(dir, "not-a-dir.txt");
  await writeFile(filePath, "hello", "utf-8");
  try {
    const result = await buildArchitectureCard(filePath);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_root");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid: unreadable root surfaces scan_failed, not a silent empty card (codex review)", async () => {
  // Skip under root — root bypasses permission bits so the readdir would
  // succeed and the assertion would be meaningless.
  if (process.getuid?.() === 0) return;
  const repo = await makeFixtureRepo({
    files: [{ path: "package.json", content: JSON.stringify({ name: "guarded" }) }],
  });
  try {
    await chmod(repo, 0o000);
    const result = await buildArchitectureCard(repo, { now: NOW });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "scan_failed", "unreadable root is scan_failed, not a sparse success");
  } finally {
    // Restore perms so rm can clean up.
    await chmod(repo, 0o755).catch(() => {});
    await rm(repo, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Manifest parse — project name + entry points surface in the card
// ──────────────────────────────────────────────────────────────────────────

test("manifest: package.json name and entry points surface in card", async () => {
  const repo = await makeFixtureRepo({
    files: [{
      path: "package.json",
      content: JSON.stringify({
        name: "my-pkg",
        main: "src/index.ts",
        bin: { "my-cli": "src/cli.ts" },
        scripts: { start: "node .", dev: "tsx watch" },
      }),
    }],
  });
  try {
    const result = await buildArchitectureCard(repo, { now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.card.content.includes("my-pkg"), "project name surfaced");
    assert.ok(result.card.content.includes("src/index.ts"), "main entry surfaced");
    assert.ok(result.card.content.includes("src/cli.ts"), "bin target path surfaced");
    assert.ok(result.card.content.includes("scripts.start"), "start script surfaced");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("manifest: multiple manifests all listed sorted", async () => {
  const repo = await makeFixtureRepo({
    files: [
      { path: "package.json", content: JSON.stringify({ name: "ts-side" }) },
      { path: "go.mod", content: "module github.com/example/go-side\n\ngo 1.21\n" },
    ],
  });
  try {
    const result = await buildArchitectureCard(repo, { now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const pkgIdx = result.card.content.indexOf("package.json");
    const goIdx = result.card.content.indexOf("go.mod");
    assert.ok(pkgIdx > -1 && goIdx > -1, "both manifests present");
    // Alphabetical order: go.mod (g) before package.json (p)
    assert.ok(goIdx < pkgIdx, "go.mod before package.json (sorted)");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// LLM summary — opt-in, deterministic card on failure (rules 13, 48)
// ──────────────────────────────────────────────────────────────────────────

test("llm summary: off by default — no summariser call", async () => {
  const repo = await makeFixtureRepo({
    files: [{ path: "package.json", content: "{}" }],
  });
  let called = false;
  try {
    const result = await buildArchitectureCard(repo, {
      now: NOW,
      summariser: async () => { called = true; return "SUMMARY"; },
    });
    assert.equal(result.ok, true);
    assert.equal(called, false, "summariser not called when llmSummary is off/default");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("llm summary: on — summary prepended before deterministic card", async () => {
  const repo = await makeFixtureRepo({
    files: [{ path: "package.json", content: JSON.stringify({ name: "test" }) }],
  });
  try {
    const result = await buildArchitectureCard(repo, {
      now: NOW,
      llmSummary: true,
      summariser: async () => "## Overview\n\nThis is a test repo.",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.card.content.startsWith("## Overview"), "summary prepended");
    assert.ok(result.card.content.includes("---"), "separator between summary and deterministic card");
    assert.ok(result.card.content.includes("Architecture Card"), "deterministic card still present");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("llm summary: summariser failure → deterministic card unchanged (rule 13)", async () => {
  const repo = await makeFixtureRepo({
    files: [{ path: "package.json", content: JSON.stringify({ name: "test" }) }],
  });
  try {
    const deterministic = await buildArchitectureCard(repo, { now: NOW });
    assert.equal(deterministic.ok, true);

    const withFailingLlm = await buildArchitectureCard(repo, {
      now: NOW,
      llmSummary: true,
      summariser: async () => { throw new Error("LLM down"); },
    });
    assert.equal(withFailingLlm.ok, true);
    if (!deterministic.ok || !withFailingLlm.ok) return;
    assert.equal(withFailingLlm.card.content, deterministic.card.content, "deterministic card unchanged on LLM failure");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("llm summary: null return → deterministic card unchanged", async () => {
  const repo = await makeFixtureRepo({
    files: [{ path: "package.json", content: JSON.stringify({ name: "test" }) }],
  });
  try {
    const deterministic = await buildArchitectureCard(repo, { now: NOW });
    const withNullLlm = await buildArchitectureCard(repo, {
      now: NOW,
      llmSummary: true,
      summariser: async () => null,
    });
    assert.equal(deterministic.ok, true);
    assert.equal(withNullLlm.ok, true);
    if (!deterministic.ok || !withNullLlm.ok) return;
    assert.equal(withNullLlm.card.content, deterministic.card.content);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// createArchitectureCardSummariser — factory wiring (rule 48)
// ──────────────────────────────────────────────────────────────────────────

/** Structural stub satisfying ArchitectureCardLlmClient — no cast needed. */
function makeStubLlmClient(content: string | null): ArchitectureCardLlmClient {
  return {
    async chatCompletion() {
      return content === null ? null : { content };
    },
  };
}

test("summariser factory: null client → undefined (builder LLM branch stays inert)", () => {
  assert.equal(createArchitectureCardSummariser(null), undefined);
});

test("summariser factory: client → summariser prepends overview end-to-end", async () => {
  const repo = await makeFixtureRepo({
    files: [{ path: "package.json", content: JSON.stringify({ name: "test" }) }],
  });
  try {
    const summariser = createArchitectureCardSummariser(makeStubLlmClient("## Overview\n\nA test repo."));
    assert.ok(summariser, "summariser defined for a real client");
    const result = await buildArchitectureCard(repo, { now: NOW, llmSummary: true, summariser });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.card.content.startsWith("## Overview"), "factory-built summary prepended");
    assert.ok(result.card.content.includes("---"), "separator present");
    assert.ok(result.card.content.includes("Architecture Card"), "deterministic card still present");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("summariser factory: chatCompletion returning null → deterministic card unchanged (rule 13)", async () => {
  const repo = await makeFixtureRepo({
    files: [{ path: "package.json", content: JSON.stringify({ name: "test" }) }],
  });
  try {
    const deterministic = await buildArchitectureCard(repo, { now: NOW });
    const summariser = createArchitectureCardSummariser(makeStubLlmClient(null));
    assert.ok(summariser);
    const withNullClient = await buildArchitectureCard(repo, { now: NOW, llmSummary: true, summariser });
    assert.equal(deterministic.ok, true);
    assert.equal(withNullClient.ok, true);
    if (!deterministic.ok || !withNullClient.ok) return;
    assert.equal(withNullClient.card.content, deterministic.card.content);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("summariser factory: records the LLM operation tag (background priority)", async () => {
  let captured: { operation?: string; priority?: string } | undefined;
  const client: ArchitectureCardLlmClient = {
    async chatCompletion(_messages, options) {
      captured = options;
      return { content: "summary" };
    },
  };
  const summariser = createArchitectureCardSummariser(client);
  assert.ok(summariser);
  await summariser("card", "/repo");
  assert.equal(captured?.operation, "architecture-card-summary");
  assert.equal(captured?.priority, "background");
});

// ──────────────────────────────────────────────────────────────────────────
// Privacy — file contents never read except manifests
// ──────────────────────────────────────────────────────────────────────────

test("privacy: non-manifest file contents are not read (only extensions counted)", async () => {
  const repo = await makeFixtureRepo({
    files: [
      { path: "src/secret.ts", content: "SECRET_VALUE_SHOULD_NOT_APPEAR" },
      { path: "package.json", content: JSON.stringify({ name: "test" }) },
    ],
  });
  try {
    const result = await buildArchitectureCard(repo, { now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.card.content.includes("SECRET_VALUE"), false, "non-manifest file content never surfaced");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Empty repo — graceful, not a crash
// ──────────────────────────────────────────────────────────────────────────

test("empty repo: produces a valid (if sparse) card without crashing", async () => {
  const repo = await makeFixtureRepo();
  try {
    const result = await buildArchitectureCard(repo, { now: NOW });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.card.content.includes("Architecture Card"), "title always present");
    assert.equal(result.card.truncated, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
