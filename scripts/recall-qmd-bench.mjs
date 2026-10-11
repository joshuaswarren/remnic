/**
 * Read-only QMD stage-timing bench for the Remnic daemon hybrid plan.
 *
 * lex + vec + synthetic hyde, limit 20, candidateLimit 40, rerank on.
 * `norerank` is the same plan with skipRerank. Nothing here lowers top-k.
 *
 *   QMD_STORE_MODULE=/path/to/@tobilu/qmd/dist/store.js \
 *   QMD_COLLECTION=<collection> \
 *   QMD_FORCE_CPU=1 \
 *   OUTDIR=/tmp/recall-after \
 *   node scripts/recall-qmd-bench.mjs /path/to/queries.json daemon
 *
 * queries.json is a JSON array of strings. The script writes
 * qNN-<mode>.json files. Compare with scripts/recall-qmd-compare.mjs.
 * It prints stage timings on stderr and does not echo document paths.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const modulePath = process.env.QMD_STORE_MODULE;
const collection = process.env.QMD_COLLECTION;
const queriesPath = process.argv[2];
const modes = (process.argv[3] || "daemon").split(",").filter(Boolean);
const outDir = process.env.OUTDIR || "/tmp/recall-qmd-bench";

if (!modulePath || !collection || !queriesPath) {
  process.stderr.write(
    "Usage: QMD_STORE_MODULE=<store.js> QMD_COLLECTION=<name> OUTDIR=<dir> node scripts/recall-qmd-bench.mjs <queries.json> [daemon,norerank]\n"
  );
  process.exit(1);
}

const storeModule = await import(modulePath);
storeModule.enableProductionMode();
const store = storeModule.createStore(storeModule.getDefaultDbPath("index"));
const queries = JSON.parse(readFileSync(queriesPath, "utf8"));
if (!Array.isArray(queries) || queries.some((query) => typeof query !== "string")) {
  process.stderr.write("queries file must be a JSON array of strings\n");
  process.exit(1);
}

const hydeFor = (query) => `A relevant Remnic memory would answer: ${query.trim()}`.slice(0, 320);

function hooksFor(timings) {
  const started = performance.now();
  const mark = (key) => {
    timings[key] = Math.round(performance.now() - started);
    process.stderr.write(`  ${key}@${timings[key]}ms\n`);
  };
  return {
    started,
    hooks: {
      onExpand: (_query, expanded, elapsedMs) => {
        timings.expandMs = elapsedMs;
        timings.expanded = Array.isArray(expanded) ? expanded.length : 0;
        mark("expandDone");
      },
      onEmbedStart: (count) => {
        timings.embedTexts = count;
        mark("embedStart");
      },
      onEmbedDone: (elapsedMs) => {
        timings.embedMs = elapsedMs;
        mark("embedDone");
      },
      onRerankStart: (count) => {
        timings.rerankChunks = count;
        mark("rerankStart");
      },
      onRerankDone: (elapsedMs) => {
        timings.rerankMs = elapsedMs;
        mark("rerankDone");
      },
    },
  };
}

async function run(mode, query) {
  const timings = {};
  const { started, hooks } = hooksFor(timings);
  const results = await storeModule.structuredSearch(
    store,
    [
      { type: "lex", query },
      { type: "vec", query },
      { type: "hyde", query: hydeFor(query) },
    ],
    {
      collections: [collection],
      limit: 20,
      candidateLimit: 40,
      skipRerank: mode === "norerank",
      hooks,
    }
  );
  timings.totalMs = Math.round(performance.now() - started);
  timings.searchMs = timings.totalMs - (timings.expandMs || 0) - (timings.embedMs || 0) - (timings.rerankMs || 0);
  return {
    mode,
    timings,
    results: results.map((result, index) => ({
      rank: index + 1,
      docid: result.docid,
      score: Number(Number(result.score).toFixed(4)),
    })),
  };
}

mkdirSync(outDir, { recursive: true });
const warmupStarted = performance.now();
await run("daemon", "warmup");
process.stderr.write(`warmup ${Math.round(performance.now() - warmupStarted)}ms\n`);

let index = 0;
for (const query of queries) {
  index += 1;
  for (const mode of modes) {
    process.stderr.write(`START ${mode} q${String(index).padStart(2, "0")}\n`);
    const captured = await run(mode, query);
    const name = `q${String(index).padStart(2, "0")}-${mode}.json`;
    writeFileSync(`${outDir}/${name}`, JSON.stringify(captured, null, 1));
    process.stderr.write(`DONE ${mode} q${String(index).padStart(2, "0")} ${captured.timings.totalMs}ms\n`);
  }
}
