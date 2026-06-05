import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type RemnicPublicArtifact,
  listRemnicPublicArtifacts,
} from "../packages/plugin-openclaw/src/public-artifacts.ts";

const AGENT_IDS = ["generalist"];

async function createTempMemoryDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "remnic-public-artifacts-"));
}

test("returns empty array when memoryDir does not exist", async () => {
  const artifacts = await listRemnicPublicArtifacts({
    memoryDir: "/tmp/nonexistent-remnic-test-dir",
    workspaceDir: "/tmp/workspace",
    agentIds: AGENT_IDS,
  });
  assert.deepStrictEqual(artifacts, []);
});

test("returns empty array when memoryDir is empty", async () => {
  const dir = await createTempMemoryDir();
  try {
    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });
    assert.deepStrictEqual(artifacts, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovers facts in dated subdirectories", async () => {
  const dir = await createTempMemoryDir();
  try {
    const factsDir = path.join(dir, "facts", "2026-04-10");
    await mkdir(factsDir, { recursive: true });
    await writeFile(path.join(factsDir, "fact-001.md"), "---\nid: fact-001\n---\n\nTest fact content\n");
    await writeFile(path.join(factsDir, "fact-002.md"), "---\nid: fact-002\n---\n\nAnother fact\n");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    assert.equal(artifacts.length, 2);
    for (const a of artifacts) {
      assert.equal(a.kind, "fact");
      assert.equal(a.contentType, "markdown");
      assert.equal(a.workspaceDir, "/tmp/workspace");
      assert.deepStrictEqual(a.agentIds, AGENT_IDS);
      assert.ok(a.relativePath.startsWith("facts/2026-04-10/"));
      assert.ok(path.isAbsolute(a.absolutePath));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovers entities", async () => {
  const dir = await createTempMemoryDir();
  try {
    const entitiesDir = path.join(dir, "entities");
    await mkdir(entitiesDir, { recursive: true });
    await writeFile(path.join(entitiesDir, "claude.md"), "---\nname: claude\n---\n\nClaude entity\n");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].kind, "entity");
    assert.equal(artifacts[0].relativePath, "entities/claude.md");
    assert.equal(artifacts[0].contentType, "markdown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovers corrections", async () => {
  const dir = await createTempMemoryDir();
  try {
    const correctionsDir = path.join(dir, "corrections");
    await mkdir(correctionsDir, { recursive: true });
    await writeFile(path.join(correctionsDir, "correction-001.md"), "---\nid: correction-001\n---\n\nCorrected fact\n");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].kind, "correction");
    assert.equal(artifacts[0].relativePath, "corrections/correction-001.md");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovers artifacts directory", async () => {
  const dir = await createTempMemoryDir();
  try {
    const artifactsDir = path.join(dir, "artifacts", "2026-04-10");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(path.join(artifactsDir, "artifact-001.md"), "---\nid: artifact-001\n---\n\nArtifact content\n");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].kind, "artifact");
    assert.equal(artifacts[0].relativePath, "artifacts/2026-04-10/artifact-001.md");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discovers profile.md as memory-root", async () => {
  const dir = await createTempMemoryDir();
  try {
    await writeFile(path.join(dir, "profile.md"), "# Agent Profile\n\nPublic profile content.\n");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].kind, "memory-root");
    assert.equal(artifacts[0].relativePath, "profile.md");
    assert.equal(artifacts[0].contentType, "markdown");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("excludes private directories (state, questions, transcripts)", async () => {
  const dir = await createTempMemoryDir();
  try {
    // Create private directories that should NOT appear
    for (const privateDir of ["state", "questions", "transcripts", "archive"]) {
      const dp = path.join(dir, privateDir);
      await mkdir(dp, { recursive: true });
      await writeFile(path.join(dp, "private-data.md"), "private content");
    }

    // Create one public file to confirm scanning works
    const entitiesDir = path.join(dir, "entities");
    await mkdir(entitiesDir, { recursive: true });
    await writeFile(path.join(entitiesDir, "public-entity.md"), "public");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    assert.equal(artifacts.length, 1, "should only find the public entity");
    assert.equal(artifacts[0].kind, "entity");

    // Verify no private paths leaked
    for (const a of artifacts) {
      assert.ok(!a.relativePath.startsWith("state/"), "state/ should not be exposed");
      assert.ok(!a.relativePath.startsWith("questions/"), "questions/ should not be exposed");
      assert.ok(!a.relativePath.startsWith("transcripts/"), "transcripts/ should not be exposed");
      assert.ok(!a.relativePath.startsWith("archive/"), "archive/ should not be exposed");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ignores non-markdown files in public directories", async () => {
  const dir = await createTempMemoryDir();
  try {
    const factsDir = path.join(dir, "facts", "2026-04-10");
    await mkdir(factsDir, { recursive: true });
    await writeFile(path.join(factsDir, "fact-001.md"), "valid markdown fact");
    await writeFile(path.join(factsDir, "metadata.json"), '{"cached": true}');
    await writeFile(path.join(factsDir, "notes.txt"), "plain text notes");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].relativePath, "facts/2026-04-10/fact-001.md");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deduplicates artifacts with identical keys", async () => {
  const dir = await createTempMemoryDir();
  try {
    const factsDir = path.join(dir, "facts");
    await mkdir(factsDir, { recursive: true });
    await writeFile(path.join(factsDir, "single.md"), "fact content");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    // Each file should only appear once
    const paths = artifacts.map((a) => a.relativePath);
    const uniquePaths = [...new Set(paths)];
    assert.deepStrictEqual(paths, uniquePaths, "no duplicates");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agentIds are defensively copied", async () => {
  const dir = await createTempMemoryDir();
  try {
    const entitiesDir = path.join(dir, "entities");
    await mkdir(entitiesDir, { recursive: true });
    await writeFile(path.join(entitiesDir, "test.md"), "test");

    const inputAgentIds = ["agent-a", "agent-b"];
    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: inputAgentIds,
    });

    assert.equal(artifacts.length, 1);
    assert.deepStrictEqual(artifacts[0].agentIds, ["agent-a", "agent-b"]);

    // Mutating input should not affect output
    inputAgentIds.push("agent-c");
    assert.deepStrictEqual(artifacts[0].agentIds, ["agent-a", "agent-b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handles mixed public content across all directories", async () => {
  const dir = await createTempMemoryDir();
  try {
    // Create content in all public directories
    await mkdir(path.join(dir, "facts", "2026-04-10"), { recursive: true });
    await writeFile(path.join(dir, "facts", "2026-04-10", "f1.md"), "fact 1");

    await mkdir(path.join(dir, "entities"), { recursive: true });
    await writeFile(path.join(dir, "entities", "e1.md"), "entity 1");

    await mkdir(path.join(dir, "corrections"), { recursive: true });
    await writeFile(path.join(dir, "corrections", "c1.md"), "correction 1");

    await mkdir(path.join(dir, "artifacts", "2026-04-10"), { recursive: true });
    await writeFile(path.join(dir, "artifacts", "2026-04-10", "a1.md"), "artifact 1");

    await writeFile(path.join(dir, "profile.md"), "profile content");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    assert.equal(artifacts.length, 5);

    const kinds = new Set(artifacts.map((a) => a.kind));
    assert.ok(kinds.has("fact"), "should have fact");
    assert.ok(kinds.has("entity"), "should have entity");
    assert.ok(kinds.has("correction"), "should have correction");
    assert.ok(kinds.has("artifact"), "should have artifact");
    assert.ok(kinds.has("memory-root"), "should have memory-root");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("follows symlinks within memoryDir boundary", async () => {
  const dir = await createTempMemoryDir();
  try {
    // Create real content within memoryDir
    const realDir = path.join(dir, "facts", "actual-data");
    await mkdir(realDir, { recursive: true });
    await writeFile(path.join(realDir, "internal.md"), "internal fact");

    // Create a symlink within memoryDir that points to another dir inside memoryDir
    const entitiesDir = path.join(dir, "entities");
    await mkdir(entitiesDir, { recursive: true });
    const linkTarget = path.join(dir, "entities", "linked-data");
    await mkdir(path.join(dir, "entities", "real-target"), { recursive: true });
    await writeFile(path.join(dir, "entities", "real-target", "entity.md"), "linked entity");
    await symlink(path.join(dir, "entities", "real-target"), linkTarget, "dir");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    // Should find the contained symlink target, but report the resolved
    // target path so later symlink swaps cannot redirect ingestion reads.
    const entityPaths = artifacts.filter((a) => a.kind === "entity").map((a) => a.relativePath);
    assert.ok(
      entityPaths.some((p) => p.includes("real-target/entity.md")),
      `should expose contained symlink targets by resolved path: ${JSON.stringify(entityPaths)}`
    );
    assert.ok(
      !entityPaths.some((p) => p.includes("linked-data/entity.md")),
      `should not expose mutable symlink alias paths: ${JSON.stringify(entityPaths)}`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns resolved file targets for public symlinks to prevent later swaps", async () => {
  const dir = await createTempMemoryDir();
  try {
    const factsDir = path.join(dir, "facts");
    const stateDir = path.join(dir, "state");
    await mkdir(factsDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const publicPath = path.join(factsDir, "public.md");
    const privatePath = path.join(stateDir, "private.md");
    const linkPath = path.join(factsDir, "link.md");
    await writeFile(publicPath, "public fact");
    await writeFile(privatePath, "private runtime state");
    await symlink(publicPath, linkPath, "file");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    assert.ok(
      !artifacts.some((a) => a.absolutePath === linkPath || a.relativePath === "facts/link.md"),
      "public artifacts must not return mutable symlink paths"
    );

    await rm(linkPath, { force: true });
    await symlink(privatePath, linkPath, "file");

    const publicArtifact = artifacts.find((a) => a.relativePath === "facts/public.md");
    assert.ok(publicArtifact, "should expose the resolved public target");
    assert.equal(await readFile(publicArtifact.absolutePath, "utf8"), "public fact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects top-level symlinked public dirs redirecting to private dirs", async () => {
  const dir = await createTempMemoryDir();
  try {
    // Create private state directory with data
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "cache.md"), "private state data");

    // Replace the facts directory with a symlink to state
    await symlink(stateDir, path.join(dir, "facts"), "dir");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    // Should NOT expose state files via the facts symlink redirect
    assert.equal(artifacts.length, 0, "symlinked top-level dir redirecting to private path must not expose files");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("blocks symlinks from public dirs into private memory paths", async () => {
  const dir = await createTempMemoryDir();
  try {
    // Create a private directory with sensitive data
    const stateDir = path.join(dir, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "internal.md"), "private runtime state");

    // Create a public directory with a symlink pointing to the private dir
    const factsDir = path.join(dir, "facts");
    await mkdir(factsDir, { recursive: true });
    await writeFile(path.join(factsDir, "legit.md"), "legitimate fact");
    await symlink(stateDir, path.join(factsDir, "alias"), "dir");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    // Should find the legit fact but NOT expose state/ via the symlink
    const factPaths = artifacts.map((a) => a.relativePath);
    assert.ok(factPaths.includes("facts/legit.md"), "should find legit.md");
    const leaked = artifacts.filter((a) => a.absolutePath.startsWith(stateDir));
    assert.equal(leaked.length, 0, "symlink from facts/ to state/ must not expose private data");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handles symlink cycles without infinite recursion", async () => {
  const dir = await createTempMemoryDir();
  try {
    const factsDir = path.join(dir, "facts");
    await mkdir(factsDir, { recursive: true });
    await writeFile(path.join(factsDir, "real.md"), "real fact");

    // Create a symlink cycle: facts/loop -> facts
    await symlink(factsDir, path.join(factsDir, "loop"), "dir");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    // Should find the real file but not loop infinitely
    const factPaths = artifacts.filter((a) => a.kind === "fact").map((a) => a.relativePath);
    assert.ok(factPaths.includes("facts/real.md"), "should find real.md");
    // No infinite loop — test would timeout if it occurred
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("blocks symlink traversal outside memoryDir", async () => {
  const dir = await createTempMemoryDir();
  const outsideDir = await createTempMemoryDir();
  try {
    // Create a file outside the memory dir
    await writeFile(path.join(outsideDir, "secret.md"), "private data outside memory boundary");

    // Create a symlink inside the memory dir pointing outside
    await mkdir(path.join(dir, "facts"), { recursive: true });
    await symlink(outsideDir, path.join(dir, "facts", "escape"), "dir");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    // The symlinked directory should NOT expose files outside the boundary
    const leaked = artifacts.filter((a) => a.absolutePath.startsWith(outsideDir));
    assert.equal(leaked.length, 0, "symlinked files outside memoryDir must not be exposed");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("uses forward slashes in relativePath on all platforms", async () => {
  const dir = await createTempMemoryDir();
  try {
    const factsDir = path.join(dir, "facts", "2026-04-10");
    await mkdir(factsDir, { recursive: true });
    await writeFile(path.join(factsDir, "f1.md"), "fact");

    const artifacts = await listRemnicPublicArtifacts({
      memoryDir: dir,
      workspaceDir: "/tmp/workspace",
      agentIds: AGENT_IDS,
    });

    assert.equal(artifacts.length, 1);
    assert.ok(!artifacts[0].relativePath.includes("\\"), "should use forward slashes");
    assert.equal(artifacts[0].relativePath, "facts/2026-04-10/f1.md");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
