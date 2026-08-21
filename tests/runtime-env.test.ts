import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { readEnvVar, resolveHomeDir } from "../src/runtime/env.js";

test("readEnvVar returns string values from process env", () => {
  const previousHome = process.env.HOME;

  process.env.HOME = "/tmp/engram-home";
  try {
    assert.equal(readEnvVar("HOME"), "/tmp/engram-home");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("resolveHomeDir falls back to os.homedir when HOME is unset", () => {
  const previousHome = process.env.HOME;

  delete process.env.HOME;
  try {
    assert.equal(resolveHomeDir(), os.homedir());
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("resolveHomeDir falls back to os.homedir when HOME is empty", () => {
  const previousHome = process.env.HOME;

  process.env.HOME = "";
  try {
    assert.equal(resolveHomeDir(), os.homedir());
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("resolveHomeDir prefers a non-empty HOME value", () => {
  const previousHome = process.env.HOME;

  process.env.HOME = "/tmp/engram-home";
  try {
    assert.equal(resolveHomeDir(), "/tmp/engram-home");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
