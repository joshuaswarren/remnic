import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CaptureProcessor,
  computeStats,
  contentHash,
  isTerminalApp,
  type CaptureCandidate,
  type OcrFn,
} from "./capture.js";
import { defaultDaemonConfig, type DaemonConfig } from "./config.js";
import type { AxNode } from "./axtree.js";
import type { DaemonSnapshot } from "./spool.js";

function proc(overrides: Partial<DaemonConfig> = {}, ocr?: OcrFn): CaptureProcessor {
  return new CaptureProcessor({ ...defaultDaemonConfig(), ...overrides }, ocr);
}

const at = (s: string) => `2026-07-20T10:00:${s}.000Z`;

test("a deny-listed app records nothing and names the rule", () => {
  const decision = proc().process({ capturedAtUtc: at("00"), app: "1Password 8", windowTitle: "Vault", text: "secrets" });
  assert.deepEqual(decision, { action: "denied", rule: "app:1Password*" });
});

test("a normal AX candidate is stored with extracted, redacted text", () => {
  const ax: AxNode = {
    role: "AXWindow",
    children: [
      { role: "AXStaticText", value: "Order total" },
      { role: "AXTextField", value: "card 4242 4242 4242 4242" },
    ],
  };
  const decision = proc().process({ capturedAtUtc: at("00"), app: "Safari", windowTitle: "Checkout", ax });
  assert.equal(decision.action, "store");
  if (decision.action !== "store") return;
  assert.equal(decision.snapshot.textSource, "ax");
  assert.match(decision.snapshot.text, /Order total/);
  assert.match(decision.snapshot.text, /\[REDACTED\]/, "payment card redacted before storage");
  assert.doesNotMatch(decision.snapshot.text, /4242 4242/);
  assert.equal(decision.snapshot.contentHash.length, 64);
  assert.equal(decision.snapshot.simhash.length, 16);
});

test("secure-field text never reaches the stored snapshot", () => {
  const ax: AxNode = {
    role: "AXWindow",
    children: [
      { role: "AXStaticText", value: "Password" },
      { role: "AXSecureTextField", value: "hunter2-secret" },
    ],
  };
  const decision = proc().process({ capturedAtUtc: at("00"), app: "Login", windowTitle: "Sign in", ax });
  assert.equal(decision.action, "store");
  if (decision.action !== "store") return;
  assert.doesNotMatch(decision.snapshot.text, /hunter2/);
});

test("dedup: an identical follow-up within TTL is skipped", () => {
  const processor = proc();
  const candidate: CaptureCandidate = { capturedAtUtc: at("00"), app: "Editor", windowTitle: "a.ts", text: "line one" };
  assert.equal(processor.process(candidate).action, "store");
  const skipped = processor.process({ ...candidate, capturedAtUtc: at("05") });
  assert.deepEqual(skipped, { action: "skipped", reason: "dedup" });
});

test("terminal-class window with no AX text routes to OCR; skips when OCR unavailable", () => {
  const empty: AxNode = { role: "AXWindow" };
  const noOcr = proc().process({ capturedAtUtc: at("00"), app: "iTerm2", windowTitle: "zsh", ax: empty });
  assert.deepEqual(noOcr, { action: "skipped", reason: "ocr-unavailable" });

  const ocr: OcrFn = () => "user@host ~ % ls -la";
  const withOcr = proc({}, ocr).process({ capturedAtUtc: at("00"), app: "iTerm2", windowTitle: "zsh", ax: empty });
  assert.equal(withOcr.action, "store");
  if (withOcr.action !== "store") return;
  assert.equal(withOcr.snapshot.textSource, "ocr");
  assert.match(withOcr.snapshot.text, /ls -la/);
});

test("an AX-empty non-terminal window also routes to OCR", () => {
  const ocr: OcrFn = () => "rendered canvas text";
  const decision = proc({}, ocr).process({
    capturedAtUtc: at("00"),
    app: "Figma",
    windowTitle: "Board",
    ax: { role: "AXWindow", children: [{ role: "AXGroup" }] },
  });
  assert.equal(decision.action, "store");
  if (decision.action !== "store") return;
  assert.equal(decision.snapshot.textSource, "ocr");
});

test("isTerminalApp matches defaults and merged config globs", () => {
  assert.equal(isTerminalApp("Alacritty", []), true);
  assert.equal(isTerminalApp("Safari", []), false);
  assert.equal(isTerminalApp("MyTerm", ["MyTerm"]), true);
});

test("contentHash length-prefixes fields so a split can't collide", () => {
  const a = contentHash({ capturedAtUtc: at("00"), app: "ab", windowTitle: "c", browserUrl: null, text: "t", textSource: "ax" });
  const b = contentHash({ capturedAtUtc: at("00"), app: "a", windowTitle: "bc", browserUrl: null, text: "t", textSource: "ax" });
  assert.notEqual(a, b);
});

function daySnap(id: number, app: string, sec: number): DaemonSnapshot {
  return {
    id,
    capturedAtUtc: new Date(Date.parse("2026-07-20T10:00:00.000Z") + sec * 1000).toISOString(),
    app,
    windowTitle: "w",
    browserUrl: null,
    text: "t",
    textSource: "ax",
    contentHash: `h${id}`,
    simhash: "0000000000000000",
    supersededBy: null,
  };
}

test("computeStats attributes capped per-app dwell from snapshot spans", () => {
  const snaps = [daySnap(1, "AppA", 0), daySnap(2, "AppA", 30), daySnap(3, "AppB", 60)];
  const stats = computeStats(snaps, "2026-07-20", "UTC", 300);
  assert.equal(stats.snapshotCount, 3);
  assert.equal(stats.totalSeconds, 60);
  assert.deepEqual(stats.apps, [
    { app: "AppA", seconds: 60, snapshotCount: 2 },
    { app: "AppB", seconds: 0, snapshotCount: 1 },
  ]);
});

test("computeStats caps a long idle gap at maxDwellSeconds", () => {
  const snaps = [daySnap(1, "AppA", 0), daySnap(2, "AppB", 59)];
  // 59s gap, cap 10 → AppA credited 10s only.
  const stats = computeStats(snaps, "2026-07-20", "UTC", 10);
  assert.equal(stats.apps.find((a) => a.app === "AppA")?.seconds, 10);
});
