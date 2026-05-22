import assert from "node:assert/strict";
import test from "node:test";

import {
  parseInlineExplicitCaptureNotes,
  validateExplicitCaptureInput,
} from "./explicit-capture.js";

function parseSingleNote(confidenceLine: string): ReturnType<typeof parseInlineExplicitCaptureNotes>[number] {
  const notes = parseInlineExplicitCaptureNotes(`
<memory_note>
content: Inline explicit capture content for testing
category: fact
${confidenceLine}
</memory_note>
`);
  assert.equal(notes.length, 1);
  return notes[0]!;
}

test("inline explicit capture rejects malformed confidence values", () => {
  for (const confidenceLine of ["confidence: abc", "confidence: 0.5x"]) {
    const note = parseSingleNote(confidenceLine);
    assert.throws(
      () => validateExplicitCaptureInput(note),
      /confidence must be a finite number/,
      `${confidenceLine} should be rejected`,
    );
  }
});

test("inline explicit capture preserves valid confidence values", () => {
  const validated = validateExplicitCaptureInput(parseSingleNote("confidence: 0.5"));
  assert.equal(validated.confidence, 0.5);
});

test("inline explicit capture defaults omitted confidence", () => {
  const validated = validateExplicitCaptureInput(parseSingleNote(""));
  assert.equal(validated.confidence, 0.95);
});
