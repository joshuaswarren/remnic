import assert from "node:assert/strict";
import test from "node:test";

import { buildJournalMemoryProvenance } from "./journal-vault-provenance.js";

test("vault source produces the documented tags, attributes, and validAt", () => {
  assert.deepEqual(
    buildJournalMemoryProvenance({ source: "vault", date: "2026-08-01" }),
    {
      tags: ["journal", "journal-day:2026-08-01"],
      structuredAttributes: { journalSource: "vault" },
      validAt: "2026-08-01T00:00:00.000Z",
    },
  );
});

test("memoryDir source differs only in the attribute value", () => {
  const vault = buildJournalMemoryProvenance({ source: "vault", date: "2026-08-01" });
  const memoryDir = buildJournalMemoryProvenance({ source: "memoryDir", date: "2026-08-01" });
  assert.deepEqual(memoryDir.structuredAttributes, { journalSource: "memoryDir" });
  assert.deepEqual(memoryDir.tags, vault.tags);
  assert.equal(memoryDir.validAt, vault.validAt);
});

test("every structured attribute value is a string", () => {
  for (const source of ["memoryDir", "vault"] as const) {
    const { structuredAttributes } = buildJournalMemoryProvenance({
      source,
      date: "2026-08-01",
    });
    for (const [key, value] of Object.entries(structuredAttributes)) {
      assert.equal(typeof value, "string", `${key} must be a string`);
    }
  }
});

test("unknown source throws RangeError naming source", () => {
  for (const source of ["file", "vault ", "Vault", ""]) {
    assert.throws(
      () => buildJournalMemoryProvenance({ source, date: "2026-08-01" }),
      RangeError,
    );
    assert.throws(
      () => buildJournalMemoryProvenance({ source, date: "2026-08-01" }),
      /source/,
    );
  }
});

test("non-string source is rejected, not defaulted", () => {
  assert.throws(
    () =>
      buildJournalMemoryProvenance({
        source: undefined as unknown as string,
        date: "2026-08-01",
      }),
    RangeError,
  );
});

test("malformed date throws RangeError naming date", () => {
  for (const date of [
    "2026-8-1",
    "2026-02-30",
    "2026-13-01",
    "2026-02-29",
    "",
    " 2026-08-01",
    "2026-08-01 ",
    "0026-01-01",
  ]) {
    assert.throws(
      () => buildJournalMemoryProvenance({ source: "vault", date }),
      RangeError,
    );
    assert.throws(
      () => buildJournalMemoryProvenance({ source: "vault", date }),
      /date/,
    );
  }
});

test("non-string date is rejected, not defaulted", () => {
  assert.throws(
    () =>
      buildJournalMemoryProvenance({
        source: "vault",
        date: 20260801 as unknown as string,
      }),
    RangeError,
  );
});

test("real leap day is accepted", () => {
  assert.equal(
    buildJournalMemoryProvenance({ source: "vault", date: "2024-02-29" }).validAt,
    "2024-02-29T00:00:00.000Z",
  );
});

test("tags are exactly two entries in order", () => {
  const { tags } = buildJournalMemoryProvenance({ source: "vault", date: "2026-08-01" });
  assert.equal(tags.length, 2);
  assert.deepEqual(tags, ["journal", "journal-day:2026-08-01"]);
});

test("two calls are deep-equal and share no mutable state", () => {
  const first = buildJournalMemoryProvenance({ source: "vault", date: "2026-08-01" });
  first.tags.push("mutated");
  first.structuredAttributes.journalSource = "mutated";
  first.validAt = "mutated";
  assert.deepEqual(
    buildJournalMemoryProvenance({ source: "vault", date: "2026-08-01" }),
    {
      tags: ["journal", "journal-day:2026-08-01"],
      structuredAttributes: { journalSource: "vault" },
      validAt: "2026-08-01T00:00:00.000Z",
    },
  );
});
