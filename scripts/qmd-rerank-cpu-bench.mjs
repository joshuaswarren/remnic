/**
 * CPU rerank profile for qwen3-reranker-0.6b Q8 on node-llama-cpp 3.18.1.
 * The pinned QMD build uses 3.20.0. Prefix reuse, a larger token batch, and
 * fewer threads were slower or not order-stable. None of them ship.
 * See docs/qmd-2.8.3.md.
 *
 * Stock scoring calls LlamaRankingContext.rank(), which erases the whole
 * sequence before every document. The prefix trial evaluates the shared
 * query prefix once with evaluateWithoutGeneratingNewTokens, then scores
 * each document suffix the same way rank() reads its logit. It does not
 * truncate documents. QMD already truncates to context - 512 - query tokens;
 * these fixtures stay inside that budget.
 *
 *   NODE_PATH=/path/to/node_modules \
 *   QMD_FORCE_CPU=1 \
 *   node scripts/qmd-rerank-cpu-bench.mjs \
 *     --model /path/to/qwen3-reranker-0.6b-q8_0.gguf \
 *     --docs 8 --doc-chars 800 --full-docs 40
 *
 * Prints one JSON object. measuredOn is "vm". Scores are the trial, not a
 * host capture. No document text is printed.
 */

import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

async function loadLlama() {
  // node-llama-cpp is ESM with top-level await. require() throws, and a
  // static import would bind this script to one install. Resolve through
  // NODE_PATH, then import the file URL.
  const entry = require.resolve("node-llama-cpp");
  return import(pathToFileURL(entry).href);
}

function parseArgs(argv) {
  const out = {
    model: "",
    docs: 8,
    docChars: 800,
    fullDocs: 40,
    context: 4096,
    threads: 4,
    diverse: false,
    skipKnobs: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") out.model = argv[++i];
    else if (arg === "--docs") out.docs = Number(argv[++i]);
    else if (arg === "--doc-chars") out.docChars = Number(argv[++i]);
    else if (arg === "--full-docs") out.fullDocs = Number(argv[++i]);
    else if (arg === "--context") out.context = Number(argv[++i]);
    else if (arg === "--threads") out.threads = Number(argv[++i]);
    else if (arg === "--diverse") out.diverse = true;
    else if (arg === "--skip-knobs") out.skipKnobs = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!out.model) throw new Error("--model is required");
  for (const name of ["docs", "docChars", "fullDocs", "context", "threads"]) {
    if (!Number.isInteger(out[name]) || out[name] <= 0) throw new Error(`${name} must be a positive integer`);
  }
  return out;
}

function makeDocs(count, chars) {
  const docs = [];
  for (let i = 0; i < count; i++) {
    const sentence = `Memory note ${i} records that synthetic widget ${i} uses protocol revision ${i % 7} and stores ${1000 + i} units in bin ${i % 13}. `;
    let text = "";
    while (text.length < chars) text += sentence;
    docs.push(text.slice(0, chars));
  }
  return docs;
}

function makeDiverseDocs(count, chars) {
  const topics = [
    "The widget protocol revision is 4 and the bin count is 1000 units in bin 3.",
    "A recipe for oat bread uses flour, water, and salt and says nothing about widgets.",
    "Rain fell on the coast all morning and the harbor stayed closed.",
    "The ledger lists twelve invoices and none of them mention a protocol.",
    "Widget protocol revision 4 stores one thousand units. Bin count is the figure to report.",
    "Orchestra rehearsal moved to Thursday. The score is Brahms.",
    "Garden notes: tomatoes, basil, and a broken hose. No bins and no protocol.",
    "The widget bin count is 1000 and the protocol revision is the one named in the question.",
  ];
  const docs = [];
  for (let i = 0; i < count; i++) {
    const sentence = `${topics[i % topics.length]} Note ${i}. `;
    let text = "";
    while (text.length < chars) text += sentence;
    docs.push(text.slice(0, chars));
  }
  return docs;
}

function sigmoid(logit) {
  return 1 / (1 + Math.exp(-logit));
}

async function drainGenerated(sequence, tokens) {
  const iterator = sequence.evaluate(tokens, { _noSampling: true });
  for await (const _token of iterator) break;
}

function splitAtDocument(ranking, query, document) {
  const full = ranking._getEvaluationInput(query, document);
  const empty = ranking._getEvaluationInput(query, "");
  const extra = full.length - empty.length;
  if (extra < 0) return null;
  for (let prefixLen = 0; prefixLen <= empty.length; prefixLen++) {
    let matches = true;
    for (let i = 0; i < prefixLen; i++) {
      if (full[i] !== empty[i]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    for (let i = prefixLen; i < empty.length; i++) {
      if (full[i + extra] !== empty[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return { full, prefixLen };
  }
  return null;
}

async function stockScores(ranking, query, docs) {
  const scores = [];
  const started = performance.now();
  for (const doc of docs) scores.push(await ranking.rank(query, doc));
  return { ms: performance.now() - started, scores };
}

async function prefixScores(ranking, query, docs) {
  const splits = docs.map((doc) => splitAtDocument(ranking, query, doc));
  if (splits.some((split) => split == null)) throw new Error("template split failed");
  const prefixLen = splits[0].prefixLen;
  const prefix = splits[0].full.slice(0, prefixLen);
  for (const split of splits) {
    if (split.prefixLen !== prefixLen) throw new Error("prefix length differs across documents");
    for (let i = 0; i < prefixLen; i++) {
      if (split.full[i] !== prefix[i]) throw new Error("prefix tokens differ across documents");
    }
  }
  const sequence = ranking._sequence;
  await sequence.eraseContextTokenRanges([{ start: 0, end: sequence.nextTokenIndex }]);
  const started = performance.now();
  await sequence.evaluateWithoutGeneratingNewTokens(prefix);
  if (sequence.nextTokenIndex !== prefixLen) {
    throw new Error(`prefix eval left ${sequence.nextTokenIndex} tokens, expected ${prefixLen}`);
  }
  const scores = [];
  for (const split of splits) {
    const suffix = split.full.slice(prefixLen);
    await drainGenerated(sequence, suffix);
    const embedding = ranking._llamaContext._ctx.getEmbedding(split.full.length, 1);
    scores.push(embedding.length === 0 ? 0 : sigmoid(embedding[0]));
    await sequence.eraseContextTokenRanges([{ start: prefixLen, end: sequence.nextTokenIndex }]);
    if (sequence.nextTokenIndex !== prefixLen) {
      throw new Error(`suffix erase left ${sequence.nextTokenIndex} tokens, expected ${prefixLen}`);
    }
  }
  return {
    ms: performance.now() - started,
    scores,
    prefixTokens: prefixLen,
    totalTokens: splits.map((split) => split.full.length),
  };
}

function maxAbsDiff(left, right) {
  let max = 0;
  for (let i = 0; i < left.length; i++) max = Math.max(max, Math.abs(left[i] - right[i]));
  return max;
}

function orderOf(scores) {
  return scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => {
      if (a.score < b.score) return 1;
      if (a.score > b.score) return -1;
      if (a.index < b.index) return -1;
      if (a.index > b.index) return 1;
      return 0;
    })
    .map((row) => row.index);
}

function sameOrder(left, right) {
  const a = orderOf(left);
  const b = orderOf(right);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function pairwiseInversions(left, right) {
  let flipped = 0;
  let pairs = 0;
  for (let i = 0; i < left.length; i++) {
    for (let j = i + 1; j < left.length; j++) {
      const gap = left[i] - left[j];
      if (gap === 0) continue;
      pairs++;
      const other = right[i] - right[j];
      if (other === 0 || (gap > 0 && other < 0) || (gap < 0 && other > 0)) flipped++;
    }
  }
  return { flipped, pairs };
}

function minPositiveGap(scores) {
  const sorted = [...scores].sort((a, b) => a - b);
  let min = null;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && (min == null || gap < min)) min = gap;
  }
  return min;
}

async function openRanking(model, { context, threads, batchSize }) {
  const options = { contextSize: context, threads };
  if (batchSize != null) options.batchSize = batchSize;
  const ranking = await model.createRankingContext(options);
  return ranking;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { getLlama, LlamaLogLevel } = await loadLlama();
  const query = "Which note describes the widget protocol revision and the bin count?";
  process.stderr.write("loading llama cpu\n");
  const llama = await getLlama({
    gpu: false,
    build: "never",
    logLevel: LlamaLogLevel.error,
    progressLogs: false,
  });
  process.stderr.write("loading model\n");
  const model = await llama.loadModel({ modelPath: args.model, gpuLayers: 0 });
  const buildDocs = args.diverse ? makeDiverseDocs : makeDocs;
  const probeDocs = buildDocs(args.docs, args.docChars);
  const stockRanking = await openRanking(model, { context: args.context, threads: args.threads });
  const stock = await stockScores(stockRanking, query, probeDocs);
  const batchSize = stockRanking._llamaContext.batchSize;
  process.stderr.write(`stock ${args.docs} docs ${stock.ms.toFixed(0)}ms batch ${batchSize}\n`);
  const stockRepeat = await stockScores(stockRanking, query, probeDocs);
  process.stderr.write(`stock repeat ${stockRepeat.ms.toFixed(0)}ms\n`);
  const prefix = await prefixScores(stockRanking, query, probeDocs);
  process.stderr.write(`prefix ${args.docs} docs ${prefix.ms.toFixed(0)}ms\n`);

  let biggerBatch = null;
  let batchUsed = null;
  let fewerThreads = null;
  let batchRanking = null;
  let threadRanking = null;
  if (!args.skipKnobs) {
    batchRanking = await openRanking(model, {
      context: args.context,
      threads: args.threads,
      batchSize: Math.max(batchSize * 4, 2048),
    });
    biggerBatch = await stockScores(batchRanking, query, probeDocs);
    batchUsed = batchRanking._llamaContext.batchSize;

    threadRanking = await openRanking(model, {
      context: args.context,
      threads: Math.max(1, Math.floor(args.threads / 2)),
    });
    fewerThreads = await stockScores(threadRanking, query, probeDocs);
  }

  const fullDocs = buildDocs(args.fullDocs, args.docChars);
  const fullStock = await stockScores(stockRanking, query, fullDocs);
  const fullPrefix = await prefixScores(stockRanking, query, fullDocs);
  const full = {
    docs: args.fullDocs,
    stockMs: fullStock.ms,
    prefixMs: fullPrefix.ms,
    maxAbsDiff: maxAbsDiff(fullStock.scores, fullPrefix.scores),
    sameOrder: sameOrder(fullStock.scores, fullPrefix.scores),
    inversions: pairwiseInversions(fullStock.scores, fullPrefix.scores),
    prefixTokens: fullPrefix.prefixTokens,
    totalTokensMin: Math.min(...fullPrefix.totalTokens),
    totalTokensMax: Math.max(...fullPrefix.totalTokens),
  };
  process.stderr.write(`full stock ${full.stockMs.toFixed(0)}ms prefix ${full.prefixMs.toFixed(0)}ms\n`);

  await stockRanking.dispose();
  if (batchRanking) await batchRanking.dispose();
  if (threadRanking) await threadRanking.dispose();
  await model.dispose();
  await llama.dispose();

  const result = {
    measuredOn: "vm",
    cpuCount: availableParallelism(),
    gpu: false,
    model: "qwen3-reranker-0.6b-q8_0.gguf",
    contextSize: args.context,
    docChars: args.docChars,
    diverse: args.diverse,
    threads: args.threads,
    batchSize,
    probeDocs: args.docs,
    stockMs: stock.ms,
    stockRepeatMs: stockRepeat.ms,
    prefixMs: prefix.ms,
    prefixTokens: prefix.prefixTokens,
    totalTokensMin: Math.min(...prefix.totalTokens),
    totalTokensMax: Math.max(...prefix.totalTokens),
    stockScores: stock.scores,
    prefixScores: prefix.scores,
    stockRepeatMaxAbsDiff: maxAbsDiff(stock.scores, stockRepeat.scores),
    stockRepeatSameOrder: sameOrder(stock.scores, stockRepeat.scores),
    stockMinPositiveGap: minPositiveGap(stock.scores),
    prefixMaxAbsDiff: maxAbsDiff(stock.scores, prefix.scores),
    prefixSameOrder: sameOrder(stock.scores, prefix.scores),
    prefixInversions: pairwiseInversions(stock.scores, prefix.scores),
    biggerBatch: biggerBatch
      ? {
          batchSize: batchUsed,
          ms: biggerBatch.ms,
          maxAbsDiff: maxAbsDiff(stock.scores, biggerBatch.scores),
          sameOrder: sameOrder(stock.scores, biggerBatch.scores),
        }
      : null,
    fewerThreads: fewerThreads
      ? {
          threads: Math.max(1, Math.floor(args.threads / 2)),
          ms: fewerThreads.ms,
          maxAbsDiff: maxAbsDiff(stock.scores, fewerThreads.scores),
          sameOrder: sameOrder(stock.scores, fewerThreads.scores),
        }
      : null,
    full,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
