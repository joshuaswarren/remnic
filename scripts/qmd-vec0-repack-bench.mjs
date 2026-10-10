/**
 * Synthetic vec0 repack bench for the QMD 2.5.3 backport of #937.
 *
 * The repack functions below are the same algorithm as
 * docs/patches/qmd-2.5.3-vec0-repack.patch (unpartitioned hash_seq table,
 * commit 58300dac). They are duplicated here so the bench can run with
 * better-sqlite3 and sqlite-vec and does not need a QMD build.
 *
 *   NODE_PATH=/path/to/node_modules \
 *   node scripts/qmd-vec0-repack-bench.mjs --self-check
 *
 *   NODE_PATH=/path/to/node_modules \
 *   node scripts/qmd-vec0-repack-bench.mjs \
 *     --chunks 3256 --keep-per-chunk 369 --dims 768 --queries 4 --k 20 \
 *     --db /tmp/qmd-vec0-repack.sqlite
 *
 * 3256 chunks with 369 live slots is about 1.20M live rows at 36% occupancy,
 * the shape reported for a sparse ~1.2M index. Dimension 768 is
 * embeddinggemma-300M. Prints one JSON object on stdout. No document text.
 */

import { createHash } from "node:crypto";
import { statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");

const VEC_REPACK_BELOW_OCCUPANCY = 0.9;
const VEC_REPACK_CHUNK_FILL = 0.9;
const CHUNK_SIZE = 1024;

function shouldRepackVectorTable(layout) {
  return layout.occupancy < VEC_REPACK_BELOW_OCCUPANCY;
}

function vectorTableLayout(db, droppedRows = 0) {
  const chunkRow = db.prepare("SELECT COUNT(*) AS chunks, MAX(size) AS chunkSize FROM vectors_vec_chunks").get();
  const stored = db.prepare("SELECT COUNT(*) AS c FROM vectors_vec_rowids").get().c;
  const rows = Math.max(stored - droppedRows, 0);
  const chunkSize = chunkRow.chunkSize ?? 0;
  const neededChunks = chunkSize > 0 ? Math.ceil(rows / chunkSize) : 0;
  const occupancy = chunkRow.chunks > 0 ? neededChunks / chunkRow.chunks : 1;
  return { rows, chunks: chunkRow.chunks, neededChunks, occupancy };
}

function liveSlots(chunk) {
  const slots = [];
  for (let i = 0; i < chunk.size; i++) {
    if ((chunk.validity[i >> 3] >> (i & 7)) & 1) slots.push(i);
  }
  return slots;
}

function repackVectors(db, onChunk) {
  const ddlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vectors_vec'`).get();
  if (!ddlRow?.sql.includes("hash_seq")) return vectorTableLayout(db);
  const chunks = db
    .prepare("SELECT chunk_id AS chunkId, size, validity, rowids FROM vectors_vec_chunks ORDER BY chunk_id")
    .all();
  const newest = chunks.length > 0 ? chunks[chunks.length - 1].chunkId : -1;
  const sparse = chunks.filter(
    (chunk) => chunk.chunkId !== newest && liveSlots(chunk).length < chunk.size * VEC_REPACK_CHUNK_FILL
  );
  const keyOf = db.prepare("SELECT id FROM vectors_vec_rowids WHERE rowid = ?");
  const vectorOf = db.prepare("SELECT embedding FROM vectors_vec WHERE hash_seq = ?");
  const remove = db.prepare("DELETE FROM vectors_vec WHERE hash_seq = ?");
  const insert = db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)");
  sparse.forEach((chunk, i) => {
    const rowids = new DataView(chunk.rowids.buffer, chunk.rowids.byteOffset, chunk.rowids.byteLength);
    db.transaction(() => {
      for (const slot of liveSlots(chunk)) {
        const key = keyOf.get(rowids.getBigInt64(slot * 8, true))?.id;
        if (key === undefined) continue;
        const row = vectorOf.get(key);
        if (row === undefined) continue;
        remove.run(key);
        insert.run(key, row.embedding);
      }
    }).immediate();
    onChunk?.(i + 1, sparse.length);
  });
  return vectorTableLayout(db);
}

function parseArgs(argv) {
  const out = {
    selfCheck: false,
    chunks: 3256,
    keepPerChunk: 369,
    dims: 768,
    queries: 4,
    k: 20,
    db: "/tmp/qmd-vec0-repack.sqlite",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--self-check") out.selfCheck = true;
    else if (arg === "--chunks") out.chunks = Number(argv[++i]);
    else if (arg === "--keep-per-chunk") out.keepPerChunk = Number(argv[++i]);
    else if (arg === "--dims") out.dims = Number(argv[++i]);
    else if (arg === "--queries") out.queries = Number(argv[++i]);
    else if (arg === "--k") out.k = Number(argv[++i]);
    else if (arg === "--db") out.db = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  for (const name of ["chunks", "keepPerChunk", "dims", "queries", "k"]) {
    if (!Number.isInteger(out[name]) || out[name] <= 0) throw new Error(`${name} must be a positive integer`);
  }
  if (out.keepPerChunk > CHUNK_SIZE) throw new Error("keep-per-chunk cannot exceed 1024");
  return out;
}

function openDb(path) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* fresh */
    }
  }
  const db = new Database(path);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("mmap_size = 0");
  db.pragma("cache_size = -65536");
  return db;
}

function fillVector(buf, seed) {
  let x = (seed + 1) >>> 0;
  for (let i = 0; i < buf.length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf[i] = ((x & 0xffffff) / 0xffffff) * 2 - 1;
  }
  buf[seed % buf.length] += 0.05;
}

function keyOfIndex(index) {
  return `v${String(index).padStart(8, "0")}`;
}

function createTable(db, dims) {
  db.exec(
    `CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dims}] distance_metric=cosine)`
  );
}

function insertRange(db, dims, from, to) {
  const insert = db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)");
  const buf = new Float32Array(dims);
  const tx = db.transaction((start, end) => {
    for (let i = start; i < end; i++) {
      fillVector(buf, i);
      insert.run(keyOfIndex(i), buf);
    }
  });
  const batch = 2000;
  for (let start = from; start < to; start += batch) {
    tx(start, Math.min(start + batch, to));
    if ((start - from) % 100000 < batch) {
      process.stderr.write(`inserted ${Math.min(start + batch, to) - from}/${to - from}\n`);
    }
  }
}

function punchHoles(db, total, keepPerChunk) {
  const remove = db.prepare("DELETE FROM vectors_vec WHERE hash_seq = ?");
  const tx = db.transaction((keys) => {
    for (const key of keys) remove.run(key);
  });
  const keys = [];
  for (let i = 0; i < total; i++) {
    if (i % CHUNK_SIZE >= keepPerChunk) keys.push(keyOfIndex(i));
    if (keys.length === 20000) {
      tx(keys);
      keys.length = 0;
    }
  }
  if (keys.length > 0) tx(keys);
}

function embeddingDigest(db) {
  const hash = createHash("sha256");
  const rows = db.prepare("SELECT hash_seq, embedding FROM vectors_vec ORDER BY hash_seq");
  let count = 0;
  for (const row of rows.iterate()) {
    hash.update(row.hash_seq);
    hash.update(row.embedding);
    count += 1;
  }
  return { sha256: hash.digest("hex"), count };
}

function knn(db, query, k) {
  const rows = db.prepare("SELECT hash_seq, distance FROM vectors_vec WHERE embedding MATCH ? AND k = ?").all(query, k);
  rows.sort((a, b) => {
    if (a.distance < b.distance) return -1;
    if (a.distance > b.distance) return 1;
    if (a.hash_seq < b.hash_seq) return -1;
    if (a.hash_seq > b.hash_seq) return 1;
    return 0;
  });
  return rows;
}

function copyEmbedding(db, key, dims) {
  const row = db.prepare("SELECT embedding FROM vectors_vec WHERE hash_seq = ?").get(key);
  if (!row) throw new Error(`missing ${key}`);
  const view = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, dims);
  return new Float32Array(view);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function fileBytes(path) {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(path + suffix).size;
    } catch {
      /* absent */
    }
  }
  return total;
}

function neighborsMatch(before, after) {
  if (before.length !== after.length) return false;
  for (let q = 0; q < before.length; q++) {
    if (before[q].length !== after[q].length) return false;
    for (let i = 0; i < before[q].length; i++) {
      if (before[q][i][0] !== after[q][i][0]) return false;
      if (before[q][i][1] !== after[q][i][1]) return false;
    }
  }
  return true;
}

function timeQueries(db, queries, k) {
  knn(db, queries[0], k);
  const times = [];
  const lists = [];
  for (const query of queries) {
    const started = performance.now();
    const rows = knn(db, query, k);
    times.push(performance.now() - started);
    lists.push(rows.map((row) => [row.hash_seq, row.distance]));
  }
  return { timesMs: times, lists };
}

function assertEqual(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${label}: ${left} !== ${right}`);
}

function selfCheck(dbPath) {
  const db = openDb(dbPath);
  createTable(db, 3);
  insertRange(db, 3, 0, 1100);
  const reused = db.prepare("SELECT embedding FROM vectors_vec WHERE hash_seq = ?").get(keyOfIndex(0));
  const reusedNext = db.prepare("SELECT embedding FROM vectors_vec WHERE hash_seq = ?").get(keyOfIndex(1));
  if (Buffer.compare(reused.embedding, reusedNext.embedding) === 0) {
    throw new Error("sqlite did not copy inserted embeddings; reused buffer collided");
  }
  // #937 fixture: 1100 rows, keep indexes 0, 1, and 1099 so both chunks stay allocated.
  const remove = db.prepare("DELETE FROM vectors_vec WHERE hash_seq = ?");
  const dropTx = db.transaction(() => {
    for (let i = 0; i < 1100; i++) {
      if (i !== 0 && i !== 1 && i !== 1099) remove.run(keyOfIndex(i));
    }
  });
  dropTx();

  const before = vectorTableLayout(db);
  assertEqual(before, { rows: 3, chunks: 2, neededChunks: 1, occupancy: 0.5 }, "holey layout");
  const probe = copyEmbedding(db, keyOfIndex(0), 3);
  const nearestBefore = knn(db, probe, 1)[0].hash_seq;
  if (nearestBefore !== keyOfIndex(0)) throw new Error(`nearest ${nearestBefore}`);
  const digestBefore = embeddingDigest(db);
  const after = repackVectors(db);
  assertEqual(after, { rows: 3, chunks: 1, neededChunks: 1, occupancy: 1 }, "packed layout");
  const digestAfter = embeddingDigest(db);
  if (digestBefore.sha256 !== digestAfter.sha256) throw new Error("embeddings changed");
  const nearestAfter = knn(db, probe, 1)[0].hash_seq;
  if (nearestAfter !== keyOfIndex(0)) throw new Error(`nearest after ${nearestAfter}`);

  const packed = openDb(`${dbPath}.packed`);
  createTable(packed, 3);
  insertRange(packed, 3, 0, 3);
  const packedLayout = vectorTableLayout(packed);
  if (shouldRepackVectorTable(packedLayout)) throw new Error("packed table should not repack");
  const packedAfter = repackVectors(packed);
  assertEqual(packedAfter, packedLayout, "packed no-op");

  const legacy = openDb(`${dbPath}.legacy`);
  legacy.exec(
    "CREATE VIRTUAL TABLE vectors_vec USING vec0(hash TEXT PRIMARY KEY, embedding float[3] distance_metric=cosine)"
  );
  const legacyInsert = legacy.prepare("INSERT INTO vectors_vec (hash, embedding) VALUES (?, ?)");
  const legacyTx = legacy.transaction(() => {
    for (let i = 0; i < 1100; i++) legacyInsert.run(`legacy${i}`, new Float32Array([1, i * 0.001, 0]));
    const legacyDel = legacy.prepare("DELETE FROM vectors_vec WHERE hash = ?");
    for (let i = 2; i < 1099; i++) legacyDel.run(`legacy${i}`);
  });
  legacyTx();
  const legacyBefore = vectorTableLayout(legacy);
  const legacyAfter = repackVectors(legacy);
  assertEqual(legacyAfter, legacyBefore, "legacy table left alone");

  db.close();
  packed.close();
  legacy.close();
  process.stdout.write(`${JSON.stringify({ selfCheck: true, ok: true })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfCheck) {
    selfCheck(args.db);
    return;
  }
  const total = args.chunks * CHUNK_SIZE;
  const db = openDb(args.db);
  createTable(db, args.dims);
  const insertStarted = performance.now();
  insertRange(db, args.dims, 0, total);
  punchHoles(db, total, args.keepPerChunk);
  const insertMs = performance.now() - insertStarted;
  const before = vectorTableLayout(db);
  if (!shouldRepackVectorTable(before)) throw new Error(`fixture is not sparse: ${JSON.stringify(before)}`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const bytesBefore = fileBytes(args.db);
  const digestBefore = embeddingDigest(db);

  const queryKeys = [];
  for (let q = 0; q < args.queries; q++) {
    const index = q * CHUNK_SIZE;
    queryKeys.push(keyOfIndex(index));
  }
  const queries = queryKeys.map((key) => copyEmbedding(db, key, args.dims));
  const beforeKnn = timeQueries(db, queries, args.k);

  const repackStarted = performance.now();
  const after = repackVectors(db, (moved, totalChunks) => {
    if (moved === totalChunks || moved % 100 === 0) {
      process.stderr.write(`repack ${moved}/${totalChunks}\n`);
    }
  });
  const repackMs = performance.now() - repackStarted;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const digestAfter = embeddingDigest(db);
  const afterKnn = timeQueries(db, queries, args.k);
  const bytesAfter = fileBytes(args.db);
  db.close();

  const result = {
    measuredOn: "vm",
    cpuCount: availableParallelism(),
    dims: args.dims,
    embeddingModelDims: "embeddinggemma-300M (768)",
    chunkSlots: total,
    keepPerChunk: args.keepPerChunk,
    layoutBefore: before,
    layoutAfter: after,
    embeddingsIdentical: digestBefore.sha256 === digestAfter.sha256 && digestBefore.count === digestAfter.count,
    embeddingRows: digestAfter.count,
    neighborsIdentical: neighborsMatch(beforeKnn.lists, afterKnn.lists),
    knnK: args.k,
    knnQueries: args.queries,
    knnBeforeMs: beforeKnn.timesMs,
    knnAfterMs: afterKnn.timesMs,
    knnBeforeMedianMs: median(beforeKnn.timesMs),
    knnAfterMedianMs: median(afterKnn.timesMs),
    insertAndPunchMs: insertMs,
    repackMs,
    fileBytesBefore: bytesBefore,
    fileBytesAfter: bytesAfter,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.embeddingsIdentical || !result.neighborsIdentical) process.exitCode = 1;
}

main();
