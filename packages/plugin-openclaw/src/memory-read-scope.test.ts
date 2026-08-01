import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createMemoryReadScope,
  daemonServesCorpus,
  isSessionsMemoryPath,
} from "./memory-read-scope.js";

async function makeCorpus(): Promise<{
  memoryDir: string;
  workspaceDir: string;
  outsideDir: string;
}> {
  // realpath the temp root: macOS resolves /var -> /private/var, and the scope
  // canonicalizes before containment, so an unresolved root would never match.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-read-scope-")));
  const memoryDir = path.join(root, "memory-local");
  const workspaceDir = path.join(root, "workspace");
  const outsideDir = path.join(root, "outside");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(memoryDir, "facts", "alice.md"), "# alice\nline two\n");
  await writeFile(path.join(memoryDir, "index.json"), "{}\n");
  await writeFile(path.join(workspaceDir, "memory", "notes.md"), "# notes\n");
  await writeFile(path.join(outsideDir, "secret.md"), "# secret\n");
  return { memoryDir, workspaceDir, outsideDir };
}

test("resolveReadablePath resolves a memoryDir-relative hit", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  assert.equal(
    await scope.resolveReadablePath("facts/alice.md"),
    path.join(memoryDir, "facts", "alice.md"),
  );
});

test("resolveReadablePath resolves a workspace-memory-relative hit", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  assert.equal(
    await scope.resolveReadablePath("notes.md"),
    path.join(workspaceDir, "memory", "notes.md"),
  );
});

test("resolveReadablePath accepts an absolute path inside an allowed root", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  const absolute = path.join(memoryDir, "facts", "alice.md");
  assert.equal(await scope.resolveReadablePath(absolute), absolute);
});

test("resolveReadablePath rejects a path outside every allowed root", async () => {
  const { memoryDir, workspaceDir, outsideDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  await assert.rejects(
    () => scope.resolveReadablePath(path.join(outsideDir, "secret.md")),
    /memory read outside allowed roots/,
  );
});

test("resolveReadablePath rejects traversal that escapes an allowed root", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  await assert.rejects(
    () => scope.resolveReadablePath(path.join("..", "outside", "secret.md")),
    /memory read outside allowed roots/,
  );
});

test("resolveReadablePath rejects a symlink escaping the allowed roots", async () => {
  const { memoryDir, workspaceDir, outsideDir } = await makeCorpus();
  await symlink(path.join(outsideDir, "secret.md"), path.join(memoryDir, "leak.md"));
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  await assert.rejects(
    () => scope.resolveReadablePath("leak.md"),
    /memory read outside allowed roots/,
  );
});

test("resolveReadablePath rejects non-markdown files inside an allowed root", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  await assert.rejects(
    () => scope.resolveReadablePath("index.json"),
    /memory read restricted to \.md files/,
  );
});

test("resolveReadablePath rejects a path that does not exist", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  await assert.rejects(
    () => scope.resolveReadablePath("facts/missing.md"),
    /memory read rejected \(path unresolvable\)/,
  );
});

test("relativizeToMemoryRoot yields a root-relative form, not a workspace-relative one", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  // The workspace-relative form of this hit would be "../memory-local/facts/alice.md";
  // relativizing against the owning root is what lets it feed back into
  // resolveReadablePath without a doubled path segment.
  assert.equal(
    scope.relativizeToMemoryRoot(path.join(memoryDir, "facts", "alice.md")),
    path.join("facts", "alice.md"),
  );
  assert.equal(
    scope.relativizeToMemoryRoot(path.join(workspaceDir, "memory", "notes.md")),
    "notes.md",
  );
});

test("relativizeToMemoryRoot round-trips back through resolveReadablePath", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  const absolute = path.join(memoryDir, "facts", "alice.md");
  assert.equal(
    await scope.resolveReadablePath(scope.relativizeToMemoryRoot(absolute)),
    absolute,
  );
});

test("relativizeToMemoryRoot falls back to the workspace form outside every root", async () => {
  const { memoryDir, workspaceDir, outsideDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  // The workspace-relative form would escape the workspace, so the raw input
  // survives verbatim — a display-only value that resolveReadablePath rejects.
  const escaping = path.join(outsideDir, "secret.md");
  assert.equal(scope.relativizeToMemoryRoot(escaping), escaping);
  assert.equal(
    scope.relativizeToMemoryRoot(path.join(workspaceDir, "notes-outside-memory.md")),
    "notes-outside-memory.md",
  );
});

test("relativizeToMemoryRoot and normalizeWorkspacePath default missing input to memory", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  assert.equal(scope.relativizeToMemoryRoot(undefined), "memory");
  assert.equal(scope.normalizeWorkspacePath(undefined), "memory");
  assert.equal(scope.normalizeWorkspacePath(""), "memory");
});

test("normalizeWorkspacePath returns the input unchanged when it escapes the workspace", async () => {
  const { memoryDir, workspaceDir, outsideDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  const escaping = path.join(outsideDir, "secret.md");
  assert.equal(scope.normalizeWorkspacePath(escaping), escaping);
  assert.equal(
    scope.normalizeWorkspacePath(path.join(workspaceDir, "memory", "notes.md")),
    path.join("memory", "notes.md"),
  );
});

test("absolutize prefers the first allowed root that contains a relative hit", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  // "notes.md" is lexically contained by BOTH roots; memoryDir is first.
  assert.equal(scope.absolutize("notes.md"), path.join(memoryDir, "notes.md"));
  assert.equal(
    scope.absolutize(path.join(memoryDir, "facts", "alice.md")),
    path.join(memoryDir, "facts", "alice.md"),
  );
});

test("absolutize falls back to the workspace root when no allowed root contains the path", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  const escaping = path.join("..", "..", "elsewhere.md");
  assert.equal(scope.absolutize(escaping), path.resolve(workspaceDir, escaping));
});

test("allowedRoots omits the workspace memory root when no workspace is configured", async () => {
  const { memoryDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir: "" });
  assert.deepEqual(scope.allowedRoots, [memoryDir]);
  assert.equal(
    await scope.resolveReadablePath("facts/alice.md"),
    path.join(memoryDir, "facts", "alice.md"),
  );
});

test("root canonicalization tolerates a root that does not exist yet", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const scope = createMemoryReadScope({
    memoryDir: path.join(memoryDir, "not-created-yet"),
    workspaceDir,
  });
  // The missing root must not poison the surviving one.
  assert.equal(
    await scope.resolveReadablePath("notes.md"),
    path.join(workspaceDir, "memory", "notes.md"),
  );
});

test("the injected canonicalizer is used for both roots and reads", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const seen: string[] = [];
  const scope = createMemoryReadScope({
    memoryDir,
    workspaceDir,
    realpath: async (filePath: string) => {
      seen.push(filePath);
      return realpath(filePath);
    },
  });
  await scope.resolveReadablePath("facts/alice.md");
  assert.ok(seen.includes(memoryDir), "root canonicalization goes through the seam");
  assert.ok(
    seen.includes(path.join(memoryDir, "facts", "alice.md")),
    "read canonicalization goes through the seam",
  );
});

test("isSessionsMemoryPath classifies session transcripts on either separator", () => {
  for (const relative of [
    "sessions/2026-01-01.md",
    "sessions\\2026-01-01.md",
    path.join("nested", "sessions", "a.md"),
    "Sessions/a.md",
  ]) {
    assert.equal(isSessionsMemoryPath(relative), true, relative);
  }
  for (const relative of [
    "facts/alice.md",
    "sessions.md",
    "my-sessions/a.md",
    path.join("facts", "sessions-notes.md"),
  ]) {
    assert.equal(isSessionsMemoryPath(relative), false, relative);
  }
});

test("resolveReadablePath rejects a missing path as a domain error", async () => {
  const { memoryDir, workspaceDir } = await makeCorpus();
  const scope = createMemoryReadScope({ memoryDir, workspaceDir });
  // The host SDK boundary is untyped, so undefined can arrive despite the
  // signature; node:path would otherwise raise a bare TypeError.
  for (const bad of [undefined, null, "", 42]) {
    await assert.rejects(
      () => scope.resolveReadablePath(bad as unknown as string),
      /memory read rejected \(missing path\)/,
      String(bad),
    );
  }
});

test("daemonServesCorpus accepts the namespace-resolved storage dir under the corpus root", async () => {
  const { memoryDir } = await makeCorpus();
  // GET /engram/v1/health reports storage.dir, which is <root>/namespaces/<ns>
  // once the default namespace migrates out of the flat root.
  const namespaceDir = path.join(memoryDir, "namespaces", "generalist");
  await mkdir(namespaceDir, { recursive: true });
  assert.equal(daemonServesCorpus(memoryDir, memoryDir), true);
  assert.equal(daemonServesCorpus(memoryDir, namespaceDir), true);
  assert.equal(daemonServesCorpus(memoryDir, `${memoryDir}/`), true);
});

test("daemonServesCorpus rejects a directory that does not exist or escapes by symlink", async () => {
  const { memoryDir, outsideDir } = await makeCorpus();
  assert.equal(
    daemonServesCorpus(memoryDir, path.join(memoryDir, "namespaces", "never-created")),
    false,
    "an unresolvable daemon directory is not a corpus",
  );
  // Lexically contained, but a component resolves outside the root: accepting
  // it would hand local reads a different corpus than the daemon serves.
  const escape = path.join(memoryDir, "escape");
  await symlink(outsideDir, escape);
  assert.equal(daemonServesCorpus(memoryDir, escape), false);
});

test("daemonServesCorpus rejects any descendant that is not a namespace directory", async () => {
  const { memoryDir } = await makeCorpus();
  // A daemon independently configured for a nested corpus is NOT this corpus;
  // accepting it would silently redirect every recall and write into it.
  const nested = path.join(memoryDir, "archive");
  const deep = path.join(memoryDir, "namespaces", "team", "extra");
  await mkdir(nested, { recursive: true });
  await mkdir(deep, { recursive: true });
  assert.equal(daemonServesCorpus(memoryDir, nested), false);
  assert.equal(daemonServesCorpus(memoryDir, deep), false, "only one level under namespaces/");
  assert.equal(
    daemonServesCorpus(memoryDir, path.join(memoryDir, "namespaces")),
    false,
    "the namespaces container itself is not a namespace corpus",
  );
});

test("daemonServesCorpus rejects a foreign, relative, or blank corpus", async () => {
  const { memoryDir, outsideDir } = await makeCorpus();
  assert.equal(daemonServesCorpus(memoryDir, outsideDir), false);
  assert.equal(
    daemonServesCorpus(memoryDir, path.dirname(memoryDir)),
    false,
    "the daemon serving a PARENT of the corpus root is not the same corpus",
  );
  // A relative path names a different directory in each process's cwd, so
  // resolving both here would manufacture a match between distinct corpora.
  assert.equal(daemonServesCorpus("./memory", "./memory"), false);
  assert.equal(daemonServesCorpus(memoryDir, "./memory"), false);
  assert.equal(daemonServesCorpus("", memoryDir), false);
  assert.equal(daemonServesCorpus(memoryDir, "   "), false);
});

test("daemonServesCorpus resolves an aliased PARENT but rejects a symlinked root", async () => {
  // A dedicated root: the alias must live INSIDE the fixture, not in the
  // shared temp directory where parallel runs would collide.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "remnic-corpus-alias-")));
  const holder = path.join(root, "holder");
  const memoryDir = path.join(holder, "memory");
  await mkdir(memoryDir, { recursive: true });

  // An aliased ancestor is the ordinary case (think /var vs /private/var): the
  // two spellings name one directory, and splitting them would start a second
  // orchestrator beside the daemon on the same files.
  const aliasedHolder = path.join(root, "aliased-holder");
  await symlink(holder, aliasedHolder);
  const viaAlias = path.join(aliasedHolder, "memory");
  assert.equal(daemonServesCorpus(memoryDir, viaAlias), true);
  assert.equal(daemonServesCorpus(viaAlias, memoryDir), true);

  // The ROOT itself being a link is different: it is a mutable trust anchor,
  // and retargeting it after validation would move the corpus underneath us.
  const linkedRoot = path.join(root, "linked-memory");
  await symlink(memoryDir, linkedRoot);
  assert.equal(daemonServesCorpus(linkedRoot, memoryDir), false);
  assert.equal(daemonServesCorpus(memoryDir, linkedRoot), false);
  await rm(root, { recursive: true, force: true });
});
