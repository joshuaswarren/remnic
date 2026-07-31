import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runExternalWikiCliCommand } from "./external-wiki-cli.js";
import {
  type ExternalWikiCandidateProvider,
  type ExternalWikiRoot,
  searchExternalWikis,
} from "./external-wiki-search.js";

async function createWiki(id: string, files: Readonly<Record<string, string>>): Promise<ExternalWikiRoot> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), `remnic-external-wiki-${id}-`));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return {
    id,
    rootDir,
    enabled: true,
    pagesDir: "wiki",
    indexFile: "INDEX.md",
    indexInQmd: false,
    includeInDefaultRecall: false,
  };
}

async function removeWikis(roots: readonly ExternalWikiRoot[]): Promise<void> {
  await Promise.all(roots.map((root) => rm(root.rootDir, { recursive: true, force: true })));
}

test("external wiki search ranks topical pages and returns bounded citations", async () => {
  const root = await createWiki("reading", {
    "INDEX.md": [
      "# Catalog",
      "- [[wiki/retrieval-architecture|Retrieval Architecture]] - Hybrid retrieval design and ranking.",
      "- [[wiki/cooking|Cooking Notes]] - Pantry and meal planning.",
    ].join("\n"),
    "wiki/retrieval-architecture.md": [
      "# Retrieval Architecture",
      "",
      "## Candidate generation",
      "A hybrid index combines lexical overlap with semantic candidates.",
      "The planner fans out over the best cited pages.",
    ].join("\n"),
    "wiki/cooking.md": "# Cooking Notes\n\nKeep a stocked pantry.\n",
  });

  try {
    const result = await searchExternalWikis([root], {
      query: "hybrid retrieval planner",
      limit: 2,
      maxCharsPerHit: 180,
    });

    assert.equal(result.query, "hybrid retrieval planner");
    assert.equal(result.count, 1);
    assert.equal(result.hits[0]?.wikiId, "reading");
    assert.equal(result.hits[0]?.title, "Retrieval Architecture");
    assert.equal(result.hits[0]?.path, "wiki/retrieval-architecture.md");
    assert.match(result.hits[0]?.snippet ?? "", /hybrid index/i);
    assert.ok((result.hits[0]?.snippet.length ?? 0) <= 180);
    assert.deepEqual(result.hits[0]?.citations, [
      {
        path: "wiki/retrieval-architecture.md",
        lineStart: 3,
        lineEnd: 5,
        note: "Retrieval Architecture",
      },
    ]);
    assert.equal(result.hits[0]?.indexBlurb, "Hybrid retrieval design and ranking.");
    assert.equal(result.hits[0]?.rank, 1);
    assert.ok((result.hits[0]?.score ?? 0) > 0);
    assert.deepEqual(result.degradedWikiIds, []);
  } finally {
    await removeWikis([root]);
  }
});

test("external wiki search spans enabled roots and wikiId scopes one root", async () => {
  const reading = await createWiki("reading", {
    "INDEX.md": "- [[wiki/agents|Agent Design]] - Delegation and planner fan-out.\n",
    "wiki/agents.md": "# Agent Design\n\nA planner can delegate independent research.\n",
  });
  const operations = await createWiki("operations", {
    "INDEX.md": "- [[wiki/agents|Operations Agents]] - Delegation during incidents.\n",
    "wiki/agents.md": "# Operations Agents\n\nDelegate independent incident checks.\n",
  });

  try {
    const all = await searchExternalWikis([reading, operations], {
      query: "delegate independent agents",
      limit: 4,
    });
    assert.deepEqual(new Set(all.hits.map((hit) => hit.wikiId)), new Set(["reading", "operations"]));

    const scoped = await searchExternalWikis([reading, operations], {
      query: "delegate independent agents",
      wikiId: "operations",
    });
    assert.ok(scoped.hits.length > 0);
    assert.ok(scoped.hits.every((hit) => hit.wikiId === "operations"));

    await assert.rejects(
      searchExternalWikis([reading, operations], { query: "agents", wikiId: "missing" }),
      /unknown external wiki.*missing/i
    );
  } finally {
    await removeWikis([reading, operations]);
  }
});

test("external wiki search degrades to markdown page titles when INDEX.md is missing", async () => {
  const root = await createWiki("degraded", {
    "wiki/distributed-systems.md": "# Distributed Systems\n\nQuorum protects replicated writes.\n",
    "wiki/irrelevant.md": "# Gardening\n\nWater the seedlings.\n",
  });

  try {
    const result = await searchExternalWikis([root], { query: "distributed quorum" });
    assert.equal(result.hits[0]?.title, "Distributed Systems");
    assert.equal(result.hits[0]?.path, "wiki/distributed-systems.md");
    assert.deepEqual(result.degradedWikiIds, ["degraded"]);
  } finally {
    await removeWikis([root]);
  }
});

test("external wiki search isolates a missing configured root", async () => {
  const missingRoot = path.join(os.tmpdir(), `remnic-missing-wiki-${Date.now()}`);
  const result = await searchExternalWikis(
    [
      {
        id: "missing",
        rootDir: missingRoot,
        enabled: true,
        pagesDir: "wiki",
        indexFile: "INDEX.md",
        indexInQmd: false,
        includeInDefaultRecall: false,
      },
    ],
    { query: "anything" }
  );

  assert.deepEqual(result.hits, []);
  assert.deepEqual(result.degradedWikiIds, ["missing"]);
});

test("external wiki search rejects empty queries and an empty enabled-root set", async () => {
  await assert.rejects(searchExternalWikis([], { query: "topic" }), /no enabled external wiki roots/i);
  await assert.rejects(
    searchExternalWikis(
      [
        {
          id: "disabled",
          rootDir: os.tmpdir(),
          enabled: false,
          pagesDir: "wiki",
          indexFile: "INDEX.md",
          indexInQmd: false,
          includeInDefaultRecall: false,
        },
      ],
      { query: "topic" }
    ),
    /no enabled external wiki roots/i
  );
  await assert.rejects(
    searchExternalWikis(
      [
        {
          id: "enabled",
          rootDir: os.tmpdir(),
          enabled: true,
          pagesDir: "wiki",
          indexFile: "INDEX.md",
          indexInQmd: false,
          includeInDefaultRecall: false,
        },
      ],
      { query: "   " }
    ),
    /query is required/i
  );
});

test("external wiki search never follows catalog traversal outside pagesDir", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "remnic-external-wiki-traversal-"));
  const rootDir = path.join(parent, "root");
  await mkdir(path.join(rootDir, "wiki"), { recursive: true });
  await writeFile(path.join(rootDir, "INDEX.md"), "- [[../secret|Secret Plan]] - do not read\n", "utf8");
  await writeFile(path.join(parent, "secret.md"), "# Secret Plan\n\nEXFILTRATION_SENTINEL\n", "utf8");
  const root: ExternalWikiRoot = {
    id: "safe",
    rootDir,
    enabled: true,
    pagesDir: "wiki",
    indexFile: "INDEX.md",
    indexInQmd: false,
    includeInDefaultRecall: false,
  };

  try {
    const result = await searchExternalWikis([root], { query: "EXFILTRATION_SENTINEL" });
    assert.equal(
      result.hits.some((hit) => hit.snippet.includes("EXFILTRATION_SENTINEL")),
      false
    );
    assert.equal(
      result.hits.some((hit) => hit.path.includes("..")),
      false
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("external wiki search enforces the requested snippet length cap", async () => {
  const root = await createWiki("caps", {
    "INDEX.md": "- [[wiki/long-page|Long Page]] - bounded snippets\n",
    "wiki/long-page.md": `# Long Page\n\n## Match\nneedle ${"content ".repeat(100)}`,
  });

  try {
    const result = await searchExternalWikis([root], {
      query: "needle content",
      maxCharsPerHit: 80,
    });
    assert.equal(result.hits.length, 1);
    assert.ok((result.hits[0]?.snippet.length ?? 0) <= 80);
  } finally {
    await removeWikis([root]);
  }
});

test("external wiki search fails open to filesystem candidates when a dedicated provider fails", async () => {
  const root = await createWiki("fallback", {
    "INDEX.md": "- [[wiki/fallback|Filesystem Fallback]] - resilient retrieval\n",
    "wiki/fallback.md": "# Filesystem Fallback\n\nThe catalog remains available.\n",
  });
  const provider: ExternalWikiCandidateProvider = {
    async search() {
      throw new Error("backend unavailable");
    },
  };

  try {
    const result = await searchExternalWikis([root], { query: "filesystem fallback" }, { candidateProvider: provider });
    assert.equal(result.hits[0]?.title, "Filesystem Fallback");
  } finally {
    await removeWikis([root]);
  }
});

test("external wiki CLI searches multi-word queries and renders cited JSON or text", async () => {
  const root = await createWiki("cli", {
    "INDEX.md": "- [[wiki/agents|Agent Planning]] - planner fan-out with citations\n",
    "wiki/agents.md": "# Agent Planning\n\nPlanner fan-out uses cited retrieval evidence.\n",
  });
  try {
    const jsonOutput: string[] = [];
    const jsonErrors: string[] = [];
    const jsonCode = await runExternalWikiCliCommand(
      [root],
      ["search", "planner", "fan-out", "--wiki-id", "cli", "--limit", "1", "--json"],
      {
        stdout: { write: (chunk) => jsonOutput.push(chunk) },
        stderr: { write: (chunk) => jsonErrors.push(chunk) },
      }
    );
    assert.equal(jsonCode, 0);
    assert.equal(jsonErrors.join(""), "");
    const parsed: unknown = JSON.parse(jsonOutput.join(""));
    assert.ok(parsed && typeof parsed === "object" && "hits" in parsed);
    assert.ok(Array.isArray(parsed.hits));
    assert.equal(parsed.hits[0]?.path, "wiki/agents.md");

    const textOutput: string[] = [];
    const textCode = await runExternalWikiCliCommand([root], ["search", "retrieval", "evidence"], {
      stdout: { write: (chunk) => textOutput.push(chunk) },
      stderr: { write: () => undefined },
    });
    assert.equal(textCode, 0);
    assert.match(textOutput.join(""), /\[cli\] Agent Planning \(wiki\/agents\.md:\d+-\d+\)/);

    const invalidErrors: string[] = [];
    const invalidCode = await runExternalWikiCliCommand([root], ["search", "--limit", "0", "query"], {
      stdout: { write: () => undefined },
      stderr: { write: (chunk) => invalidErrors.push(chunk) },
    });
    assert.equal(invalidCode, 2);
    assert.match(invalidErrors.join(""), /--limit must be an integer from 1 to 20/);
  } finally {
    await removeWikis([root]);
  }
});
