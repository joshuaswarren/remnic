import assert from "node:assert/strict";
import test from "node:test";

import { resolveVaultNotePath } from "./vault-path.js";

test("resolveVaultNotePath expands date tokens", () => {
  assert.equal(resolveVaultNotePath("{yyyy}-{MM}-{dd}.md", "2026-08-18"), "2026-08-18.md");
  assert.equal(
    resolveVaultNotePath("Daily Notes/{yyyy}/{MM}/{yyyy}-{MM}-{dd}.md", "2026-08-18"),
    "Daily Notes/2026/08/2026-08-18.md",
  );
  assert.equal(resolveVaultNotePath("{yy}/{M}/{d}.md", "2026-08-08"), "26/8/8.md");
  assert.equal(
    resolveVaultNotePath("{yyyy}-{MM}-{dd}.md", "2026-08-18", { timezone: "America/Chicago" }),
    "2026-08-18.md",
  );
});

test("resolveVaultNotePath expands ISO week {ww} as zero-padded", () => {
  assert.equal(resolveVaultNotePath("W{ww}.md", "2021-01-01"), "W53.md");
  assert.equal(resolveVaultNotePath("W{ww}.md", "2024-01-01"), "W01.md");
  assert.equal(
    resolveVaultNotePath("{yyyy}/W{ww}/{yyyy}-{MM}-{dd}.md", "2021-01-01"),
    "2021/W53/2021-01-01.md",
  );
});

test("resolveVaultNotePath rejects traversal and absolute templates", () => {
  assert.throws(() => resolveVaultNotePath("../outside/{yyyy}.md", "2026-08-18"), /\.\.|absolute|traversal/i);
  assert.throws(() => resolveVaultNotePath("{yyyy}/../../secret.md", "2026-08-18"), /\.\.|absolute|traversal/i);
  assert.throws(() => resolveVaultNotePath("/abs/{yyyy}.md", "2026-08-18"), /\.\.|absolute|traversal/i);
  assert.throws(() => resolveVaultNotePath("C:/vault/{yyyy}.md", "2026-08-18"), /\.\.|absolute|traversal/i);
});

test("resolveVaultNotePath requires a real YYYY-MM-DD date", () => {
  assert.throws(() => resolveVaultNotePath("{yyyy}.md", "2026-02-30"), /YYYY-MM-DD/);
  assert.throws(() => resolveVaultNotePath("{yyyy}.md", "20260818"), /YYYY-MM-DD/);
});
