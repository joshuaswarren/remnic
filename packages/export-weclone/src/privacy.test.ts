import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sweepPii } from "./privacy.js";
import type { TrainingExportRecord } from "@remnic/core";

function makeRecord(
  overrides: Partial<TrainingExportRecord> = {},
): TrainingExportRecord {
  return {
    instruction: overrides.instruction ?? "Tell me about yourself",
    input: overrides.input ?? "",
    output: overrides.output ?? "I like hiking.",
    ...overrides,
  };
}

describe("sweepPii", () => {
  it("redacts email addresses", () => {
    const records = [makeRecord({ output: "Contact me at user@example.com for details." })];
    const result = sweepPii(records);

    assert.equal(result.cleanRecords[0].output, "Contact me at [REDACTED] for details.");
    assert.equal(result.redactedCount, 1);
    assert.equal(result.redactionDetails.length, 1);
    assert.equal(result.redactionDetails[0].field, "output");
    assert.equal(result.redactionDetails[0].pattern, "email");
  });

  it("redacts phone numbers (US format)", () => {
    const records = [makeRecord({ output: "Call me at 555-123-4567 anytime." })];
    const result = sweepPii(records);

    assert.equal(result.cleanRecords[0].output, "Call me at [REDACTED] anytime.");
    assert.equal(result.redactedCount, 1);
    assert.equal(result.redactionDetails[0].pattern, "phone");
  });

  it("redacts phone numbers (international format)", () => {
    const records = [makeRecord({ output: "My number is +1-555-123-4567." })];
    const result = sweepPii(records);

    assert.ok(result.cleanRecords[0].output.includes("[REDACTED]"));
    assert.equal(result.redactedCount, 1);
  });

  it("redacts SSN-like patterns", () => {
    const records = [makeRecord({ output: "My SSN is 123-45-6789." })];
    const result = sweepPii(records);

    assert.equal(result.cleanRecords[0].output, "My SSN is [REDACTED].");
    assert.equal(result.redactedCount, 1);
    assert.equal(result.redactionDetails[0].pattern, "ssn");
  });

  it("redacts credit card-like patterns", () => {
    const records = [
      makeRecord({ output: "My card is 4111-1111-1111-1111." }),
    ];
    const result = sweepPii(records);

    assert.ok(result.cleanRecords[0].output.includes("[REDACTED]"));
    assert.equal(result.redactedCount, 1);
    assert.equal(result.redactionDetails[0].pattern, "credit_card");
  });

  it("redacts credit card patterns with spaces", () => {
    const records = [
      makeRecord({ output: "Card: 4111 1111 1111 1111." }),
    ];
    const result = sweepPii(records);

    assert.ok(result.cleanRecords[0].output.includes("[REDACTED]"));
    assert.equal(result.redactedCount, 1);
  });

  it("redacts contiguous credit card numbers that pass Luhn", () => {
    const records = [
      makeRecord({ output: "Card: 4111111111111111." }),
    ];
    const result = sweepPii(records);

    assert.equal(result.cleanRecords[0].output, "Card: [REDACTED].");
    assert.equal(result.redactedCount, 1);
    assert.equal(result.redactionDetails[0].pattern, "credit_card");
  });

  it("redacts card numbers followed by adjacent numeric metadata", () => {
    const records = [
      makeRecord({ output: "Card: 4111 1111 1111 1111 123." }),
    ];
    const result = sweepPii(records);

    assert.equal(result.cleanRecords[0].output, "Card: [REDACTED] 123.");
    assert.equal(result.redactedCount, 1);
    assert.equal(result.redactionDetails[0].pattern, "credit_card");
  });

  it("redacts valid 19-digit card candidates without truncating them", () => {
    const records = [
      makeRecord({ output: "Card: 4000000000000000006." }),
    ];
    const result = sweepPii(records);

    assert.equal(result.cleanRecords[0].output, "Card: [REDACTED].");
    assert.equal(result.redactedCount, 1);
    assert.equal(result.redactionDetails[0].pattern, "credit_card");
  });

  it("does not redact non-card digit runs that fail Luhn", () => {
    const records = [
      makeRecord({ output: "Reference number: 1234567890123456." }),
    ];
    const result = sweepPii(records);

    assert.equal(result.cleanRecords[0].output, "Reference number: 1234567890123456.");
    assert.equal(result.redactedCount, 0);
    assert.equal(result.redactionDetails.length, 0);
  });

  it("redacts IP addresses", () => {
    const records = [makeRecord({ output: "Server is at 192.168.1.100 on port 80." })];
    const result = sweepPii(records);

    assert.equal(
      result.cleanRecords[0].output,
      "Server is at [REDACTED] on port 80.",
    );
    assert.equal(result.redactedCount, 1);
    assert.equal(result.redactionDetails[0].pattern, "ip_address");
  });

  it("passes clean records through unchanged", () => {
    const records = [
      makeRecord({ output: "I enjoy reading books and going for walks." }),
    ];
    const result = sweepPii(records);

    assert.equal(
      result.cleanRecords[0].output,
      "I enjoy reading books and going for walks.",
    );
    assert.equal(result.redactedCount, 0);
    assert.equal(result.redactionDetails.length, 0);
  });

  it("redacts PII in instruction and input fields too", () => {
    const records = [
      makeRecord({
        instruction: "Email user@test.org about this",
        input: "From 10.0.0.1",
        output: "Done.",
      }),
    ];
    const result = sweepPii(records);

    assert.ok(result.cleanRecords[0].instruction.includes("[REDACTED]"));
    assert.ok(result.cleanRecords[0].input.includes("[REDACTED]"));
    assert.equal(result.redactedCount, 1);
    assert.ok(result.redactionDetails.length >= 2);
  });

  it("provides accurate redaction details with record index", () => {
    const records = [
      makeRecord({ output: "Clean text here." }),
      makeRecord({ output: "My email is test@domain.com." }),
    ];
    const result = sweepPii(records);

    assert.equal(result.redactedCount, 1);
    assert.equal(result.redactionDetails[0].index, 1);
    assert.equal(result.redactionDetails[0].field, "output");
  });

  it("records one redaction detail for each repeated match in a field", () => {
    const records = [
      makeRecord({ output: "Email a@example.com and b@example.com." }),
    ];
    const result = sweepPii(records);

    assert.equal(result.cleanRecords[0].output, "Email [REDACTED] and [REDACTED].");
    assert.equal(result.redactedCount, 1);
    assert.equal(
      result.redactionDetails.filter(
        (detail) => detail.field === "output" && detail.pattern === "email",
      ).length,
      2,
    );
  });

  it("handles multiple PII types in a single record", () => {
    const records = [
      makeRecord({
        output: "Email: a@b.com, Phone: 555-111-2222, IP: 10.0.0.5",
      }),
    ];
    const result = sweepPii(records);

    const cleaned = result.cleanRecords[0].output;
    assert.ok(!cleaned.includes("a@b.com"));
    assert.ok(!cleaned.includes("555-111-2222"));
    assert.ok(!cleaned.includes("10.0.0.5"));
    assert.equal(result.redactedCount, 1);
    assert.ok(result.redactionDetails.length >= 3);
  });

  it("handles empty records array", () => {
    const result = sweepPii([]);

    assert.equal(result.cleanRecords.length, 0);
    assert.equal(result.redactedCount, 0);
    assert.equal(result.redactionDetails.length, 0);
  });
});
