import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import {
  publisherFor,
  publisherForConnector,
  hostIdForConnector,
  registerPublisher,
  PUBLISHERS,
  CodexMemoryExtensionPublisher,
  ClaudeCodeMemoryExtensionPublisher,
  HermesMemoryExtensionPublisher,
  REMNIC_SEMANTIC_OVERVIEW,
  REMNIC_CITATION_FORMAT,
  REMNIC_MCP_TOOL_INVENTORY,
  REMNIC_RECALL_DECISION_RULES,
} from "../packages/remnic-core/src/memory-extension/index.js";

import type { PublishContext } from "../packages/remnic-core/src/memory-extension/types.js";

// Register host-specific publishers for testing.
// In production this happens in @remnic/cli (the host adapter layer).
registerPublisher("codex", () => new CodexMemoryExtensionPublisher());
registerPublisher("claude-code", () => new ClaudeCodeMemoryExtensionPublisher());
registerPublisher("hermes", () => new HermesMemoryExtensionPublisher());

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTestContext(overrides: Partial<PublishContext> = {}): PublishContext {
  return {
    config: {
      memoryDir: "/tmp/test-remnic-memory",
      daemonPort: 4242,
      namespace: "test-ns",
    },
    skillsRoot: "/tmp/test-remnic-memory/skills",
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    ...overrides,
  };
}

// ── Registry tests ─────────────────────────────────────────────────────────

test("publisherFor('codex') returns CodexMemoryExtensionPublisher", () => {
  const pub = publisherFor("codex");
  assert.ok(pub, "expected a publisher for codex");
  assert.equal(pub.hostId, "codex");
  assert.ok(pub instanceof CodexMemoryExtensionPublisher);
});

test("publisherFor('claude-code') returns stub with isHostAvailable() === false", async () => {
  const pub = publisherFor("claude-code");
  assert.ok(pub, "expected a publisher for claude-code");
  assert.equal(pub.hostId, "claude-code");
  assert.ok(pub instanceof ClaudeCodeMemoryExtensionPublisher);
  const available = await pub.isHostAvailable();
  assert.equal(available, false);
});

test("publisherFor('hermes') returns stub with isHostAvailable() === false", async () => {
  const pub = publisherFor("hermes");
  assert.ok(pub, "expected a publisher for hermes");
  assert.equal(pub.hostId, "hermes");
  assert.ok(pub instanceof HermesMemoryExtensionPublisher);
  const available = await pub.isHostAvailable();
  assert.equal(available, false);
});

test("publisherFor('unknown') returns undefined", () => {
  const pub = publisherFor("unknown-host-xyz");
  assert.equal(pub, undefined);
});

test("PUBLISHERS registry has entries for codex, claude-code, hermes", () => {
  assert.ok("codex" in PUBLISHERS);
  assert.ok("claude-code" in PUBLISHERS);
  assert.ok("hermes" in PUBLISHERS);
});

// ── Codex publisher ────────────────────────────────────────────────────────

test("Codex publisher: resolveExtensionRoot uses CODEX_HOME env", async () => {
  const pub = new CodexMemoryExtensionPublisher();
  const root = await pub.resolveExtensionRoot({
    HOME: "/home/test",
    CODEX_HOME: "/custom/codex",
  });
  assert.equal(root, path.join("/custom/codex", "memories_extensions", "remnic"));
});

test("Codex publisher: resolveExtensionRoot normalizes relative CODEX_HOME to an absolute path", async () => {
  const pub = new CodexMemoryExtensionPublisher();
  const root = await pub.resolveExtensionRoot({
    HOME: "/home/test",
    CODEX_HOME: "relative-codex",
  });
  assert.equal(path.isAbsolute(root), true);
  assert.equal(root, path.join(path.resolve("relative-codex"), "memories_extensions", "remnic"));
});

test("Codex publisher: resolveExtensionRoot expands tilde CODEX_HOME with injected home", async () => {
  const pub = new CodexMemoryExtensionPublisher();
  const root = await pub.resolveExtensionRoot({
    HOME: "/home/test",
    CODEX_HOME: "~/custom-codex",
  });
  assert.equal(root, path.join("/home/test", "custom-codex", "memories_extensions", "remnic"));
});

test("Codex publisher: resolveExtensionRoot falls back to ~/.codex", async () => {
  const pub = new CodexMemoryExtensionPublisher();
  const root = await pub.resolveExtensionRoot({ HOME: "/home/test" });
  assert.equal(root, path.join("/home/test", ".codex", "memories_extensions", "remnic"));
});

test("Codex publisher: resolveExtensionRoot does not read ambient CODEX_HOME when env is injected", async () => {
  const pub = new CodexMemoryExtensionPublisher();
  const previousCodexHome = process.env.CODEX_HOME;

  process.env.CODEX_HOME = "/ambient/codex";
  try {
    const root = await pub.resolveExtensionRoot({ HOME: "/home/injected" });
    assert.equal(root, path.join("/home/injected", ".codex", "memories_extensions", "remnic"));
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test("Codex publisher: resolveExtensionRoot falls back to an absolute home when injected env has no home keys", async () => {
  const pub = new CodexMemoryExtensionPublisher();
  const root = await pub.resolveExtensionRoot({});
  assert.equal(root, path.join(os.homedir(), ".codex", "memories_extensions", "remnic"));
  assert.equal(path.isAbsolute(root), true);
});

test("Codex publisher: publish writes instructions.md to tmp dir", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-pub-test-"));
  const codexHome = path.join(tmpDir, ".codex");

  // Save and override CODEX_HOME so the publisher writes to our temp dir.
  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    // Create the .codex dir so isHostAvailable returns true.
    fs.mkdirSync(codexHome, { recursive: true });

    const pub = new CodexMemoryExtensionPublisher();
    const ctx = makeTestContext();
    const result = await pub.publish(ctx);

    assert.equal(result.hostId, "codex");
    assert.ok(result.extensionRoot.includes("memories_extensions"));
    assert.ok(result.filesWritten.length > 0, "expected at least one file written");

    const instructionsPath = result.filesWritten.find((f) => f.endsWith("instructions.md"));
    assert.ok(instructionsPath, "expected instructions.md in filesWritten");
    assert.ok(fs.existsSync(instructionsPath), "instructions.md should exist on disk");
    assert.deepEqual(
      result.filesWritten.filter((f) => f.includes(`${path.sep}skills${path.sep}`)),
      [],
      "publisher must not report skills files unless skillsFolder is supported",
    );
    assert.equal(
      fs.existsSync(path.join(result.extensionRoot, "skills")),
      false,
      "publisher must not create a skills folder while skillsFolder capability is false",
    );

    const content = fs.readFileSync(instructionsPath, "utf-8");
    assert.ok(content.includes("Remnic Memory Extension"), "should contain title");
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Codex publisher: instructions contain shared blocks", async () => {
  const pub = new CodexMemoryExtensionPublisher();
  const ctx = makeTestContext();
  const instructions = await pub.renderInstructions(ctx);

  // REMNIC_SEMANTIC_OVERVIEW
  assert.ok(instructions.includes("Memory Types"), "should contain semantic overview header");
  assert.ok(instructions.includes("fact"), "should mention 'fact' memory type");
  assert.ok(instructions.includes("preference"), "should mention 'preference' memory type");
  assert.ok(instructions.includes("decision"), "should mention 'decision' memory type");
  assert.ok(instructions.includes("entity"), "should mention 'entity' memory type");
  assert.ok(instructions.includes("skill"), "should mention 'skill' memory type");
  assert.ok(instructions.includes("correction"), "should mention 'correction' memory type");
  assert.ok(instructions.includes("observation"), "should mention 'observation' memory type");
  assert.ok(instructions.includes("summary"), "should mention 'summary' memory type");

  // REMNIC_CITATION_FORMAT
  assert.ok(instructions.includes("oai-mem-citation"), "should contain citation format");

  // REMNIC_MCP_TOOL_INVENTORY
  assert.ok(instructions.includes("remnic.recall"), "should list remnic.recall tool");
  assert.ok(instructions.includes("remnic.memory_store"), "should list remnic.memory_store tool");

  // REMNIC_RECALL_DECISION_RULES
  assert.ok(
    instructions.includes("When to Use Recall"),
    "should contain recall decision rules",
  );

  // Codex-specific sandbox rules
  assert.ok(instructions.includes("Sandboxing Rules"), "should contain sandbox rules");
});

test("Codex publisher: unpublish removes the extension folder", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-pub-unpub-"));
  const codexHome = path.join(tmpDir, ".codex");

  const prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  try {
    fs.mkdirSync(codexHome, { recursive: true });

    const pub = new CodexMemoryExtensionPublisher();
    const ctx = makeTestContext();

    // Publish first so there is something to remove.
    const result = await pub.publish(ctx);
    assert.ok(fs.existsSync(result.extensionRoot), "extension dir should exist after publish");

    // Now unpublish.
    await pub.unpublish();
    assert.ok(!fs.existsSync(result.extensionRoot), "extension dir should be removed after unpublish");
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("Codex publisher: capabilities are set correctly", () => {
  assert.equal(CodexMemoryExtensionPublisher.capabilities.instructionsMd, true);
  assert.equal(CodexMemoryExtensionPublisher.capabilities.skillsFolder, false);
  assert.equal(CodexMemoryExtensionPublisher.capabilities.citationFormat, true);
  assert.equal(CodexMemoryExtensionPublisher.capabilities.readPathTemplate, true);
});

// ── Claude Code stub ───────────────────────────────────────────────────────

test("Claude Code stub: publish is no-op, returns empty filesWritten", async () => {
  const pub = new ClaudeCodeMemoryExtensionPublisher();
  const ctx = makeTestContext();
  const result = await pub.publish(ctx);

  assert.equal(result.hostId, "claude-code");
  assert.equal(result.extensionRoot, "");
  assert.deepEqual(result.filesWritten, []);
  assert.deepEqual(result.skipped, []);
});

test("Claude Code stub: renderInstructions returns empty string", async () => {
  const pub = new ClaudeCodeMemoryExtensionPublisher();
  const ctx = makeTestContext();
  const instructions = await pub.renderInstructions(ctx);
  assert.equal(instructions, "");
});

test("Claude Code stub: capabilities are all false", () => {
  assert.equal(ClaudeCodeMemoryExtensionPublisher.capabilities.instructionsMd, false);
  assert.equal(ClaudeCodeMemoryExtensionPublisher.capabilities.skillsFolder, false);
  assert.equal(ClaudeCodeMemoryExtensionPublisher.capabilities.citationFormat, false);
  assert.equal(ClaudeCodeMemoryExtensionPublisher.capabilities.readPathTemplate, false);
});

// ── Hermes stub ────────────────────────────────────────────────────────────

test("Hermes stub: publish is no-op", async () => {
  const pub = new HermesMemoryExtensionPublisher();
  const ctx = makeTestContext();
  const result = await pub.publish(ctx);

  assert.equal(result.hostId, "hermes");
  assert.equal(result.extensionRoot, "");
  assert.deepEqual(result.filesWritten, []);
  assert.deepEqual(result.skipped, []);
});

test("Hermes stub: isHostAvailable returns false", async () => {
  const pub = new HermesMemoryExtensionPublisher();
  const available = await pub.isHostAvailable();
  assert.equal(available, false);
});

test("Hermes stub: capabilities are all false", () => {
  assert.equal(HermesMemoryExtensionPublisher.capabilities.instructionsMd, false);
  assert.equal(HermesMemoryExtensionPublisher.capabilities.skillsFolder, false);
  assert.equal(HermesMemoryExtensionPublisher.capabilities.citationFormat, false);
  assert.equal(HermesMemoryExtensionPublisher.capabilities.readPathTemplate, false);
});

// ── Shared instructions content ────────────────────────────────────────────

test("REMNIC_SEMANTIC_OVERVIEW mentions all memory types", () => {
  const types = [
    "fact", "preference", "decision", "entity", "skill",
    "correction", "question", "observation", "summary",
  ];
  for (const t of types) {
    assert.ok(
      REMNIC_SEMANTIC_OVERVIEW.includes(t),
      `REMNIC_SEMANTIC_OVERVIEW should mention memory type '${t}'`,
    );
  }
});

test("REMNIC_CITATION_FORMAT includes oai-mem-citation", () => {
  assert.ok(REMNIC_CITATION_FORMAT.includes("oai-mem-citation"));
});

test("REMNIC_MCP_TOOL_INVENTORY lists core tools", () => {
  const expectedTools = [
    "remnic.recall",
    "remnic.memory_store",
    "remnic.memory_search",
    "remnic.memory_get",
    "remnic.observe",
    "remnic.entity_get",
    "remnic.briefing",
  ];
  for (const tool of expectedTools) {
    assert.ok(
      REMNIC_MCP_TOOL_INVENTORY.includes(tool),
      `REMNIC_MCP_TOOL_INVENTORY should list tool '${tool}'`,
    );
  }
});

test("REMNIC_RECALL_DECISION_RULES covers MCP vs direct read", () => {
  assert.ok(REMNIC_RECALL_DECISION_RULES.includes("remnic.recall"));
  assert.ok(REMNIC_RECALL_DECISION_RULES.includes("direct file reads"));
  assert.ok(REMNIC_RECALL_DECISION_RULES.includes("MCP"));
});

// ── Each publisher factory produces distinct instances ──────────────────────

test("publisherFor returns fresh instances each call", () => {
  const a = publisherFor("codex");
  const b = publisherFor("codex");
  assert.ok(a !== b, "each call should return a distinct instance");
});

// ── hostIdForConnector mapping ────────────────────────────────────────────

test("hostIdForConnector maps 'codex-cli' to 'codex'", () => {
  assert.equal(hostIdForConnector("codex-cli"), "codex");
});

test("hostIdForConnector returns identity for matching IDs", () => {
  assert.equal(hostIdForConnector("claude-code"), "claude-code");
  assert.equal(hostIdForConnector("hermes"), "hermes");
  assert.equal(hostIdForConnector("codex"), "codex");
});

test("hostIdForConnector returns identity for unknown connectors", () => {
  assert.equal(hostIdForConnector("cursor"), "cursor");
  assert.equal(hostIdForConnector("unknown-xyz"), "unknown-xyz");
});

// ── publisherForConnector ─────────────────────────────────────────────────

test("publisherForConnector('codex-cli') resolves to Codex publisher", () => {
  const pub = publisherForConnector("codex-cli");
  assert.ok(pub, "expected a publisher for codex-cli");
  assert.equal(pub.hostId, "codex");
  assert.ok(pub instanceof CodexMemoryExtensionPublisher);
});

test("publisherForConnector('claude-code') returns Claude Code publisher", () => {
  const pub = publisherForConnector("claude-code");
  assert.ok(pub, "expected a publisher for claude-code");
  assert.equal(pub.hostId, "claude-code");
  assert.ok(pub instanceof ClaudeCodeMemoryExtensionPublisher);
});

test("publisherForConnector('hermes') returns Hermes publisher", () => {
  const pub = publisherForConnector("hermes");
  assert.ok(pub, "expected a publisher for hermes");
  assert.equal(pub.hostId, "hermes");
  assert.ok(pub instanceof HermesMemoryExtensionPublisher);
});

test("publisherForConnector returns undefined for connectors without a publisher", () => {
  assert.equal(publisherForConnector("cursor"), undefined);
  assert.equal(publisherForConnector("cline"), undefined);
  assert.equal(publisherForConnector("unknown-xyz"), undefined);
});
