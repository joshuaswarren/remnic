import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { QmdClient } from "../src/qmd.ts";

test("search returns empty when daemon returns empty (no subprocess fallback)", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.searchViaDaemon = async () => [];
  client.searchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [
      {
        docid: "fact-1",
        path: "/tmp/facts/fact-1.md",
        snippet: "hello",
        score: 0.9,
      },
    ];
  };

  const out = await client.search("heartbeat", undefined, 3);
  // Daemon result is authoritative — subprocess is NOT called
  assert.equal(subprocessCalls, 0);
  assert.equal(out.length, 0);
});

test("searchGlobal returns empty when daemon returns empty (no subprocess fallback)", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.searchViaDaemon = async () => [];
  client.searchGlobalViaSubprocess = async () => {
    subprocessCalls += 1;
    return [
      {
        docid: "fact-2",
        path: "/tmp/facts/fact-2.md",
        snippet: "world",
        score: 0.8,
      },
    ];
  };

  const out = await client.searchGlobal("workspace context", 4);
  // Daemon result is authoritative — subprocess is NOT called
  assert.equal(subprocessCalls, 0);
  assert.equal(out.length, 0);
});

test("hybridSearch always runs bm25+vector merge (no daemon short-circuit)", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let bm25Calls = 0;
  let vectorCalls = 0;
  let daemonCalls = 0;
  client.searchViaDaemon = async () => {
    daemonCalls += 1;
    return [];
  };
  client.bm25Search = async () => {
    bm25Calls += 1;
    return [
      {
        docid: "fact-3",
        path: "/tmp/facts/fact-3.md",
        snippet: "bm25",
        score: 0.6,
      },
    ];
  };
  client.vectorSearch = async () => {
    vectorCalls += 1;
    return [
      {
        docid: "fact-3",
        path: "/tmp/facts/fact-3.md",
        snippet: "vector",
        score: 0.95,
      },
    ];
  };

  const out = await client.hybridSearch("query", undefined, 3);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.docid, "fact-3");
  assert.equal(out[0]?.score, 0.95);
  assert.equal(bm25Calls, 1);
  assert.equal(vectorCalls, 1);
  assert.equal(daemonCalls, 0);
});

test("bm25Search returns empty when daemon returns empty (no subprocess fallback)", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let daemonCalls = 0;
  let subprocessCalls = 0;
  client.bm25SearchViaDaemon = async () => {
    daemonCalls += 1;
    return [];
  };
  client.bm25SearchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [
      {
        docid: "fact-bm25-fallback",
        path: "/tmp/facts/fact-bm25-fallback.md",
        snippet: "fallback",
        score: 0.77,
      },
    ];
  };

  const out = await client.bm25Search("needle", undefined, 3);
  assert.equal(daemonCalls, 1);
  // Daemon result is authoritative — subprocess is NOT called
  assert.equal(subprocessCalls, 0);
  assert.equal(out.length, 0);
});

test("vectorSearch returns empty when daemon returns empty (no subprocess fallback)", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let daemonCalls = 0;
  let subprocessCalls = 0;
  client.vsearchViaDaemon = async () => {
    daemonCalls += 1;
    return [];
  };
  client.vsearchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [
      {
        docid: "fact-vsearch-fallback",
        path: "/tmp/facts/fact-vsearch-fallback.md",
        snippet: "fallback",
        score: 0.88,
      },
    ];
  };

  const out = await client.vectorSearch("needle", undefined, 3);
  assert.equal(daemonCalls, 1);
  // Daemon result is authoritative — subprocess is NOT called
  assert.equal(subprocessCalls, 0);
  assert.equal(out.length, 0);
});

test("daemon parser uses path field when file is absent", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.maybeProbeDaemon = async () => {};
  client.daemonSession = {
    callTool: async () => ({
      structuredContent: {
        results: [
          {
            docid: "fact-daemon-path",
            path: "/tmp/facts/fact-daemon-path.md",
            snippet: "daemon path field",
            score: 0.91,
          },
        ],
      },
    }),
  };

  let subprocessCalls = 0;
  client.searchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [];
  };

  const out = await client.search("daemon parser path test", undefined, 3);
  assert.equal(subprocessCalls, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.path, "/tmp/facts/fact-daemon-path.md");
});

test("daemon parses QMD v2 markdown-formatted text results", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.maybeProbeDaemon = async () => {};
  client.daemonSession = {
    callTool: async () => ({
      content: [
        {
          type: "text",
          text: [
            'Found 3 results for "test query":',
            "",
            "#ca5902 93% openclaw-engram-hot-facts/2026-04-12/preference-123.md - User prefers dark mode",
            "#fbcb6e 50% openclaw-engram-hot-facts/2026-02-05/honcho-456.md - Honcho integration details",
            "#abc123 72% openclaw-engram-hot-facts/2026-03-15/work-789.md - Work schedule preferences",
          ].join("\n"),
        },
      ],
    }),
  };

  let subprocessCalls = 0;
  client.searchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [];
  };

  const out = await client.search("test query", undefined, 5);
  assert.equal(subprocessCalls, 0);
  assert.equal(out.length, 3);
  assert.equal(out[0]?.docid, "ca5902");
  assert.equal(out[0]?.score, 0.93);
  assert.equal(out[0]?.path, "openclaw-engram-hot-facts/2026-04-12/preference-123.md");
  assert.equal(out[1]?.docid, "fbcb6e");
  assert.equal(out[1]?.score, 0.50);
  assert.equal(out[2]?.docid, "abc123");
  assert.equal(out[2]?.score, 0.72);
});

test("daemon parses QMD v2 markdown results with uppercase hex docids", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.maybeProbeDaemon = async () => {};
  client.daemonSession = {
    callTool: async () => ({
      content: [
        {
          type: "text",
          text: [
            'Found 2 results for "uppercase test":',
            "",
            "#CA5902 88% openclaw-engram-hot-facts/2026-04-12/upper-1.md - Uppercase hex docid",
            "#FbCb6E 45% openclaw-engram-hot-facts/namespaces/work/2026-03-01/mixed-2.md - Mixed case hex docid",
          ].join("\n"),
        },
      ],
    }),
  };

  const out = await client.search("uppercase test", undefined, 5);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.docid, "CA5902");
  assert.equal(out[0]?.score, 0.88);
  assert.equal(out[0]?.path, "openclaw-engram-hot-facts/2026-04-12/upper-1.md");
  assert.equal(out[1]?.docid, "FbCb6E");
  assert.equal(out[1]?.score, 0.45);
  // Namespace info is preserved in the path for downstream namespace filtering
  assert.equal(out[1]?.path, "openclaw-engram-hot-facts/namespaces/work/2026-03-01/mixed-2.md");
});

test("daemon parses QMD v2 markdown results with paths containing spaces", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.maybeProbeDaemon = async () => {};
  client.daemonSession = {
    callTool: async () => ({
      content: [
        {
          type: "text",
          text: [
            'Found 2 results for "spaced path test":',
            "",
            "#aa1122 85% openclaw-engram-hot-facts/2026-04-12/my folder/preference-1.md - Preference with spaces",
            "#bb3344 60% openclaw-engram-hot-facts/2026-03-01/some path with spaces/work-2.md - Work item in spaced dir",
          ].join("\n"),
        },
      ],
    }),
  };

  const out = await client.search("spaced path test", undefined, 5);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.docid, "aa1122");
  assert.equal(out[0]?.score, 0.85);
  assert.equal(out[0]?.path, "openclaw-engram-hot-facts/2026-04-12/my folder/preference-1.md");
  assert.equal(out[1]?.docid, "bb3344");
  assert.equal(out[1]?.score, 0.60);
  assert.equal(out[1]?.path, "openclaw-engram-hot-facts/2026-03-01/some path with spaces/work-2.md");
});

test("daemon parses QMD v2 markdown results with paths containing ` - ` separator", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.maybeProbeDaemon = async () => {};
  client.daemonSession = {
    callTool: async () => ({
      content: [
        {
          type: "text",
          text: [
            'Found 2 results for "dash path test":',
            "",
            "#dd1122 90% openclaw-engram-hot-facts/2026-04-12/my - folder/preference-1.md - Preference in dash dir",
            "#ee3344 75% openclaw-engram-hot-facts/2026-03-01/some - path - with - dashes/work-2.md - Work item in dashed dir",
          ].join("\n"),
        },
      ],
    }),
  };

  const out = await client.search("dash path test", undefined, 5);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.docid, "dd1122");
  assert.equal(out[0]?.score, 0.90);
  assert.equal(out[0]?.path, "openclaw-engram-hot-facts/2026-04-12/my - folder/preference-1.md");
  assert.equal(out[1]?.docid, "ee3344");
  assert.equal(out[1]?.score, 0.75);
  assert.equal(out[1]?.path, "openclaw-engram-hot-facts/2026-03-01/some - path - with - dashes/work-2.md");
});

test("daemon parses QMD v2 markdown results with titles containing ` - ` separators", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.maybeProbeDaemon = async () => {};
  client.daemonSession = {
    callTool: async () => ({
      content: [
        {
          type: "text",
          text: [
            'Found 3 results for "title dash test":',
            "",
            "#aabb11 90% openclaw-engram-hot-facts/2026-04-12/fact.md - API notes - follow-up",
            "#ccdd22 75% openclaw-engram-hot-facts/2026-03-01/my - folder/config.json - Settings - production - v2",
            "#eeff33 60% openclaw-engram-hot-facts/2026-02-15/report.txt - Summary - Q1 2026",
          ].join("\n"),
        },
      ],
    }),
  };

  const out = await client.search("title dash test", undefined, 5);
  assert.equal(out.length, 3);

  // Path ends at .md, title gets the rest including ` - `
  assert.equal(out[0]?.docid, "aabb11");
  assert.equal(out[0]?.score, 0.90);
  assert.equal(out[0]?.path, "openclaw-engram-hot-facts/2026-04-12/fact.md");

  // Path with ` - ` in directory AND ` - ` in title
  assert.equal(out[1]?.docid, "ccdd22");
  assert.equal(out[1]?.score, 0.75);
  assert.equal(out[1]?.path, "openclaw-engram-hot-facts/2026-03-01/my - folder/config.json");

  // Non-.md extension (.txt) also works
  assert.equal(out[2]?.docid, "eeff33");
  assert.equal(out[2]?.score, 0.60);
  assert.equal(out[2]?.path, "openclaw-engram-hot-facts/2026-02-15/report.txt");
});

test("daemon parses QMD v2 markdown results with version-like dots in path segments", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.maybeProbeDaemon = async () => {};
  client.daemonSession = {
    callTool: async () => ({
      content: [
        {
          type: "text",
          text: [
            'Found 3 results for "version path test":',
            "",
            // Path contains "v1.2" which looks like a file extension to a naive regex
            "#aa1100 88% openclaw-engram-hot-facts/v1.2 - archived/note.md - Archived v1.2 note",
            // Path contains multiple dot-segments before the real extension
            "#bb2200 75% openclaw-engram-hot-facts/api.v2.0/config.yaml - API v2 config",
            // Path with version in directory AND dashes in title
            "#cc3300 60% openclaw-engram-hot-facts/release-3.1/2026-04-01/summary.txt - Release 3.1 - final notes",
          ].join("\n"),
        },
      ],
    }),
  };

  const out = await client.search("version path test", undefined, 5);
  assert.equal(out.length, 3);

  // "v1.2" is skipped because "2" isn't in the known-extension list
  assert.equal(out[0]?.docid, "aa1100");
  assert.equal(out[0]?.score, 0.88);
  assert.equal(out[0]?.path, "openclaw-engram-hot-facts/v1.2 - archived/note.md");

  // Multiple dots in path resolved correctly to the real .yaml extension
  assert.equal(out[1]?.docid, "bb2200");
  assert.equal(out[1]?.score, 0.75);
  assert.equal(out[1]?.path, "openclaw-engram-hot-facts/api.v2.0/config.yaml");

  // Version in directory + dash in title
  assert.equal(out[2]?.docid, "cc3300");
  assert.equal(out[2]?.score, 0.60);
  assert.equal(out[2]?.path, "openclaw-engram-hot-facts/release-3.1/2026-04-01/summary.txt");
});

test("daemon parses QMD v2 markdown results when title contains a filename", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.maybeProbeDaemon = async () => {};
  client.daemonSession = {
    callTool: async () => ({
      content: [
        {
          type: "text",
          text: [
            'Found 2 results for "title filename test":',
            "",
            "#aabb11 90% openclaw-engram-hot-facts/2026-04-12/fact.md - mentions config.json - follow-up",
            "#ccdd22 75% openclaw-engram-hot-facts/2026-03-01/note.txt - see also report.html - final draft",
          ].join("\n"),
        },
      ],
    }),
  };

  const out = await client.search("title filename test", undefined, 5);
  assert.equal(out.length, 2);

  assert.equal(out[0]?.docid, "aabb11");
  assert.equal(out[0]?.path, "openclaw-engram-hot-facts/2026-04-12/fact.md");

  assert.equal(out[1]?.docid, "ccdd22");
  assert.equal(out[1]?.path, "openclaw-engram-hot-facts/2026-03-01/note.txt");
});

test("daemon parses QMD v2 markdown results with non-standard file extensions", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.maybeProbeDaemon = async () => {};
  client.daemonSession = {
    callTool: async () => ({
      content: [
        {
          type: "text",
          text: [
            'Found 3 results for "extension test":',
            "",
            "#aa1122 88% openclaw-engram-hot-facts/2026-04-10/helper.ts - TypeScript utility",
            "#bb3344 72% openclaw-engram-hot-facts/2026-03-15/analysis.py - Python analysis script",
            "#cc5566 65% openclaw-engram-hot-facts/2026-02-20/guide.mdx - MDX documentation",
          ].join("\n"),
        },
      ],
    }),
  };

  const out = await client.search("extension test", undefined, 5);
  assert.equal(out.length, 3);

  assert.equal(out[0]?.docid, "aa1122");
  assert.equal(out[0]?.path, "openclaw-engram-hot-facts/2026-04-10/helper.ts");

  assert.equal(out[1]?.docid, "bb3344");
  assert.equal(out[1]?.path, "openclaw-engram-hot-facts/2026-03-15/analysis.py");

  assert.equal(out[2]?.docid, "cc5566");
  assert.equal(out[2]?.path, "openclaw-engram-hot-facts/2026-02-20/guide.mdx");
});

test("parseMcpSearchResult deduplicates markdown fallback hits against structured results", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  client.maybeProbeDaemon = async () => {};
  client.daemonSession = {
    callTool: async () => ({
      // Structured results AND markdown text for the same query
      structuredContent: {
        results: [
          {
            docid: "ca5902",
            file: "openclaw-engram-hot-facts/2026-04-12/preference-123.md",
            snippet: "structured snippet",
            score: 0.93,
          },
        ],
      },
      content: [
        {
          type: "text",
          text: [
            'Found 2 results for "dedup test":',
            "",
            // Duplicate of the structured result above
            "#ca5902 93% openclaw-engram-hot-facts/2026-04-12/preference-123.md - User prefers dark mode",
            // Unique result only in markdown
            "#fbcb6e 50% openclaw-engram-hot-facts/2026-02-05/honcho-456.md - Honcho integration details",
          ].join("\n"),
        },
      ],
    }),
  };

  const out = await client.search("dedup test", undefined, 5);
  // Should have 2 results: one from structured, one unique from markdown.
  // The duplicate ca5902 from markdown should be skipped.
  assert.equal(out.length, 2);
  assert.equal(out[0]?.docid, "ca5902");
  assert.equal(out[0]?.snippet, "structured snippet"); // from structured, not markdown
  assert.equal(out[1]?.docid, "fbcb6e");
  assert.equal(out[1]?.score, 0.50);
});

test("probe attempts daemon connectivity even when CLI probe fails", async () => {
  const client = new QmdClient("openclaw-engram", 5, { daemonUrl: "http://127.0.0.1:9020" }) as any;
  let cliCalls = 0;
  let daemonCalls = 0;
  client.probeCli = async () => {
    cliCalls += 1;
    client.available = false;
    return false;
  };
  client.probeDaemon = async () => {
    daemonCalls += 1;
    client.daemonAvailable = true;
    return true;
  };

  const ok = await client.probe();

  assert.equal(ok, true);
  assert.equal(cliCalls, 1);
  assert.equal(daemonCalls, 1);
  assert.equal(client.daemonAvailable, true);
});

test("embed retries with force re-embed after vector dimension mismatch", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  const calls: string[][] = [];
  client.runQmdCommand = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "embed" && args[1] === "-c") {
      throw new Error("vector dimension mismatch: vectors_vec expects float[3072]");
    }
    return { stdout: "", stderr: "" };
  };

  await client.embed();

  assert.deepEqual(calls, [
    ["embed", "-c", "openclaw-engram"],
    ["embed", "-f", "-c", "openclaw-engram"],
  ]);
});

test("embedCollection retries with force re-embed against the same collection", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  const calls: string[][] = [];
  client.runQmdCommand = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "embed" && args[1] === "-c") {
      throw new Error("vector dimension mismatch: vectors_vec expects float[3072]");
    }
    return { stdout: "", stderr: "" };
  };

  await client.embedCollection("shared-memory");

  assert.deepEqual(calls, [
    ["embed", "-c", "shared-memory"],
    ["embed", "-f", "-c", "shared-memory"],
  ]);
});

test("daemon request success removes abort listeners from the caller signal", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-daemon-cleanup-"));
  const daemonScriptPath = path.join(tmpDir, "fake-qmd-daemon.js");
  const scriptPath = path.join(tmpDir, "fake-qmd-daemon");
  await writeFile(
    daemonScriptPath,
    `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "fake-qmd", version: "1.0.0" }
      }
    }) + "\\n");
    return;
  }
  if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { structuredContent: { results: [] } }
    }) + "\\n");
  }
});
`,
    "utf8",
  );
  await writeFile(
    scriptPath,
    `#!/bin/sh
exec "${process.execPath}" "${daemonScriptPath}" "$@"
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);

  const client = new QmdClient("openclaw-engram", 5, { qmdPath: scriptPath }) as any;
  const ok = await client.probeDaemon();
  assert.equal(ok, true);

  const controller = new AbortController();
  const daemonSession = client.daemonSession as any;
  const originalWrite = daemonSession.child.stdin.write.bind(daemonSession.child.stdin);
  daemonSession.child.stdin.write = (chunk: string, callback?: (err?: Error | null) => void) => {
    const message = JSON.parse(chunk.trim());
    if (message.method === "tools/call" && message.id) {
      setImmediate(() => {
        daemonSession.handleMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: { structuredContent: { results: [] } },
        });
      });
      callback?.(null);
      return true;
    }
    return originalWrite(chunk, callback);
  };
  const result = await daemonSession.callTool("query", { query: "cleanup", limit: 1 }, 1_000, controller.signal);

  assert.deepEqual(result, { structuredContent: { results: [] } });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);

  daemonSession.invalidate();
});

test("search aborts while waiting on the QMD mutex", { concurrency: false }, async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-qmd-abort-wait-"));
  const scriptPath = path.join(tmpDir, "fake-qmd");
  await writeFile(
    scriptPath,
    `#!/bin/sh
set -eu
if [ "$1" = "query" ]; then
  sleep 2
  printf '[]'
  exit 0
fi
printf '[]'
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);

  const client = new QmdClient("openclaw-engram", 5, { qmdPath: scriptPath }) as any;
  client.available = true;
  client.daemonAvailable = false;
  client.maybeProbeDaemon = async () => {};

  const firstSearch = client.search("first", undefined, 3);
  const abortController = new AbortController();
  const startedAt = Date.now();
  const secondSearch = client.search("second", undefined, 3, undefined, { signal: abortController.signal });
  setTimeout(() => abortController.abort(), 50);

  await expectAbortError(
    () => secondSearch,
    "operation aborted while waiting for qmd mutex",
  );
  const elapsedMs = Date.now() - startedAt;
  await firstSearch;

  assert.ok(elapsedMs < 1000, `expected aborted search to resolve quickly, saw ${elapsedMs}ms`);
});

async function createSlowQmdScript(prefix: string): Promise<string> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const scriptPath = path.join(tmpDir, "fake-qmd");
  await writeFile(
    scriptPath,
    `#!/bin/sh
set -eu
sleep 2
printf '[]'
`,
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function expectAbortError(
  fn: () => Promise<unknown>,
  message?: string,
): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    return (
      err instanceof Error &&
      err.name === "AbortError" &&
      (typeof message !== "string" || err.message.includes(message))
    );
  });
}

test("search aborts during subprocess execution instead of returning an empty result", { concurrency: false }, async () => {
  const scriptPath = await createSlowQmdScript("engram-qmd-subprocess-search-abort-");
  const client = new QmdClient("openclaw-engram", 5, { qmdPath: scriptPath }) as any;
  client.available = true;
  client.daemonAvailable = false;
  client.maybeProbeDaemon = async () => {};

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  await expectAbortError(
    () => client.search("search abort", undefined, 3, undefined, { signal: controller.signal }),
  );
});

test("searchGlobal aborts during subprocess execution instead of returning an empty result", { concurrency: false }, async () => {
  const scriptPath = await createSlowQmdScript("engram-qmd-subprocess-global-abort-");
  const client = new QmdClient("openclaw-engram", 5, { qmdPath: scriptPath }) as any;
  client.available = true;
  client.daemonAvailable = false;
  client.maybeProbeDaemon = async () => {};

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  await expectAbortError(
    () => client.searchGlobal("global abort", 3, { signal: controller.signal }),
  );
});

test("bm25Search aborts during subprocess execution instead of returning an empty result", { concurrency: false }, async () => {
  const scriptPath = await createSlowQmdScript("engram-qmd-subprocess-bm25-abort-");
  const client = new QmdClient("openclaw-engram", 5, { qmdPath: scriptPath }) as any;
  client.available = true;
  client.daemonAvailable = false;
  client.maybeProbeDaemon = async () => {};

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  await expectAbortError(
    () => client.bm25Search("bm25 abort", undefined, 3, { signal: controller.signal }),
  );
});

test("vectorSearch aborts during subprocess execution instead of returning an empty result", { concurrency: false }, async () => {
  const scriptPath = await createSlowQmdScript("engram-qmd-subprocess-vsearch-abort-");
  const client = new QmdClient("openclaw-engram", 5, { qmdPath: scriptPath }) as any;
  client.available = true;
  client.daemonAvailable = false;
  client.maybeProbeDaemon = async () => {};

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  await expectAbortError(
    () => client.vectorSearch("vector abort", undefined, 3, { signal: controller.signal }),
  );
});

test("searchViaDaemon keeps daemon session active on AbortError", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  let invalidated = 0;
  const abortErr = new Error("request aborted by caller");
  Object.defineProperty(abortErr, "name", { value: "AbortError" });

  client.daemonAvailable = true;
  client.daemonSession = {
    callTool: async () => {
      throw abortErr;
    },
    invalidate: () => {
      invalidated += 1;
    },
  };

  await assert.rejects(
    client.searchViaDaemon("needle", "openclaw-engram", 3),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(invalidated, 0);
  assert.equal(client.daemonAvailable, true);
});

test("bm25SearchViaDaemon keeps daemon session active on caller cancellation", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  let invalidated = 0;
  const controller = new AbortController();
  controller.abort();

  client.daemonAvailable = true;
  client.daemonSession = {
    callTool: async () => {
      throw new Error("socket write failed");
    },
    invalidate: () => {
      invalidated += 1;
    },
  };

  await assert.rejects(
    client.bm25SearchViaDaemon("needle", "openclaw-engram", 3, controller.signal),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(invalidated, 0);
  assert.equal(client.daemonAvailable, true);
});

test("vsearchViaDaemon tolerates transient failures before invalidating daemon session", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  let invalidated = 0;

  client.daemonAvailable = true;
  client.daemonSession = {
    callTool: async () => {
      throw new Error("broken pipe");
    },
    invalidate: () => {
      invalidated += 1;
    },
  };

  // First two failures are transient — daemon stays available
  const out1 = await client.vsearchViaDaemon("needle", "openclaw-engram", 3);
  assert.equal(out1, null);
  assert.equal(invalidated, 0);
  assert.equal(client.daemonAvailable, true);

  const out2 = await client.vsearchViaDaemon("needle", "openclaw-engram", 3);
  assert.equal(out2, null);
  assert.equal(invalidated, 0);
  assert.equal(client.daemonAvailable, true);

  // Third consecutive failure triggers invalidation
  const out3 = await client.vsearchViaDaemon("needle", "openclaw-engram", 3);
  assert.equal(out3, null);
  assert.equal(invalidated, 1);
  assert.equal(client.daemonAvailable, false);
});

test("search rethrows daemon cancellation without subprocess fallback", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  const controller = new AbortController();
  controller.abort();
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.searchViaDaemon = async () => {
    throw new Error("daemon search cancelled");
  };
  client.searchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [{ docid: "unexpected", path: "/tmp/unexpected.md", snippet: "unexpected", score: 0.1 }];
  };

  await expectAbortError(
    () => client.search("cancelled", undefined, 3, undefined, { signal: controller.signal }),
    "QMD daemon search aborted",
  );
  assert.equal(subprocessCalls, 0);
});

test("bm25Search rethrows daemon cancellation without subprocess fallback", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  const controller = new AbortController();
  controller.abort();
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.bm25SearchViaDaemon = async () => {
    throw new Error("daemon bm25 cancelled");
  };
  client.bm25SearchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [{ docid: "unexpected", path: "/tmp/unexpected.md", snippet: "unexpected", score: 0.1 }];
  };

  await expectAbortError(
    () => client.bm25Search("cancelled", undefined, 3, { signal: controller.signal }),
    "QMD daemon bm25 aborted",
  );
  assert.equal(subprocessCalls, 0);
});

test("vectorSearch rethrows daemon cancellation without subprocess fallback", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  const controller = new AbortController();
  controller.abort();
  client.available = true;
  client.daemonAvailable = true;
  client.daemonSession = {};
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.vsearchViaDaemon = async () => {
    throw new Error("daemon vsearch cancelled");
  };
  client.vsearchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [{ docid: "unexpected", path: "/tmp/unexpected.md", snippet: "unexpected", score: 0.1 }];
  };

  await expectAbortError(
    () => client.vectorSearch("cancelled", undefined, 3, { signal: controller.signal }),
    "QMD daemon vsearch aborted",
  );
  assert.equal(subprocessCalls, 0);
});

test("search returns empty when daemon error and no subprocess (daemon-only mode)", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  let invalidated = 0;
  client.daemonSession = {
    callTool: async () => {
      throw new Error("daemon search cancelled by internal restart");
    },
    invalidate: () => {
      invalidated += 1;
    },
  };
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.searchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [{ docid: "fallback", path: "/tmp/fallback.md", snippet: "fallback", score: 0.4 }];
  };

  // Daemon error without caller abort — returns empty, skips subprocess
  // (subprocess hangs at 99% CPU on large collections)
  const out = await client.search("cancelled", undefined, 3);
  assert.deepEqual(out, []);
  assert.equal(subprocessCalls, 0);
});

test("bm25Search returns empty when daemon error and no subprocess (daemon-only mode)", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  let invalidated = 0;
  client.daemonSession = {
    callTool: async () => {
      throw new Error("daemon bm25 cancelled by internal restart");
    },
    invalidate: () => {
      invalidated += 1;
    },
  };
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.bm25SearchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [{ docid: "fallback", path: "/tmp/fallback.md", snippet: "fallback", score: 0.4 }];
  };

  const out = await client.bm25Search("cancelled", undefined, 3);
  assert.deepEqual(out, []);
  assert.equal(subprocessCalls, 0);
});

test("vectorSearch returns empty when daemon error and no subprocess (daemon-only mode)", async () => {
  const client = new QmdClient("openclaw-engram", 5) as any;
  client.available = true;
  client.daemonAvailable = true;
  let invalidated = 0;
  client.daemonSession = {
    callTool: async () => {
      throw new Error("daemon vsearch cancelled by internal restart");
    },
    invalidate: () => {
      invalidated += 1;
    },
  };
  client.maybeProbeDaemon = async () => {};

  let subprocessCalls = 0;
  client.vsearchViaSubprocess = async () => {
    subprocessCalls += 1;
    return [{ docid: "fallback", path: "/tmp/fallback.md", snippet: "fallback", score: 0.4 }];
  };

  const out = await client.vectorSearch("cancelled", undefined, 3);
  assert.deepEqual(out, []);
  assert.equal(subprocessCalls, 0);
});
