import test from "node:test";
import assert from "node:assert/strict";

import {
  VAULT_JOURNAL_PREREQUISITES,
  checkVaultJournalPrerequisites,
  type VaultJournalPrereqResult,
} from "./journal-vault-prereq.js";

const SATISFIED = {
  vaultEnabled: true,
  dailyNotePath: "/vault/journal/2026-08-20.md",
  journalSection: "Journal",
} as const;

test("all three satisfied returns exactly ok", () => {
  assert.deepEqual(
    checkVaultJournalPrerequisites(SATISFIED),
    { ok: true } satisfies VaultJournalPrereqResult,
  );
});

test("vault.enabled unmet alone", () => {
  const result = checkVaultJournalPrerequisites({
    ...SATISFIED,
    vaultEnabled: false,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["vault.enabled"]);
});

test("vault.dailyNotePath unmet alone", () => {
  const result = checkVaultJournalPrerequisites({
    ...SATISFIED,
    dailyNotePath: undefined,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["vault.dailyNotePath"]);
});

test("vault.readback.journalSection unmet alone", () => {
  const result = checkVaultJournalPrerequisites({
    ...SATISFIED,
    journalSection: "",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["vault.readback.journalSection"]);
});

test("all three unmet lists all three in declaration order", () => {
  const result = checkVaultJournalPrerequisites({
    vaultEnabled: undefined,
    dailyNotePath: undefined,
    journalSection: undefined,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [...VAULT_JOURNAL_PREREQUISITES]);
});

test("string \"true\" does not satisfy vault.enabled", () => {
  const result = checkVaultJournalPrerequisites({
    ...SATISFIED,
    vaultEnabled: "true",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["vault.enabled"]);
});

test("number 1 does not satisfy vault.enabled", () => {
  const result = checkVaultJournalPrerequisites({
    ...SATISFIED,
    vaultEnabled: 1,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["vault.enabled"]);
});

test("whitespace-only dailyNotePath is unmet", () => {
  const result = checkVaultJournalPrerequisites({
    ...SATISFIED,
    dailyNotePath: "   ",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["vault.dailyNotePath"]);
});

test("whitespace-only journalSection is unmet", () => {
  const result = checkVaultJournalPrerequisites({
    ...SATISFIED,
    journalSection: "\t\n",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["vault.readback.journalSection"]);
});

test("message names every missing key and is a single line", () => {
  const result = checkVaultJournalPrerequisites({
    vaultEnabled: "true",
    dailyNotePath: 42,
    journalSection: "  ",
  });
  assert.equal(result.ok, false);
  for (const key of result.missing) {
    assert.ok(result.message.includes(key), `message must name ${key}`);
  }
  for (const key of VAULT_JOURNAL_PREREQUISITES) {
    assert.ok(result.message.includes(key), `message must name ${key}`);
  }
  assert.ok(!result.message.includes("\n"), "message must be a single line");
});

test("input is not mutated", () => {
  const input = Object.freeze({
    vaultEnabled: false,
    dailyNotePath: " ",
    journalSection: "",
  });
  const snapshot = { ...input };
  checkVaultJournalPrerequisites(input);
  assert.deepEqual(input, snapshot);
});
