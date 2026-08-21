import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
/**
 * Corpus-watermark doctor check (issue #2149).
 *
 * Verifies `summarizeCorpusWatermark` reports per-namespace counts + a short
 * digest prefix and always resolves `ok` (this PR has no peer to compare
 * against, so it never warns), and that `runOperatorDoctor` wires it in.
 */
import test from "node:test";
import { parseConfig } from "./config.js";
import type { CorpusWatermark } from "./corpus-watermark.js";
import { summarizeCorpusWatermark } from "./operator-doctor-corpus.js";
import { type OperatorToolkitOrchestrator, runOperatorDoctor } from "./operator-toolkit.js";
import type { OperatorDoctorCheck } from "./operator-toolkit.js";
import { StorageManager } from "./storage.js";
import type { PluginConfig } from "./types.js";

const storageFactory = (dir: string) => new StorageManager(dir);

// The doctor stores the watermark array under `details.corpus`; `details` is
// typed `unknown`, so narrow it once here rather than at each read.
function corpusOf(check: OperatorDoctorCheck | undefined): CorpusWatermark[] {
  const details = check?.details;
  if (!details || typeof details !== "object" || !("corpus" in details)) return [];
  // `details.corpus` is `unknown` after the `in` guard; the doctor always
  // stores the watermark array here.
  const corpus = details.corpus as CorpusWatermark[];
  return corpus;
}

async function writeMemory(memoryDir: string, rel: string): Promise<void> {
  const full = path.join(memoryDir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, `---\nid: ${path.basename(rel, ".md")}\n---\n\nbody\n`, "utf-8");
}

async function makeFixture(): Promise<{
  root: string;
  memoryDir: string;
  config: PluginConfig;
  configPath: string;
  orchestrator: OperatorToolkitOrchestrator;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-corpus-doctor-"));
  const memoryDir = path.join(root, "memory");
  const workspaceDir = path.join(root, "workspace");
  await mkdir(memoryDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const rawConfig = {
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    sharedContextEnabled: false,
    captureMode: "implicit",
    namespacesEnabled: false,
    defaultNamespace: "global",
  };
  const config = parseConfig(rawConfig);
  const configPath = path.join(root, "openclaw.json");
  await writeFile(
    configPath,
    JSON.stringify({ plugins: { entries: { "openclaw-remnic": { config: rawConfig } } } }, null, 2),
    "utf-8"
  );
  const orchestrator: OperatorToolkitOrchestrator = {
    config,
    storage: new StorageManager(memoryDir),
    qmd: {
      async probe() {
        return false;
      },
      isAvailable() {
        return false;
      },
      async ensureCollection() {
        return "skipped";
      },
      debugStatus() {
        return "disabled";
      },
    },
    conversationIndexCoordinator: {
      async getHealth() {
        return {
          enabled: false,
          backend: "qmd" as const,
          status: "disabled" as const,
          chunkDocCount: 0,
          lastUpdateAt: null,
        };
      },
      async rebuild() {
        return { chunks: 0, skipped: true, reason: "disabled", embedded: false, rebuilt: false };
      },
    },
  };
  return { root, memoryDir, config, configPath, orchestrator };
}

test("summarizeCorpusWatermark: reports an ok check with per-namespace count and a short digest prefix", async () => {
  const { root, memoryDir, config } = await makeFixture();
  try {
    await writeMemory(memoryDir, "facts/2026-03-08/a.md");
    await writeMemory(memoryDir, "facts/2026-03-08/b.md");
    await writeMemory(memoryDir, "procedures/2026-03-09/c.md");

    const check = await summarizeCorpusWatermark(config, storageFactory);
    assert.equal(check.key, "corpus_watermark");
    assert.equal(check.status, "ok");
    const corpus = corpusOf(check);
    assert.equal(corpus.length, 1);
    assert.equal(corpus[0]?.namespace, "global");
    assert.equal(corpus[0]?.memoryFileCount, 3);
    assert.match(check.summary, /global: 3 files/);
    assert.match(check.summary, /digest=[0-9a-f]{12}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summarizeCorpusWatermark: an empty corpus still resolves ok with a zero count", async () => {
  const { root, config } = await makeFixture();
  try {
    const check = await summarizeCorpusWatermark(config, storageFactory);
    assert.equal(check.status, "ok");
    const corpus = corpusOf(check);
    assert.equal(corpus.length, 1);
    assert.equal(corpus[0]?.memoryFileCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runOperatorDoctor: includes the corpus_watermark check", async () => {
  const { root, memoryDir, configPath, orchestrator } = await makeFixture();
  try {
    await writeMemory(memoryDir, "facts/2026-03-08/a.md");
    let metadataReads = 0;
    const loadMeta = orchestrator.storage.loadMeta.bind(orchestrator.storage);
    orchestrator.storage.loadMeta = async () => {
      metadataReads += 1;
      return loadMeta();
    };
    const report = await runOperatorDoctor({ configPath, orchestrator });
    const check = report.checks.find((c) => c.key === "corpus_watermark");
    assert.ok(check, "expected a corpus_watermark check");
    assert.equal(check?.status, "ok");
    assert.equal(corpusOf(check)[0]?.memoryFileCount, 1);
    assert.equal(metadataReads, 1, "doctor reuses the root metadata read for extraction liveness");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summarizeCorpusWatermark: warns (not ok) when a namespace scan fails", async () => {
  const { root, config } = await makeFixture();
  try {
    // A storage factory that fails every scan (e.g. an EACCES permission
    // regression). The namespace is omitted, so the check must WARN — not
    // certify ok, and not conflate the failure with an empty deployment.
    const throwingFactory = (_dir: string): never => {
      throw new Error("simulated backend read failure");
    };
    const check = await summarizeCorpusWatermark(config, throwingFactory);
    assert.equal(check.status, "warn", "a scan failure must not be reported as ok");
    assert.match(check.summary, /unavailable|unreadable|churning/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
