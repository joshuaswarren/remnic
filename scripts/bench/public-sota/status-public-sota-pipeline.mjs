#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const resultsRoot = process.env.RESULTS_ROOT ?? path.join(os.homedir(), '.remnic/bench/results');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const activeRunChecker = path.join(scriptDir, 'check-active-public-run.mjs');
const benchmarks = [
  'ama-bench',
  'memory-arena',
  'amemgym',
  'longmemeval',
  'locomo',
  'beam',
  'memoryagentbench',
  'membench',
  'personamem',
];
const legacyMemoryArenaRunId = 'public-matrix-codex-bf9b2643-20260515T052919Z';

function exec(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', ...options }).trim();
  } catch {
    return '';
  }
}

function listTmuxSessions() {
  const raw = exec('tmux', ['list-sessions', '-F', '#S']);
  if (!raw) {
    return [];
  }
  return raw.split('\n').filter(Boolean).sort();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function latestDirForBenchmark(benchmark) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(resultsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(`public-${benchmark}-codex-`))
      .sort();
  } catch {
    return undefined;
  }
  return dirs.at(-1);
}

function latestRunIdForBenchmark(benchmark, activeRunId, activeRunStatus) {
  if (activeRunStatus?.benchmark === benchmark && activeRunId) {
    return activeRunId;
  }
  if (benchmark === 'memory-arena') {
    return latestDirForBenchmark(benchmark) ?? legacyMemoryArenaRunId;
  }
  return latestDirForBenchmark(benchmark);
}

function resultFilesFor(runId, benchmark) {
  if (!runId) {
    return [];
  }
  const dir = path.join(resultsRoot, runId);
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.startsWith(`${benchmark}-`) && name.endsWith('.json'))
      .filter((name) => !name.endsWith('-diagnostics-summary.json'))
      .filter((name) => !name.endsWith('-sota-comparison.json'))
      .sort();
  } catch {
    return [];
  }
}

function statusFileFor(runId) {
  if (!runId) {
    return undefined;
  }
  const file = path.join(resultsRoot, runId, 'status.tsv');
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(1);
  } catch {
    return undefined;
  }
}

const sessions = listTmuxSessions();
const scoringSessions = sessions.filter((session) => /^public-.*-codex-.*\d{8}T\d{6}Z$/.test(session));
const watcherSessions = sessions.filter((session) => session.startsWith('remnic-'));
const activeRunId = scoringSessions.length === 1 ? scoringSessions[0] : undefined;
let activeRunStatus;
if (activeRunId) {
  try {
    activeRunStatus = JSON.parse(execFileSync('node', [activeRunChecker, path.join(resultsRoot, activeRunId)], { encoding: 'utf8' }));
  } catch {
    activeRunStatus = undefined;
  }
}
let memoryArenaStatus;
const memoryArenaRunId = latestRunIdForBenchmark('memory-arena', activeRunId, activeRunStatus);
try {
  memoryArenaStatus = activeRunId === memoryArenaRunId && activeRunStatus
    ? activeRunStatus
    : JSON.parse(execFileSync('node', [activeRunChecker, path.join(resultsRoot, memoryArenaRunId)], { encoding: 'utf8' }));
} catch {
  memoryArenaStatus = undefined;
}

function publishWatcherSessionFor(benchmark) {
  if (benchmark === 'memory-arena') {
    return watcherSessions.find((session) => (
      session === 'remnic-memoryarena-publish-watcher' ||
      session.startsWith('remnic-memoryarena-publish-watcher-')
    )) ?? null;
  }
  const prefix = `remnic-${benchmark}-publish-watcher`;
  return watcherSessions.find((session) => session === prefix || session.startsWith(`${prefix}-`)) ?? null;
}

const benchmarkRows = benchmarks.map((benchmark) => {
  if (benchmark === 'ama-bench') {
    return {
      benchmark,
      published: true,
      pr: 1005,
      note: 'AMA-Bench SOTA evidence merged into bench/public-matrix-codex',
    };
  }

  const runId = latestRunIdForBenchmark(benchmark, activeRunId, activeRunStatus);
  const results = resultFilesFor(runId, benchmark);
  const statusRows = statusFileFor(runId);

  return {
    benchmark,
    runId: runId ?? null,
    resultCount: results.length,
    latestResult: results.at(-1) ?? null,
    status: statusRows ?? null,
    publishWatcher: publishWatcherSessionFor(benchmark),
  };
});

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  scoringSessions,
  watcherSessionCount: watcherSessions.length,
  watcherSessions,
  activeRun: activeRunStatus ? {
    runId: activeRunStatus.runId,
    benchmark: activeRunStatus.benchmark,
    benchmarkSession: activeRunStatus.benchmarkSession,
    progress: activeRunStatus.progress,
    resultFiles: activeRunStatus.benchmarkResultFiles,
    monitorSession: activeRunStatus.monitorSession,
    monitorSessionName: activeRunStatus.monitorSessionName,
    diagnostics: {
      total: activeRunStatus.diagnostics?.total,
      errors: activeRunStatus.diagnostics?.errors,
      nonzero: activeRunStatus.diagnostics?.nonzero,
      inFlight: activeRunStatus.diagnostics?.inFlight,
      finished: activeRunStatus.diagnostics?.finished,
      transientRetryFailures: activeRunStatus.diagnostics?.transientRetryFailures,
      latestFinished: activeRunStatus.diagnostics?.latestFinished?.[0] ?? null,
    },
  } : null,
  memoryArena: memoryArenaStatus ? {
    benchmarkSession: memoryArenaStatus.benchmarkSession,
    monitorSession: memoryArenaStatus.monitorSession,
    monitorSessionName: memoryArenaStatus.monitorSessionName,
    progress: memoryArenaStatus.progress,
    resultFiles: memoryArenaStatus.memoryArenaResultFiles,
    diagnostics: {
      total: memoryArenaStatus.diagnostics?.total,
      errors: memoryArenaStatus.diagnostics?.errors,
      nonzero: memoryArenaStatus.diagnostics?.nonzero,
      inFlight: memoryArenaStatus.diagnostics?.inFlight,
      finished: memoryArenaStatus.diagnostics?.finished,
      transientRetryFailures: memoryArenaStatus.diagnostics?.transientRetryFailures,
      latestFinished: memoryArenaStatus.diagnostics?.latestFinished?.[0] ?? null,
    },
  } : null,
  benchmarks: benchmarkRows,
}, null, 2));
