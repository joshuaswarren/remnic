#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const STATE_NAME = "AGENT-STATE.md";
const TAIL = 20;

function git(args) {
  return spawnSync("git", args, { encoding: "utf8" });
}

function fail(message, status = 1) {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  process.exit(status);
}

function usage() {
  fail(
    [
      "usage: agent-checkpoint.mjs write [--note <text>] [milestone...]",
      "       agent-checkpoint.mjs read [--json]",
    ].join("\n"),
    2,
  );
}

function resolveGitDir() {
  const result = git(["rev-parse", "--absolute-git-dir"]);
  if (result.status !== 0) {
    fail((result.stderr || "not a git repository").trim());
  }
  return result.stdout.trim();
}

function statePath() {
  return path.join(resolveGitDir(), STATE_NAME);
}

function parseArgs(argv) {
  let cmd;
  let note;
  let json = false;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--note") {
      note = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      usage();
    }
    if (!cmd && (arg === "write" || arg === "read")) {
      cmd = arg;
      continue;
    }
    rest.push(arg);
  }
  return { cmd, note, json, rest };
}

function writeCheckpoint({ note, rest }) {
  const head = git(["rev-parse", "--short", "HEAD"]);
  if (head.status !== 0) {
    fail((head.stderr || "unable to resolve HEAD").trim());
  }
  const milestone =
    note !== undefined ? note : rest.join(" ").trim() || "checkpoint";
  const line = `${new Date().toISOString()} | ${head.stdout.trim()} | ${milestone}\n`;
  appendFileSync(statePath(), line);
}

function parseLine(line) {
  const parts = line.split(" | ");
  if (parts.length < 3) {
    return { raw: line };
  }
  return {
    timestamp: parts[0],
    head: parts[1],
    note: parts.slice(2).join(" | "),
  };
}

function readCheckpoint({ json }) {
  const file = statePath();
  if (!existsSync(file)) {
    process.exit(1);
  }
  const entries = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (entries.length === 0) {
    process.exit(1);
  }
  const tail = entries.slice(-TAIL);
  process.stdout.write(
    json ? `${JSON.stringify(tail.map(parseLine))}\n` : `${tail.join("\n")}\n`,
  );
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.cmd === "write") {
  writeCheckpoint(parsed);
} else if (parsed.cmd === "read") {
  readCheckpoint(parsed);
} else {
  usage();
}
