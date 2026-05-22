import assert from "node:assert/strict";
import test from "node:test";

import { readEnvVar } from "./env.js";

test("readEnvVar prefers REMNIC values over ENGRAM values for paired names", () => {
  const previousRemnic = process.env.REMNIC_MEMORY_DIR;
  const previousEngram = process.env.ENGRAM_MEMORY_DIR;
  try {
    process.env.REMNIC_MEMORY_DIR = "/new";
    process.env.ENGRAM_MEMORY_DIR = "/old";

    assert.equal(readEnvVar("REMNIC_MEMORY_DIR"), "/new");
    assert.equal(readEnvVar("ENGRAM_MEMORY_DIR"), "/new");
  } finally {
    if (previousRemnic === undefined) {
      delete process.env.REMNIC_MEMORY_DIR;
    } else {
      process.env.REMNIC_MEMORY_DIR = previousRemnic;
    }
    if (previousEngram === undefined) {
      delete process.env.ENGRAM_MEMORY_DIR;
    } else {
      process.env.ENGRAM_MEMORY_DIR = previousEngram;
    }
  }
});

test("readEnvVar falls back to ENGRAM values when REMNIC values are absent", () => {
  const previousRemnic = process.env.REMNIC_MEMORY_DIR;
  const previousEngram = process.env.ENGRAM_MEMORY_DIR;
  try {
    delete process.env.REMNIC_MEMORY_DIR;
    process.env.ENGRAM_MEMORY_DIR = "/old";

    assert.equal(readEnvVar("REMNIC_MEMORY_DIR"), "/old");
    assert.equal(readEnvVar("ENGRAM_MEMORY_DIR"), "/old");
  } finally {
    if (previousRemnic === undefined) {
      delete process.env.REMNIC_MEMORY_DIR;
    } else {
      process.env.REMNIC_MEMORY_DIR = previousRemnic;
    }
    if (previousEngram === undefined) {
      delete process.env.ENGRAM_MEMORY_DIR;
    } else {
      process.env.ENGRAM_MEMORY_DIR = previousEngram;
    }
  }
});
