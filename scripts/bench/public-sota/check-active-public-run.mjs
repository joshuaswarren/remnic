#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const defaultRunId = process.env.DEFAULT_PUBLIC_RUN_ID ?? 'public-matrix-codex-bf9b2643-20260515T052919Z';
const defaultResultsRoot = process.env.RESULTS_ROOT ?? path.join(os.homedir(), '.remnic/bench/results');
const [resultsDir = path.join(defaultResultsRoot, defaultRunId)] = process.argv.slice(2);

function hasTmuxSession(name) {
  try {
    execFileSync('tmux', ['has-session', '-t', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return 'running';
  } catch {
    return 'not-running';
  }
}

function readLines(file, count) {
  if (count <= 0) {
    return [];
  }
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-count);
}

function readStatusRows(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, 'utf8')
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean);
}

function benchmarkFromRun(runId, statusRows) {
  const latestStatusBenchmark = [...statusRows]
    .reverse()
    .map((line) => line.split('\t')[0])
    .find(Boolean);
  if (latestStatusBenchmark) {
    return latestStatusBenchmark;
  }
  if (runId.startsWith('public-matrix-codex-')) {
    return 'memory-arena';
  }
  const match = runId.match(/^public-(.+)-codex-/);
  return match?.[1] ?? null;
}

function latestLifecycleStart(statusRows, benchmark) {
  let latest;
  for (const line of statusRows) {
    const [rowBenchmark, status, timestamp] = line.split('\t');
    if (rowBenchmark !== benchmark) {
      continue;
    }
    if (status !== 'start' && !status?.startsWith('restart')) {
      continue;
    }
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }
    if (!latest || timestampMs > latest.timestampMs) {
      latest = { status, timestamp, timestampMs };
    }
  }
  return latest;
}

function newestDiagnostics(diagDir, count, lifecycleStart) {
  if (!fs.existsSync(diagDir)) {
    return {
      total: 0,
      allDiagnostics: 0,
      beforeLifecycleStart: 0,
      lifecycleStart: lifecycleStart
        ? {
            status: lifecycleStart.status,
            timestamp: lifecycleStart.timestamp,
          }
        : null,
      sampleSize: 0,
      errors: 0,
      nonzero: 0,
      inFlight: 0,
      sampleErrors: 0,
      sampleNonzero: 0,
      inFlightRecords: [],
      latestFinished: [],
      newest: [],
    };
  }
  const records = fs.readdirSync(diagDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(diagDir, name);
      return { name, file, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  let errors = 0;
  let nonzero = 0;
  let inFlight = 0;
  let beforeLifecycleStart = 0;
  const parsedRecords = records.flatMap((entry) => {
    try {
      const record = { ...JSON.parse(fs.readFileSync(entry.file, 'utf8')), name: entry.name };
      const startedAtMs = Date.parse(record.startedAt);
      if (
        lifecycleStart
        && Number.isFinite(startedAtMs)
        && startedAtMs < lifecycleStart.timestampMs
      ) {
        beforeLifecycleStart += 1;
        return [];
      }
      if (record.error || record.parseError) {
        errors += 1;
      }
      if (record.result && record.result.status !== 0) {
        nonzero += 1;
      }
      if (!record.finishedAt) {
        inFlight += 1;
      }
      return [record];
    } catch (error) {
      errors += 1;
      return [{ name: entry.name, parseError: String(error) }];
    }
  });
  const sample = parsedRecords.slice(0, count);
  const latestFinished = parsedRecords
    .filter((record) => record.finishedAt)
    .sort((left, right) => String(right.finishedAt).localeCompare(String(left.finishedAt)))
    .slice(0, 5);
  return {
    total: parsedRecords.length,
    allDiagnostics: records.length,
    beforeLifecycleStart,
    lifecycleStart: lifecycleStart
      ? {
          status: lifecycleStart.status,
          timestamp: lifecycleStart.timestamp,
        }
      : null,
    scanned: parsedRecords.length,
    countsMode: lifecycleStart ? 'diagnostics-since-lifecycle-start' : 'all-diagnostics',
    sampleSize: sample.length,
    errors,
    nonzero,
    inFlight,
    sampleErrors: sample.filter((record) => record.error || record.parseError).length,
    sampleNonzero: sample.filter((record) => record.result && record.result.status !== 0).length,
    inFlightRecords: sample
      .filter((record) => !record.finishedAt)
      .map((record) => ({
        name: record.name,
        startedAt: record.startedAt,
        ageSeconds: record.startedAt
          ? Math.round((Date.now() - Date.parse(record.startedAt)) / 1000)
          : undefined,
        provider: record.provider,
        model: record.model,
        reasoningEffort: record.reasoningEffort,
        serviceTier: record.serviceTier,
        promptChars: record.prompt?.chars,
      })),
    latestFinished: latestFinished
      .map((record) => ({
        name: record.name,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        durationMs: record.durationMs,
        provider: record.provider,
        model: record.model,
        reasoningEffort: record.reasoningEffort,
        serviceTier: record.serviceTier,
        status: record.result?.status,
        promptChars: record.prompt?.chars,
      })),
    newest: sample.slice(0, 5).map((record) => ({
      name: record.name,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      provider: record.provider,
      model: record.model,
      reasoningEffort: record.reasoningEffort,
      serviceTier: record.serviceTier,
      status: record.result?.status,
      error: record.error,
      parseError: record.parseError,
    })),
  };
}

function parseBenchmarkProgress(lines, benchmark) {
  if (!benchmark) {
    return null;
  }
  const latest = [...lines]
    .reverse()
    .find((line) => line.includes(`[${benchmark}]`));
  if (!latest) {
    return null;
  }
  const match = latest.match(/\[([^\]]+)\]\s+(\d+)\/(\d+)\s+tasks\s+\((\d+)s elapsed,\s+~(\d+)s remaining\)/);
  if (!match) {
    return { line: latest };
  }
  const completed = Number(match[2]);
  const total = Number(match[3]);
  const elapsedSeconds = Number(match[4]);
  const remainingSeconds = Number(match[5]);
  return {
    line: latest,
    benchmark: match[1],
    completed,
    total,
    remaining: total - completed,
    percent: total > 0 ? Math.round((completed / total) * 10000) / 100 : 0,
    elapsedSeconds,
    remainingSeconds,
    estimatedFinishAt: new Date(Date.now() + remainingSeconds * 1000).toISOString(),
  };
}

const runId = path.basename(resultsDir);
const statusRows = readStatusRows(path.join(resultsDir, 'status.tsv'));
const benchmark = benchmarkFromRun(runId, statusRows);
const lifecycleStart = latestLifecycleStart(statusRows, benchmark);
const monitorSessionName = runId === 'public-matrix-codex-bf9b2643-20260515T052919Z'
  ? 'public-matrix-codex-monitor-bf9b2643'
  : `${runId}-monitor`;
const jsonFiles = fs.existsSync(resultsDir)
  ? fs.readdirSync(resultsDir).filter((name) => name.endsWith('.json')).sort()
  : [];
const runLogTail = readLines(path.join(resultsDir, 'run.log'), 500);
const monitorPath = path.join(resultsDir, 'monitor-30m.log');
const monitorStat = fs.existsSync(monitorPath) ? fs.statSync(monitorPath) : undefined;
const summary = {
  runId,
  benchmark,
  resultsDir,
  benchmarkSession: hasTmuxSession(runId),
  monitorSession: hasTmuxSession(monitorSessionName),
  monitorSessionName,
  status: readLines(path.join(resultsDir, 'status.tsv'), 12),
  jsonFiles,
  benchmarkResultFiles: benchmark
    ? jsonFiles.filter((name) => name.startsWith(`${benchmark}-`))
    : [],
  memoryArenaResultFiles: jsonFiles.filter((name) => name.startsWith('memory-arena-')),
  runLogTail: runLogTail.slice(-12),
  progress: parseBenchmarkProgress(runLogTail, benchmark),
  monitor: monitorStat
    ? {
        mtime: monitorStat.mtime.toISOString(),
        ageSeconds: Math.round((Date.now() - monitorStat.mtimeMs) / 1000),
        tail: readLines(monitorPath, 12),
      }
    : null,
  diagnostics: newestDiagnostics(path.join(resultsDir, 'codex-cli-diagnostics'), 30, lifecycleStart),
  checkedAt: new Date().toISOString(),
};

console.log(JSON.stringify(summary, null, 2));
