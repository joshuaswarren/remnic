import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LOCOMO_DATASET_FILENAMES,
  LONG_MEM_EVAL_DATASET_FILENAMES,
  formatMissingDatasetError,
  loadLoCoMo10,
  loadLongMemEvalS,
} from "./dataset-loader.ts";

async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-bench-loader-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadLongMemEvalS loads the first probed filename that parses", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: 1,
          question_type: "single-session-user",
          question: "Where does the user live?",
          answer: "Paris",
          question_date: "2025-01-01",
          haystack_dates: [],
          haystack_session_ids: [],
          haystack_sessions: [],
          answer_session_ids: [],
        },
      ]),
      "utf8",
    );
    const result = await loadLongMemEvalS({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "dataset");
    assert.equal(result.filename, "longmemeval_oracle.json");
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.question, "Where does the user live?");
    assert.deepEqual(result.errors, []);
  });
});

test("loadLongMemEvalS hashes the exact dataset bytes", async () => {
  await withTempDir(async (dir) => {
    const payload = Buffer.from(
      JSON.stringify([
        {
          question_id: 1,
          question_type: "single-session-user",
          question: "marker",
          answer: "Paris",
          question_date: "2025-01-01",
          haystack_dates: [],
          haystack_session_ids: [],
          haystack_sessions: [],
          answer_session_ids: [],
        },
      ]),
      "utf8",
    );
    const markerOffset = payload.indexOf("marker");
    assert.notEqual(markerOffset, -1);
    payload[markerOffset] = 0xff;
    await writeFile(path.join(dir, "longmemeval_oracle.json"), payload);

    const result = await loadLongMemEvalS({
      mode: "full",
      datasetDir: dir,
    });

    assert.equal(result.source, "dataset");
    assert.equal(
      result.sha256,
      createHash("sha256").update(payload).digest("hex"),
    );
    assert.match(result.items[0]?.question ?? "", /^\uFFFDarker$/u);
  });
});

test("loadLongMemEvalS prefers oracle when alternate cleaned split also exists", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: "oracle",
          question_type: "single-session-user",
          question: "Which source should load?",
          answer: "oracle",
          question_date: "2025-01-01",
          haystack_dates: [],
          haystack_session_ids: [],
          haystack_sessions: [],
          answer_session_ids: [],
        },
      ]),
      "utf8",
    );
    await writeFile(
      path.join(dir, "longmemeval_s_cleaned.json"),
      JSON.stringify([
        {
          question_id: "cleaned",
          question_type: "single-session-user",
          question: "Which source should not load?",
          answer: "cleaned",
          question_date: "2025-01-01",
          haystack_dates: [],
          haystack_session_ids: [],
          haystack_sessions: [],
          answer_session_ids: [],
        },
      ]),
      "utf8",
    );

    const result = await loadLongMemEvalS({
      mode: "full",
      datasetDir: dir,
    });

    assert.equal(result.source, "dataset");
    assert.equal(result.filename, "longmemeval_oracle.json");
    assert.equal(result.items[0]?.question_id, "oracle");
    assert.deepEqual(result.errors, []);
  });
});

test("loadLongMemEvalS falls back from unreadable file to next probed filename", async () => {
  await withTempDir(async (dir) => {
    // longmemeval_oracle.json intentionally has invalid JSON; loader should
    // record the parse error and fall through to the next filename.
    await writeFile(
      path.join(dir, "longmemeval_oracle.json"),
      "{ not valid json",
      "utf8",
    );
    await writeFile(
      path.join(dir, "longmemeval_s_cleaned.json"),
      JSON.stringify([
        {
          question_id: 2,
          question_type: "single-session-user",
          question: "Favorite color?",
          answer: "blue",
          question_date: "2025-01-02",
          haystack_dates: [],
          haystack_session_ids: [],
          haystack_sessions: [],
          answer_session_ids: [],
        },
      ]),
      "utf8",
    );
    const result = await loadLongMemEvalS({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "dataset");
    assert.equal(result.filename, "longmemeval_s_cleaned.json");
    assert.equal(result.items.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, /longmemeval_oracle\.json/);
  });
});

test("loadLongMemEvalS falls back to smoke fixture in quick mode when dataset missing", async () => {
  await withTempDir(async (dir) => {
    const result = await loadLongMemEvalS({
      mode: "quick",
      datasetDir: dir,
    });
    assert.equal(result.source, "smoke");
    assert.ok(result.items.length >= 1);
    // Errors should include ENOENT for every probed filename.
    assert.equal(result.errors.length, LONG_MEM_EVAL_DATASET_FILENAMES.length);
    for (const filename of LONG_MEM_EVAL_DATASET_FILENAMES) {
      assert.ok(
        result.errors.some((entry) => entry.startsWith(filename)),
        `expected probe error for ${filename}`,
      );
    }
  });
});

test("loadLongMemEvalS returns missing in full mode when dataset absent", async () => {
  await withTempDir(async (dir) => {
    const result = await loadLongMemEvalS({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "missing");
    assert.equal(result.items.length, 0);
    assert.equal(result.errors.length, LONG_MEM_EVAL_DATASET_FILENAMES.length);
  });
});

test("loadLongMemEvalS without datasetDir in quick mode returns smoke fixture with no errors", async () => {
  const result = await loadLongMemEvalS({ mode: "quick" });
  assert.equal(result.source, "smoke");
  assert.ok(result.items.length >= 1);
  assert.deepEqual(result.errors, []);
});

test("loadLongMemEvalS honors limit", async () => {
  await withTempDir(async (dir) => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      question_id: index,
      question_type: "single-session-user",
      question: `q${index}`,
      answer: `a${index}`,
      question_date: "2025-01-01",
      haystack_dates: [],
      haystack_session_ids: [],
      haystack_sessions: [],
      answer_session_ids: [],
    }));
    await writeFile(
      path.join(dir, "longmemeval_oracle.json"),
      JSON.stringify(items),
      "utf8",
    );
    const result = await loadLongMemEvalS({
      mode: "full",
      datasetDir: dir,
      limit: 2,
    });
    assert.equal(result.items.length, 2);
  });
});

test("loadLongMemEvalS limit=0 returns zero items (CLAUDE.md rule 27)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: 1,
          question_type: "single-session-user",
          question: "q",
          answer: "a",
          question_date: "2025-01-01",
          haystack_dates: [],
          haystack_session_ids: [],
          haystack_sessions: [],
          answer_session_ids: [],
        },
      ]),
      "utf8",
    );
    const result = await loadLongMemEvalS({
      mode: "full",
      datasetDir: dir,
      limit: 0,
    });
    assert.equal(result.items.length, 0);
  });
});

test("loadLongMemEvalS rejects negative limit", async () => {
  await assert.rejects(
    () => loadLongMemEvalS({ mode: "quick", limit: -1 }),
    /non-negative integer/,
  );
});

test("loadLongMemEvalS rejects non-integer limit", async () => {
  await assert.rejects(
    () => loadLongMemEvalS({ mode: "quick", limit: 1.5 }),
    /non-negative integer/,
  );
});

test("loadLongMemEvalS rejects non-array payload", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "longmemeval_oracle.json"),
      JSON.stringify({ items: [] }),
      "utf8",
    );
    const result = await loadLongMemEvalS({
      mode: "full",
      datasetDir: dir,
    });
    // Parse error recorded, no subsequent files, fall through to missing.
    assert.equal(result.source, "missing");
    assert.ok(result.errors.some((entry) => /must contain an array/.test(entry)));
  });
});

test("loadLongMemEvalS rejects entries missing haystack_sessions array", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: 1,
          question_type: "x",
          question: "q",
          answer: "a",
          question_date: "2025-01-01",
          // haystack_sessions missing — runner would later crash on
          // `item.haystack_sessions.length`.
          haystack_session_ids: [],
          haystack_dates: [],
          answer_session_ids: [],
        },
      ]),
      "utf8",
    );
    const result = await loadLongMemEvalS({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "missing");
    assert.ok(
      result.errors.some((entry) => /haystack_sessions array/.test(entry)),
      `expected haystack_sessions error; got ${JSON.stringify(result.errors)}`,
    );
  });
});

test("loadLongMemEvalS rejects entries missing a scalar answer", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: 1,
          question_type: "x",
          question: "q",
          // no answer
          question_date: "2025-01-01",
          haystack_sessions: [],
          haystack_session_ids: [],
          haystack_dates: [],
          answer_session_ids: [],
        },
      ]),
      "utf8",
    );
    const result = await loadLongMemEvalS({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "missing");
    assert.ok(
      result.errors.some((entry) => /scalar answer field/.test(entry)),
    );
  });
});

test("loadLoCoMo10 default parser rejects entries missing conversation object", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "locomo10.json"),
      JSON.stringify([
        {
          sample_id: "bad-1",
          // conversation missing — runner iterates conversation.session_*
          qa: [],
        },
      ]),
      "utf8",
    );
    const result = await loadLoCoMo10({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "missing");
    assert.ok(
      result.errors.some((entry) => /conversation object field/.test(entry)),
      `expected conversation error; got ${JSON.stringify(result.errors)}`,
    );
  });
});

test("loadLongMemEvalS default parser rejects invalid session turn role", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: 1,
          question_type: "x",
          question: "q",
          answer: "a",
          question_date: "2025-01-01",
          haystack_sessions: [[{ role: "other", content: "hi" }]],
          haystack_session_ids: ["s1"],
          haystack_dates: ["2025-01-01"],
          answer_session_ids: ["s1"],
        },
      ]),
      "utf8",
    );
    const result = await loadLongMemEvalS({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "missing");
    assert.ok(
      result.errors.some((entry) => /role must be "user" or "assistant"/.test(entry)),
    );
  });
});

test("loadLongMemEvalS default parser rejects non-string turn content", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "longmemeval_oracle.json"),
      JSON.stringify([
        {
          question_id: 1,
          question_type: "x",
          question: "q",
          answer: "a",
          question_date: "2025-01-01",
          haystack_sessions: [[{ role: "user", content: 42 }]],
          haystack_session_ids: ["s1"],
          haystack_dates: ["2025-01-01"],
          answer_session_ids: ["s1"],
        },
      ]),
      "utf8",
    );
    const result = await loadLongMemEvalS({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "missing");
    assert.ok(
      result.errors.some((entry) => /content must be a string/.test(entry)),
    );
  });
});

test("loadLoCoMo10 default parser rejects qa entry missing question string", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "locomo10.json"),
      JSON.stringify([
        {
          sample_id: "qa-bad-1",
          conversation: { speaker_a: "A", speaker_b: "B" },
          qa: [{ category: 1, evidence: [] }],
        },
      ]),
      "utf8",
    );
    const result = await loadLoCoMo10({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "missing");
    assert.ok(
      result.errors.some((entry) => /qa\[0\]\.question must be a non-empty string/.test(entry)),
    );
  });
});

test("loadLoCoMo10 default parser rejects qa entry with non-integer category", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "locomo10.json"),
      JSON.stringify([
        {
          sample_id: "qa-bad-2",
          conversation: { speaker_a: "A", speaker_b: "B" },
          qa: [{ question: "q", category: "one", evidence: [] }],
        },
      ]),
      "utf8",
    );
    const result = await loadLoCoMo10({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "missing");
    assert.ok(
      result.errors.some((entry) => /qa\[0\]\.category must be an integer/.test(entry)),
    );
  });
});

test("loadLoCoMo10 default parser rejects entries missing qa array", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "locomo10.json"),
      JSON.stringify([
        {
          sample_id: "bad-2",
          conversation: { speaker_a: "A", speaker_b: "B" },
          // qa missing
        },
      ]),
      "utf8",
    );
    const result = await loadLoCoMo10({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "missing");
    assert.ok(
      result.errors.some((entry) => /qa array/.test(entry)),
    );
  });
});

test("loadLoCoMo10 default parser rejects qa entry with missing answer and adversarial_answer", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "locomo10.json"),
      JSON.stringify([
        {
          sample_id: "qa-missing-answer",
          conversation: { speaker_a: "A", speaker_b: "B" },
          qa: [{ question: "q", category: 1, evidence: [] }],
        },
      ]),
      "utf8",
    );
    const result = await loadLoCoMo10({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "missing");
    assert.ok(
      result.errors.some((entry) =>
        /must include a string or numeric answer/.test(entry),
      ),
      `expected answer error; got ${JSON.stringify(result.errors)}`,
    );
  });
});

test("loadLoCoMo10 default parser rejects qa entry with non-string evidence", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "locomo10.json"),
      JSON.stringify([
        {
          sample_id: "qa-bad-evidence",
          conversation: { speaker_a: "A", speaker_b: "B" },
          qa: [{ question: "q", answer: "a", category: 1, evidence: [1, 2] }],
        },
      ]),
      "utf8",
    );
    const result = await loadLoCoMo10({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "missing");
    assert.ok(
      result.errors.some((entry) =>
        /evidence must be an array of strings/.test(entry),
      ),
      `expected evidence error; got ${JSON.stringify(result.errors)}`,
    );
  });
});

test("loadLoCoMo10 default parser falls back to adversarial_answer when answer missing", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "locomo10.json"),
      JSON.stringify([
        {
          sample_id: "qa-adversarial",
          conversation: { speaker_a: "A", speaker_b: "B" },
          qa: [
            {
              question: "q",
              adversarial_answer: "fallback-answer",
              category: 5,
              evidence: ["D1:1"],
            },
          ],
        },
      ]),
      "utf8",
    );
    const result = await loadLoCoMo10({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "dataset");
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.qa[0]?.answer, "fallback-answer");
  });
});

test("loadLoCoMo10 default parser coerces numeric answer to string", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "locomo10.json"),
      JSON.stringify([
        {
          sample_id: "qa-numeric",
          conversation: { speaker_a: "A", speaker_b: "B" },
          qa: [
            {
              question: "how many",
              answer: 7,
              category: 1,
              evidence: [],
            },
          ],
        },
      ]),
      "utf8",
    );
    const result = await loadLoCoMo10({
      mode: "full",
      datasetDir: dir,
    });
    assert.equal(result.source, "dataset");
    assert.equal(result.items[0]?.qa[0]?.answer, "7");
  });
});

test("loadLoCoMo10 returns smoke fixture when dataset missing in quick mode", async () => {
  const result = await loadLoCoMo10({ mode: "quick" });
  assert.equal(result.source, "smoke");
  assert.ok(result.items.length >= 1);
});

test("loadLoCoMo10 returns missing in full mode when dataset absent", async () => {
  await withTempDir(async (dir) => {
    const result = await loadLoCoMo10({ mode: "full", datasetDir: dir });
    assert.equal(result.source, "missing");
    assert.equal(result.items.length, 0);
  });
});

test("loadLoCoMo10 uses custom parseFile when provided", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "locomo10.json"),
      JSON.stringify([
        {
          sample_id: "custom-1",
          conversation: { speaker_a: "A", speaker_b: "B" },
          qa: [],
        },
      ]),
      "utf8",
    );
    const result = await loadLoCoMo10({
      mode: "full",
      datasetDir: dir,
      parseFile: (raw, filename) => {
        // Custom parser that enforces a stricter invariant.
        const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
        if (parsed.length === 0) {
          throw new Error(`${filename} must have at least one conversation`);
        }
        return parsed as any;
      },
    });
    assert.equal(result.source, "dataset");
    assert.equal(result.items.length, 1);
  });
});

test("formatMissingDatasetError surfaces filenames and fetch-script hint", () => {
  const message = formatMissingDatasetError(
    "longmemeval",
    "/tmp/missing",
    LONG_MEM_EVAL_DATASET_FILENAMES,
    ["longmemeval_oracle.json: ENOENT"],
  );
  assert.match(message, /LongMemEval dataset not found/);
  assert.match(message, /\/tmp\/missing/);
  assert.match(message, /scripts\/bench\/fetch-datasets\.sh/);
  assert.match(message, /longmemeval_oracle\.json/);
  assert.match(message, /ENOENT/);
});

test("formatMissingDatasetError handles undefined datasetDir", () => {
  const message = formatMissingDatasetError(
    "locomo",
    undefined,
    LOCOMO_DATASET_FILENAMES,
    [],
  );
  assert.match(message, /LoCoMo dataset not found/);
  assert.match(message, /<no dataset directory configured>/);
});
