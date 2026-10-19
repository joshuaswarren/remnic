/**
 * Heap regression for the scheduled projection rebuild.
 *
 * About 20k synthetic facts (~2 KB each) and a 100k-line lifecycle ledger are
 * rebuilt once under `--max-old-space-size=192` and once with the default
 * heap. Row counts and the SHA-256 of the projection rows must match. The
 * child is a fresh process so the fixture writer does not share its heap
 * with the rebuild.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";

const FACT_COUNT = 20_000;
const LEDGER_LINES = 100_000;
const BODY_BYTES = 2048;
const FIXED_NOW = "2026-06-01T00:00:00.000Z";
const CHILD_FLAG = "--projection-memory-child";

function factId(index: number): string {
  return `fact-${String(index).padStart(5, "0")}`;
}

async function writeCorpus(memoryDir: string): Promise<void> {
  const factDir = path.join(memoryDir, "facts", "2026-01-01");
  await mkdir(factDir, { recursive: true });
  await mkdir(path.join(memoryDir, "state"), { recursive: true });
  let next = 0;
  const workers = Array.from({ length: 32 }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= FACT_COUNT) return;
      const id = factId(index);
      const body = Buffer.alloc(BODY_BYTES, 97);
      body.write(`fact ${id} `);
      for (let offset = 16; offset < body.length; offset += 1) {
        body[offset] = 97 + ((index + offset) % 26);
      }
      const markdown = `---\nid: ${id}\ncategory: fact\nconfidence: 0.5\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nstatus: active\nsource: synthetic\n---\n\n${body.toString("utf8")}\n`;
      await writeFile(path.join(factDir, `${id}.md`), markdown);
    }
  });
  await Promise.all(workers);

  const ledger = createWriteStream(path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl"));
  for (let index = 0; index < LEDGER_LINES; index += 1) {
    const line = `{"eventId":"evt-${String(index).padStart(6, "0")}","memoryId":"${factId(index % FACT_COUNT)}","eventType":"created","timestamp":"${new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString()}","actor":"synthetic","ruleVersion":"1"}\n`;
    if (!ledger.write(line)) await once(ledger, "drain");
  }
  ledger.end();
  await once(ledger, "finish");
}

async function runChild(memoryDir: string, maxOldSpace?: number): Promise<void> {
  const args: string[] = [];
  if (maxOldSpace !== undefined) args.push(`--max-old-space-size=${maxOldSpace}`);
  args.push("--import", "tsx", fileURLToPath(import.meta.url), CHILD_FLAG, memoryDir);
  const nodeOptions = (process.env.NODE_OPTIONS ?? "")
    .split(" ")
    .filter((part) => part.length > 0 && !part.startsWith("--max-old-space-size"))
    .join(" ");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`projection memory child exited ${code ?? "null"}`));
    });
  });
}

async function projectionDigest(memoryDir: string): Promise<{ hash: string; counts: Record<string, number> }> {
  const { openProjectionReadonly } = await import("../memory-projection-store.js");
  const db = openProjectionReadonly(memoryDir);
  if (!db) throw new Error("projection was not written");
  try {
    const hash = createHash("sha256");
    const counts: Record<string, number> = {};
    const queries: Array<[string, string]> = [
      ["memory_current", "SELECT * FROM memory_current ORDER BY memory_id"],
      ["memory_timeline", "SELECT * FROM memory_timeline ORDER BY event_id"],
      ["memory_entity_mentions", "SELECT * FROM memory_entity_mentions ORDER BY memory_id, entity_ref, mention_source"],
    ];
    for (const [name, sql] of queries) {
      hash.update(name);
      hash.update("\n");
      let count = 0;
      for (const row of db.prepare(sql).iterate()) {
        count += 1;
        hash.update(JSON.stringify(row));
        hash.update("\n");
      }
      counts[name] = count;
    }
    return { hash: hash.digest("hex"), counts };
  } finally {
    db.close();
  }
}

async function rebuildInThisProcess(memoryDir: string): Promise<void> {
  const { rebuildMemoryProjection } = await import("./rebuild-memory-projection.js");
  const result = await rebuildMemoryProjection({
    memoryDir,
    dryRun: false,
    now: new Date(FIXED_NOW),
  });
  const stats = v8.getHeapStatistics();
  console.log(
    `projection-memory-child rows current=${result.currentRows} timeline=${result.timelineRows} `
    + `heap used=${stats.used_heap_size} limit=${stats.heap_size_limit}`,
  );
}

const childDir = process.argv.indexOf(CHILD_FLAG);
if (childDir >= 0) {
  const memoryDir = process.argv[childDir + 1];
  if (!memoryDir) {
    console.error("projection memory child requires a memory directory");
    process.exit(2);
  }
  try {
    await rebuildInThisProcess(memoryDir);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
  process.exit(0);
} else {
  const { default: test } = await import("node:test");

  test("slow: 20k-fact projection rebuild matches under a 192MB heap", { timeout: 600_000 }, async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-proj-heap-corpus-"));
    try {
      await writeCorpus(memoryDir);
      await runChild(memoryDir, 192);
      const constrained = await projectionDigest(memoryDir);
      await runChild(memoryDir);
      const unconstrained = await projectionDigest(memoryDir);
      assert.equal(constrained.counts.memory_current, FACT_COUNT);
      assert.equal(constrained.counts.memory_timeline, LEDGER_LINES);
      assert.deepEqual(unconstrained.counts, constrained.counts);
      assert.equal(unconstrained.hash, constrained.hash);
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });
}
