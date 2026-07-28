import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const SCRIPT_PATH = path.join(ROOT, "scripts/check-dataset-hygiene.mjs");

function runScript(env = {}) {
  const result = spawnSync("node", [SCRIPT_PATH], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return result;
}

test("clean tree passes hygiene check", () => {
  const res = runScript();
  assert.equal(res.status, 0, `Expected exit 0, got ${res.status}. Output: ${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /Dataset hygiene check passed/);
});

test("detects email address rule class in temp dir", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "hygiene-email-"));
  try {
    writeFileSync(
      path.join(tempDir, "data.json"),
      JSON.stringify({ contact: "alice@realcompany.com" })
    );
    const res = runScript({ REMNIC_HYGIENE_ROOTS: tempDir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /\[email\]/);
    assert.match(res.stderr, /al\u2026/);
    assert.ok(!res.stderr.includes("alice@realcompany.com"), "full email must never be echoed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("synthetic emails (.example, .synthetic) pass without findings", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "hygiene-synthetic-email-"));
  try {
    writeFileSync(
      path.join(tempDir, "data.json"),
      JSON.stringify({
        a: "maya.torres@synthetic.example",
        b: "standup@bench.synthetic",
        c: "test@domain.test",
      })
    );
    const res = runScript({ REMNIC_HYGIENE_ROOTS: tempDir });
    assert.equal(res.status, 0, `Expected exit 0, got ${res.status}. Output: ${res.stdout}\n${res.stderr}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Built at runtime so the literal key shapes never appear in committed source
// (the repo-wide gitleaks scan flags them even in fixtures).
const FAKE_SK = ["sk", "123456789012345678901234"].join("-");
const FAKE_GHP = ["ghp", "123456789012345678901234567890123456"].join("_");
const FAKE_AKIA = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

test("detects API key rule class in temp dir", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "hygiene-apikey-"));
  try {
    writeFileSync(
      path.join(tempDir, "config.txt"),
      `OPENAI_KEY=${FAKE_SK}\nGITHUB_TOKEN=${FAKE_GHP}\nAWS=${FAKE_AKIA}\n`
    );
    const res = runScript({ REMNIC_HYGIENE_ROOTS: tempDir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /\[api-key\]/);
    assert.match(res.stderr, new RegExp(`${FAKE_SK.slice(0, 6)}\\u2026`));
    assert.match(res.stderr, new RegExp(`${FAKE_GHP.slice(0, 6)}\\u2026`));
    assert.match(res.stderr, new RegExp(`${FAKE_AKIA.slice(0, 6)}\\u2026`));
    assert.ok(!res.stderr.includes(FAKE_SK), "full token must never be echoed");
    assert.ok(!res.stderr.includes(FAKE_GHP), "full token must never be echoed");
    assert.ok(!res.stderr.includes(FAKE_AKIA), "full token must never be echoed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("detects phone number rule class in temp dir", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "hygiene-phone-"));
  try {
    writeFileSync(
      path.join(tempDir, "user.json"),
      JSON.stringify({ phone: "555-867-5309" })
    );
    const res = runScript({ REMNIC_HYGIENE_ROOTS: tempDir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /\[phone\]/);
    assert.match(res.stderr, /55\u2026/);
    assert.ok(!res.stderr.includes("555-867-5309"), "full phone number must never be echoed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("detects IPv4 rule class outside loopback and TEST-NET-1", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "hygiene-ip-"));
  try {
    writeFileSync(
      path.join(tempDir, "servers.json"),
      JSON.stringify({
        validLocal: "127.0.0.1",
        validTestNet: "192.0.2.45",
        invalidPublic: "203.0.113.195",
      })
    );
    const res = runScript({ REMNIC_HYGIENE_ROOTS: tempDir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /\[ipv4\]/);
    assert.match(res.stderr, /203\.0\.113\.195/);
    assert.doesNotMatch(res.stderr, /127\.0\.0\.1/);
    assert.doesNotMatch(res.stderr, /192\.0\.2\.45/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("detects URL rule class for hosts outside allowlist in data files", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "hygiene-url-"));
  try {
    writeFileSync(
      path.join(tempDir, "links.json"),
      JSON.stringify({
        good1: "https://example.com/docs",
        good2: "https://sub.example.com/path",
        good3: "https://arxiv.org/abs/2301.00001",
        good4: "https://github.com/joshuaswarren/remnic/issues/1954",
        bad1: "https://unauthorized-domain.com/data",
        bad2: "https://github.com/otheruser/otherrepo",
      })
    );
    const res = runScript({ REMNIC_HYGIENE_ROOTS: tempDir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /\[url-allowlist\]/);
    assert.match(res.stderr, /unauthorized-domain\.com/);
    assert.match(res.stderr, /otheruser\/otherrepo/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("detects denylist names and ignores comment lines in denylist file", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "hygiene-denylist-"));
  const customDenylist = path.join(tempDir, "denylist.txt");
  try {
    writeFileSync(
      customDenylist,
      "# Maintainer-reserved names\n# Another comment line\n\njoshua\nwarren\n"
    );
    writeFileSync(
      path.join(tempDir, "sample.txt"),
      "This file references Maintainer-reserved names and comment line, plus Joshua Warren.\n"
    );
    const res = runScript({
      REMNIC_HYGIENE_ROOTS: tempDir,
      REMNIC_HYGIENE_DENYLIST: customDenylist,
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /\[denylist\]/);
    assert.match(res.stderr, /joshua/i);
    assert.match(res.stderr, /warren/i);
    assert.doesNotMatch(res.stderr, /Maintainer-reserved/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("enforces deterministic output ordering (sorts by file, then line)", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "hygiene-order-"));
  try {
    writeFileSync(
      path.join(tempDir, "fileB.json"),
      JSON.stringify({ leak: FAKE_SK })
    );
    writeFileSync(
      path.join(tempDir, "fileA.json"),
      `line 1 ok\nline 2 ${FAKE_SK}\nline 3 ok\nline 4 ${FAKE_GHP}\n`
    );
    const res = runScript({ REMNIC_HYGIENE_ROOTS: tempDir });
    assert.equal(res.status, 1);
    const lines = res.stderr.trim().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /fileA\.json:2/);
    assert.match(lines[1], /fileA\.json:4/);
    assert.match(lines[2], /fileB\.json:1/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
test("rejects symlinked root directory with exit 1", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "hygiene-symroot-real-"));
  const symlinkRoot = path.join(tmpdir(), `hygiene-symroot-link-${Date.now()}`);
  try {
    symlinkSync(tempDir, symlinkRoot, "dir");
    const res = runScript({ REMNIC_HYGIENE_ROOTS: symlinkRoot });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /symlink/i);
  } finally {
    rmSync(symlinkRoot, { force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("skips symlinked file and directory inside root", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "hygiene-syminside-"));
  const outsideDir = mkdtempSync(path.join(tmpdir(), "hygiene-outside-"));
  try {
    // Secret file outside root
    const targetFile = path.join(outsideDir, "secret.json");
    writeFileSync(targetFile, JSON.stringify({ key: FAKE_SK }));

    // Symlink file inside root pointing to secret file
    const symlinkFile = path.join(tempDir, "linked-secret.json");
    symlinkSync(targetFile, symlinkFile);

    // Secret dir outside root
    const targetSubdir = path.join(outsideDir, "subdir");
    mkdirSync(targetSubdir, { recursive: true });
    writeFileSync(path.join(targetSubdir, "secret2.json"), JSON.stringify({ key: FAKE_GHP }));

    // Symlink dir inside root pointing to secret dir
    const symlinkDir = path.join(tempDir, "linked-dir");
    symlinkSync(targetSubdir, symlinkDir, "dir");

    // Clean file inside root
    writeFileSync(path.join(tempDir, "clean.json"), JSON.stringify({ ok: true }));

    const res = runScript({ REMNIC_HYGIENE_ROOTS: tempDir });
    assert.equal(res.status, 0);
    assert.match(res.stderr, /\[symlink-skipped\]/);
    assert.match(res.stdout, /Dataset hygiene check passed/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("detects malformed URL parse failure as a finding", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "hygiene-malformed-url-"));
  try {
    writeFileSync(
      path.join(tempDir, "data.json"),
      JSON.stringify({ url: "https://api.example.com:abc/x" })
    );
    const res = runScript({ REMNIC_HYGIENE_ROOTS: tempDir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /url-allowlist/);
    assert.match(res.stderr, /https:\/\/api\.example\.com:abc\/x/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("handles denylist name scanning with allowlisted URLs", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "hygiene-denylist-url-"));
  const denylistDir = mkdtempSync(path.join(tmpdir(), "hygiene-denylist-file-"));
  const denylistFile = path.join(denylistDir, "denylist.txt");
  writeFileSync(denylistFile, "joshuaswarren\n");

  try {
    // Line containing only allowlisted URL with denylisted name substring passes
    writeFileSync(
      path.join(tempDir, "clean.md"),
      "https://github.com/joshuaswarren/remnic/issues/1\n"
    );
    const resClean = runScript({
      REMNIC_HYGIENE_ROOTS: tempDir,
      REMNIC_HYGIENE_DENYLIST: denylistFile,
    });
    assert.equal(resClean.status, 0);
    assert.match(resClean.stdout, /Dataset hygiene check passed/);

    // Line containing denylisted name outside allowlisted URL fails
    writeFileSync(
      path.join(tempDir, "dirty.md"),
      "Author joshuaswarren worked on https://github.com/joshuaswarren/remnic/issues/1\n"
    );
    const resDirty = runScript({
      REMNIC_HYGIENE_ROOTS: tempDir,
      REMNIC_HYGIENE_DENYLIST: denylistFile,
    });
    assert.equal(resDirty.status, 1);
    assert.match(resDirty.stderr, /Denylist name matched: "joshuaswarren"/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(denylistDir, { recursive: true, force: true });
  }
});
