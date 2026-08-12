import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyOffTheRecord,
  compileOffTheRecordMarkers,
  compileRedactionPatterns,
  redactText,
  REDACTION_PLACEHOLDER,
} from "./redaction.js";
import type { WearableConversation } from "./types.js";

test("redacts SSN-formatted numbers", () => {
  const result = redactText("my social is 123-45-6789 okay", []);
  assert.equal(result.text, `my social is ${REDACTION_PLACEHOLDER} okay`);
  assert.equal(result.redactions, 1);
});

test("redacts payment-card-like digit runs (spaced and contiguous)", () => {
  assert.equal(
    redactText("card 4111 1111 1111 1111 exp soon", []).text,
    `card ${REDACTION_PLACEHOLDER} exp soon`,
  );
  assert.equal(
    redactText("use 4111111111111111 today", []).text,
    `use ${REDACTION_PLACEHOLDER} today`,
  );
});

test("keeps short and ordinary numbers intact", () => {
  const text = "call 555 0125 about the 2026 budget of $1,250";
  const result = redactText(text, []);
  assert.equal(result.text, text);
  assert.equal(result.redactions, 0);
});

test("applies user patterns case-insensitively", () => {
  const patterns = compileRedactionPatterns(["secret project \\w+"]);
  const result = redactText("the Secret Project Falcon update", patterns);
  assert.equal(result.text, `the ${REDACTION_PLACEHOLDER} update`);
});

test("compileRedactionPatterns rejects invalid regexes loudly", () => {
  assert.throws(() => compileRedactionPatterns(["valid", "("]), /redactionPatterns\[1\]/);
  assert.throws(() => compileRedactionPatterns(["  "]), /non-empty/);
});

function conversation(texts: string[]): WearableConversation {
  return {
    id: "c1",
    source: "testsource",
    startIso: "2026-06-10T10:00:00Z",
    segments: texts.map((text, index) => ({
      speakerKey: index % 2 === 0 ? "a" : "b",
      text,
    })),
  };
}

test("off the record drops the span until back on the record", () => {
  const result = applyOffTheRecord(
    conversation([
      "Let me say this off the record for a second.",
      "The merger closes Friday.",
      "Seriously, do not repeat that.",
      "Okay, back on the record now.",
      "Lunch was great.",
    ]),
  );
  const texts = result.conversation.segments.map((segment) => segment.text);
  assert.deepEqual(texts, [
    "[off the record — segment elided]",
    "[back on the record]",
    "Lunch was great.",
  ]);
  assert.equal(result.droppedSegments, 2);
});

test("off the record without a closing marker drops through conversation end", () => {
  const result = applyOffTheRecord(
    conversation(["This is off the record.", "Private thing one.", "Private thing two."]),
  );
  assert.equal(result.conversation.segments.length, 1);
  assert.equal(result.droppedSegments, 2);
});

test("conversations without the marker pass through untouched", () => {
  const input = conversation(["Plain talk.", "More plain talk."]);
  const result = applyOffTheRecord(input);
  assert.deepEqual(
    result.conversation.segments.map((segment) => segment.text),
    ["Plain talk.", "More plain talk."],
  );
  assert.equal(result.droppedSegments, 0);
});

test("built-in markers elide a Japanese off-the-record span", () => {
  const result = applyOffTheRecord(
    conversation([
      "ここからはオフレコでお願いします。",
      "来週の買収は金曜に完了します。",
      "オンレコに戻ります。",
      "昼食はおいしかったです。",
    ]),
  );
  assert.deepEqual(
    result.conversation.segments.map((segment) => segment.text),
    [
      "[off the record — segment elided]",
      "[back on the record]",
      "昼食はおいしかったです。",
    ],
  );
  assert.equal(result.droppedSegments, 1);
});

test("built-in markers elide a Korean span through conversation end", () => {
  const result = applyOffTheRecord(
    conversation(["지금부터 오프더레코드입니다", "비밀 계약 조건입니다"]),
  );
  assert.equal(result.conversation.segments.length, 1);
  assert.equal(result.droppedSegments, 1);
});

test("configured markers extend the built-in phrases", () => {
  const markers = compileOffTheRecordMarkers({
    start: ["poza protokołem"],
    end: ["z powrotem do protokołu"],
  });
  const result = applyOffTheRecord(
    conversation([
      "To jest poza protokołem.",
      "Tajna informacja.",
      "Wracamy z powrotem do protokołu.",
      "Normalna rozmowa.",
    ]),
    markers,
  );
  assert.deepEqual(
    result.conversation.segments.map((segment) => segment.text),
    [
      "[off the record — segment elided]",
      "[back on the record]",
      "Normalna rozmowa.",
    ],
  );
  assert.equal(result.droppedSegments, 1);
  // The built-in English phrase still applies alongside the custom set.
  assert.equal(
    applyOffTheRecord(conversation(["off the record", "secret"]), markers)
      .droppedSegments,
    1,
  );
});

test("useBuiltIns false honors only the configured phrases", () => {
  const markers = compileOffTheRecordMarkers({
    start: ["poza protokołem"],
    useBuiltIns: false,
  });
  const result = applyOffTheRecord(
    conversation(["Let me say this off the record.", "The merger closes Friday."]),
    markers,
  );
  assert.equal(result.droppedSegments, 0);
  assert.equal(result.conversation.segments.length, 2);
  // Non-vacuous: the configured phrase must still start an elision, so
  // this cannot pass by discarding `start` along with the built-ins.
  assert.equal(
    applyOffTheRecord(conversation(["poza protokołem", "secret"]), markers)
      .droppedSegments,
    1,
  );
});

test("a Latin marker phrase never matches inside a longer word", () => {
  const result = applyOffTheRecord(
    conversation(["We discussed hors microphone placement.", "Normal talk."]),
  );
  assert.equal(result.droppedSegments, 0);
  assert.equal(result.conversation.segments.length, 2);
});

test("an Arabic marker does not match inside a longer Arabic word", () => {
  assert.equal(
    applyOffTheRecord(conversation(["لدينا بدون تسجيلات كثيرة", "كلام عادي"]))
      .droppedSegments,
    0,
  );
  assert.equal(
    applyOffTheRecord(conversation(["هذا بدون تسجيل من فضلك", "سر"])).droppedSegments,
    1,
  );
});

test("an Arabic proclitic still reaches the built-in marker", () => {
  // Arabic writes و/ف/ب attached to the next word, so a leading guard
  // would silently disable the marker for ordinary phrasing.
  assert.equal(
    applyOffTheRecord(conversation(["وبدون تسجيل من فضلك", "سر"])).droppedSegments,
    1,
  );
});

test("a decomposed accent is a word character, not a boundary", () => {
  const markers = compileOffTheRecordMarkers({
    start: ["cafe"],
    useBuiltIns: false,
  });
  const decomposed = `cafe\u0301teria is open`;
  assert.equal(applyOffTheRecord(conversation([decomposed, "x"]), markers).droppedSegments, 0);
  assert.equal(applyOffTheRecord(conversation(["cafe is open", "x"]), markers).droppedSegments, 1);
});

test("a decomposed transcript still reaches a composed marker", () => {
  // Some ASR output is canonically decomposed. Without normalizing the
  // probe, `nicht fürs protokoll` would never match and the span would be
  // persisted.
  const decomposed = "nicht fu\u0308rs protokoll, bitte".normalize("NFD");
  const result = applyOffTheRecord(conversation([decomposed, "geheim", "wieder fürs protokoll"]));
  assert.equal(result.droppedSegments, 1);
  assert.equal(result.conversation.segments[0]?.text, "[off the record — segment elided]");
  assert.equal(result.conversation.segments[1]?.text, "[back on the record]");
});

test("a marker never fires at the tail of a longer word", () => {
  // Korean particles attach at the END, so the leading guard is safe there
  // while the trailing edge stays open.
  const korean = compileOffTheRecordMarkers({ start: ["기록"], useBuiltIns: false });
  assert.equal(applyOffTheRecord(conversation(["신기록 입니다", "x"]), korean).droppedSegments, 0);
  assert.equal(applyOffTheRecord(conversation(["기록을 멈춰주세요", "비밀"]), korean).droppedSegments, 1);

  // Arabic admits ONE word-initial proclitic and nothing longer.
  const arabic = compileOffTheRecordMarkers({ start: ["خاص"], useBuiltIns: false });
  assert.equal(applyOffTheRecord(conversation(["أشخاص كثيرون", "x"]), arabic).droppedSegments, 0);
  assert.equal(applyOffTheRecord(conversation(["وخاص جدا", "سر"]), arabic).droppedSegments, 1);
});

test("a Turkish marker matches an uppercase transcript", () => {
  // JS `/iu` folding is locale-independent: it never equates `ı` with `I`.
  const markers = compileOffTheRecordMarkers({ start: ["kayıt dışı"], useBuiltIns: false });
  assert.equal(
    applyOffTheRecord(conversation(["BU KAYIT DIŞI", "gizli bilgi"]), markers).droppedSegments,
    1,
  );
  assert.equal(
    applyOffTheRecord(conversation(["bu kayıt dışı", "gizli bilgi"]), markers).droppedSegments,
    1,
  );
});
