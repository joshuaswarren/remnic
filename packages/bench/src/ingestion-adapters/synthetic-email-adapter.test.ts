import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { emailFixture } from "../fixtures/inbox/email.ts";
import { backlinkF1, entityRecall, schemaCompleteness } from "../ingestion-scorer.ts";
import { REQUIRED_FRONTMATTER_FIELDS } from "../ingestion-types.ts";
import { createSyntheticEmailIngestionAdapter } from "./synthetic-email-adapter.ts";

test("synthetic email ingestion adapter produces a scoreable graph and writes through Remnic system when supplied", async () => {
  const fixture = emailFixture.generate();
  const fixtureDir = await mkdtemp(path.join(await realTempDir(), "remnic-ingestion-fixture-"));
  const stored: Array<{ sessionId: string; messages: Array<{ role: string; content: string }> }> = [];
  let drained = false;

  try {
    for (const file of fixture.files) {
      const filePath = path.join(fixtureDir, file.relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    const adapter = createSyntheticEmailIngestionAdapter({
      system: {
        async store(sessionId, messages) {
          stored.push({ sessionId, messages });
        },
        async recall() {
          return "";
        },
        async search() {
          return [];
        },
        async reset() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        async drain() {
          drained = true;
        },
        async destroy() {},
      },
    });

    const log = await adapter.ingest(fixtureDir);
    const graph = await adapter.getMemoryGraph();
    const entityScores = entityRecall(graph.entities, fixture.goldGraph.entities);
    const linkScores = backlinkF1(graph.links, fixture.goldGraph.links);
    const schemaScores = schemaCompleteness(
      graph.pages,
      fixture.goldGraph.pages,
      REQUIRED_FRONTMATTER_FIELDS,
    );

    assert.deepEqual(log.errors, []);
    assert.deepEqual(log.promptsShown, []);
    assert.deepEqual(log.commandsIssued, [
      "read-input-files",
      "system.store",
      "system.drain",
      "build-memory-graph",
    ]);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.sessionId, "ingestion:synthetic-email");
    assert.equal(drained, true);
    assert.equal(entityScores.overall, 1);
    assert.equal(linkScores.f1, 1);
    assert.equal(graph.links[0]?.source, "Sarah Chen");
    assert.equal(graph.links[0]?.target, "Nexus Technologies");
    assert.ok(graph.pages.length > 0);
    for (const page of graph.pages) {
      assert.deepEqual(page.sourceRefs, ["inbox.mbox"]);
    }
    const projectHorizon = graph.pages.find((page) => page.title === "Project Horizon");
    assert.ok(projectHorizon);
    assert.notDeepEqual(projectHorizon.sourceRefs, projectHorizon.seeAlso);
    assert.equal(schemaScores.overall, 1);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("email gold backlinks match name-based extracted endpoints", () => {
  const score = backlinkF1(
    [{ source: "Sarah Chen", target: "Nexus Technologies", relation: "works-at" }],
    emailFixture.generate().goldGraph.links,
  );

  assert.equal(score.precision, 1);
  assert.ok(score.recall > 0);
  assert.ok(score.f1 > 0);
});

test("synthetic email ingestion adapter records system ingestion errors", async () => {
  const fixture = emailFixture.generate();
  const fixtureDir = await mkdtemp(path.join(await realTempDir(), "remnic-ingestion-errors-"));

  try {
    for (const file of fixture.files) {
      const filePath = path.join(fixtureDir, file.relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    const adapter = createSyntheticEmailIngestionAdapter({
      system: {
        async store() {
          throw new Error("store unavailable");
        },
        async recall() {
          return "";
        },
        async search() {
          return [];
        },
        async reset() {},
        async getStats() {
          return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
        },
        async destroy() {},
      },
    });

    const log = await adapter.ingest(fixtureDir);
    const graph = await adapter.getMemoryGraph();

    assert.deepEqual(log.commandsIssued, [
      "read-input-files",
      "system.store",
      "build-memory-graph",
    ]);
    assert.deepEqual(log.errors, ["store unavailable"]);
    assert.equal(graph.entities.length, fixture.goldGraph.entities.length);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("synthetic email ingestion adapter derives graph entries from the ingested corpus", async () => {
  const fixtureDir = await mkdtemp(path.join(await realTempDir(), "remnic-ingestion-partial-"));

  try {
    await writeFile(
      path.join(fixtureDir, "partial.txt"),
      "Sarah Chen sent a short note about Project Horizon.",
      "utf8",
    );

    const adapter = createSyntheticEmailIngestionAdapter();
    await adapter.ingest(fixtureDir);
    const graph = await adapter.getMemoryGraph();
    const entityNames = graph.entities.map((entity) => entity.name);

    assert.ok(entityNames.includes("Sarah Chen"));
    assert.ok(entityNames.includes("Project Horizon"));
    assert.equal(entityNames.includes("Nexus Technologies"), false);
    assert.equal(graph.pages.some((page) => page.title === "Sarah Chen"), true);
    assert.equal(
      graph.pages.some((page) => page.title === "Nexus Technologies"),
      false,
    );
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("synthetic email ingestion adapter does not match entity names embedded inside larger words", async () => {
  const fixtureDir = await mkdtemp(path.join(await realTempDir(), "remnic-ingestion-boundary-"));

  try {
    await writeFile(
      path.join(fixtureDir, "partial.txt"),
      "The SarahChenille sample and NexusTechnologiesExtra codename are unrelated words.",
      "utf8",
    );

    const adapter = createSyntheticEmailIngestionAdapter();
    await adapter.ingest(fixtureDir);
    const graph = await adapter.getMemoryGraph();
    const entityNames = graph.entities.map((entity) => entity.name);

    assert.equal(entityNames.includes("Sarah Chen"), false);
    assert.equal(entityNames.includes("Nexus Technologies"), false);
    assert.equal(graph.pages.some((page) => page.title === "Sarah Chen"), false);
    assert.equal(graph.pages.some((page) => page.title === "Nexus Technologies"), false);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("synthetic email ingestion adapter returns cloned frontmatter arrays", async () => {
  const fixture = emailFixture.generate();
  const fixtureDir = await mkdtemp(path.join(await realTempDir(), "remnic-ingestion-clone-"));

  try {
    for (const file of fixture.files) {
      const filePath = path.join(fixtureDir, file.relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    const adapter = createSyntheticEmailIngestionAdapter();
    await adapter.ingest(fixtureDir);
    const firstGraph = await adapter.getMemoryGraph();
    const firstPage = firstGraph.pages.find((page) => page.title === "Project Horizon");
    assert.ok(firstPage);
    const seeAlso = firstPage.frontmatter["see-also"];
    assert.ok(Array.isArray(seeAlso));
    seeAlso.push("mutated.md");

    const secondGraph = await adapter.getMemoryGraph();
    const secondPage = secondGraph.pages.find((page) => page.title === "Project Horizon");
    assert.ok(secondPage);
    assert.equal(
      (secondPage.frontmatter["see-also"] as string[]).includes("mutated.md"),
      false,
    );
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("synthetic email ingestion adapter rejects symlinked fixture roots", async () => {
  const fixtureDir = await mkdtemp(path.join(await realTempDir(), "remnic-ingestion-root-"));
  const linkDir = `${fixtureDir}-link`;

  try {
    await symlink(fixtureDir, linkDir, "dir");
    const adapter = createSyntheticEmailIngestionAdapter();

    await assert.rejects(
      () => adapter.ingest(linkDir),
      /ingestion fixture root must not be a symlink/,
    );
  } finally {
    await rm(linkDir, { recursive: true, force: true });
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("synthetic email ingestion adapter rejects nested fixture symlinks", async () => {
  const fixtureDir = await mkdtemp(path.join(await realTempDir(), "remnic-ingestion-symlink-"));
  const outsideFile = path.join(await realTempDir(), `remnic-ingestion-outside-${Date.now()}.txt`);

  try {
    await writeFile(outsideFile, "Sarah Chen outside note", "utf8");
    await symlink(outsideFile, path.join(fixtureDir, "outside.txt"));
    const adapter = createSyntheticEmailIngestionAdapter();

    await assert.rejects(
      () => adapter.ingest(fixtureDir),
      /ingestion fixture symlinks are not allowed/,
    );
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(outsideFile, { force: true });
  }
});

test("synthetic email ingestion adapter rejects fixture roots with symlinked ancestors", async () => {
  const realTmp = await realTempDir();
  const parentDir = await mkdtemp(path.join(realTmp, "remnic-ingestion-parent-"));
  const linkDir = `${parentDir}-link`;

  try {
    await symlink(parentDir, linkDir, "dir");
    const nestedDir = path.join(linkDir, "nested");
    await mkdir(nestedDir);
    const adapter = createSyntheticEmailIngestionAdapter();

    await assert.rejects(
      () => adapter.ingest(nestedDir),
      /ingestion fixture root must not contain symlinked ancestors/,
    );
  } finally {
    await rm(linkDir, { recursive: true, force: true });
    await rm(parentDir, { recursive: true, force: true });
  }
});

async function realTempDir(): Promise<string> {
  return realpath(os.tmpdir());
}
