import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withTempDir as managedWithTempDir } from "../testing/tmp-dir.js";

import { collectLocalSessionSummaries, compileRedactionRules, runLocalSessionSummaryCliCommand } from "./index.js";

const withTempDir = <T>(fn: (dir: string) => Promise<T>): Promise<T> =>
  managedWithTempDir(fn, "remnic-session-summary-");

test("collectLocalSessionSummaries produces metadata-only drafts without local paths or raw session keys", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "session.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          sessionKey: "local-session-secret",
          role: "user",
          timestamp: "2026-01-02T03:04:05.000Z",
          content:
            "Please inspect /Users/alex/src/private and email alex@example.com about http://internal.example.test",
        }),
        JSON.stringify({
          sessionKey: "local-session-secret",
          role: "assistant",
          timestamp: "2026-01-02T03:04:06.000Z",
          content: "Use API_KEY=super-secret and connect to 192.168.1.10.",
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      source: "generic-jsonl",
      now: new Date("2026-01-02T04:00:00.000Z"),
    });

    assert.equal(report.filesScanned, 1);
    assert.equal(report.filesParsed, 1);
    assert.equal(report.turnsParsed, 2);
    assert.equal(report.sessionsSummarized, 1);
    const draft = report.drafts[0];
    assert.equal(draft.turnCount, 2);
    assert.equal(draft.roles.user, 1);
    assert.equal(draft.roles.assistant, 1);
    assert.equal(draft.metadata.storesRawTranscript, false);
    assert.equal(draft.metadata.storesLocalPaths, false);
    assert.equal(draft.metadata.storesSourceSessionKey, false);
    assert.equal(draft.sourceFileRefs.length, 1);
    assert.match(draft.sourceFileRefs[0].hash, /^[a-f0-9]{24}$/);

    const serialized = JSON.stringify(draft);
    assert.equal(serialized.includes(transcriptPath), false);
    assert.equal(serialized.includes("local-session-secret"), false);
    assert.equal(serialized.includes("/Users/alex"), false);
    assert.equal(serialized.includes("alex@example.com"), false);
    assert.equal(serialized.includes("192.168.1.10"), false);
    assert.equal(serialized.includes("super-secret"), false);
  });
});

test("includeRedactedExcerpts emits sanitized excerpts only", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        session_key: "thread-1",
        sender: "human",
        created_at: "2026-02-03T00:00:00.000Z",
        text: "Read /home/person/work and send results to person@example.com",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });
    const draft = report.drafts[0];
    assert.equal(draft.excerpts?.length, 1);
    assert.equal(draft.excerpts?.[0].text, "Read [REDACTED_PATH] and send results to [REDACTED_EMAIL]");
    assert.deepEqual(draft.redaction.ruleNames, ["absolute-posix-path", "email"]);
  });
});

test("includeRedactedExcerpts forces default redaction when defaults are disabled", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        session_key: "thread-1",
        sender: "human",
        created_at: "2026-02-03T00:00:00.000Z",
        text: "Read /home/person/work and send results to person@example.com",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
      redactionConfig: { disableDefaults: true },
    });
    const draft = report.drafts[0];
    assert.equal(draft.excerpts?.[0].text, "Read [REDACTED_PATH] and send results to [REDACTED_EMAIL]");
    assert.equal(draft.redaction.enabled, true);
    assert.equal(
      report.warnings.some((warning) => warning.code === "session-summaries.default_redaction_forced_for_excerpts"),
      true
    );
  });
});

test("summary includes all normalized role counts", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      [
        JSON.stringify({
          sessionKey: "roles-session",
          role: "system",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: "System instruction.",
        }),
        JSON.stringify({
          sessionKey: "roles-session",
          role: "other",
          timestamp: "2026-02-03T00:00:01.000Z",
          content: "Other event.",
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({ inputDir: dir });

    assert.match(report.drafts[0].summary, /\(0 user, 0 assistant, 0 tool, 1 system, 1 other\)/);
  });
});

test("parsing falls back to later non-empty content fields", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "fallback-session",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "",
        text: "Use this fallback text.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 1);
    assert.equal(report.drafts[0].excerpts?.[0].text, "Use this fallback text.");
  });
});

test("parsing reads top-level parts and input content fields", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      [
        JSON.stringify({
          sessionKey: "parts-session",
          role: "user",
          timestamp: "2026-02-03T00:00:00.000Z",
          parts: [{ text: "Use parts text." }],
        }),
        JSON.stringify({
          sessionKey: "parts-session",
          role: "assistant",
          timestamp: "2026-02-03T00:00:01.000Z",
          input: "Use input text.",
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 2);
    assert.deepEqual(
      report.drafts[0].excerpts?.map((excerpt) => excerpt.text),
      ["Use parts text.", "Use input text."]
    );
  });
});

test("codex-jsonl parses Codex rollout payload rows", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "rollout.jsonl"),
      [
        JSON.stringify({
          type: "event_msg",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:00.000Z",
          payload: { message: "User message from payload." },
        }),
        JSON.stringify({
          type: "response_item",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:01.000Z",
          payload: { content: [{ type: "output_text", text: "Assistant response from payload." }] },
        }),
        JSON.stringify({
          type: "event_msg",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:02.000Z",
          payload: { type: "agent_message", message: "Agent event message from payload." },
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      source: "codex-jsonl",
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 3);
    assert.equal(report.drafts[0].roles.user, 1);
    assert.equal(report.drafts[0].roles.assistant, 2);
    assert.deepEqual(
      report.drafts[0].excerpts?.map((excerpt) => excerpt.text),
      ["User message from payload.", "Assistant response from payload.", "Agent event message from payload."]
    );
  });
});

test("codex-jsonl skips compacted rollout summary rows", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "rollout.jsonl"),
      [
        JSON.stringify({
          type: "event_msg",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:00.000Z",
          payload: { message: "Original user request." },
        }),
        JSON.stringify({
          type: "compacted",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:01.000Z",
          payload: { message: "Synthetic compaction summary should never become an excerpt." },
        }),
        JSON.stringify({
          type: "response_item",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:02.000Z",
          payload: { content: [{ type: "output_text", text: "Assistant response." }] },
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      source: "codex-jsonl",
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 2);
    assert.equal(report.drafts[0].turnCount, 2);
    assert.equal(report.drafts[0].roles.other, 0);
    assert.deepEqual(
      report.drafts[0].excerpts?.map((excerpt) => excerpt.text),
      ["Original user request.", "Assistant response."]
    );
    assert.equal(JSON.stringify(report.drafts[0]).includes("Synthetic compaction summary"), false);
  });
});

test("codex-jsonl deduplicates mirrored agent event and response item rows", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "rollout.jsonl"),
      [
        JSON.stringify({
          type: "event_msg",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:00.000Z",
          payload: { message: "User request." },
        }),
        JSON.stringify({
          type: "event_msg",
          id: "assistant-turn-1",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:01.000Z",
          payload: { type: "agent_message", message: "Mirrored assistant response." },
        }),
        JSON.stringify({
          type: "response_item",
          id: "assistant-turn-1",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:02.000Z",
          payload: { content: [{ type: "output_text", text: "Mirrored assistant response." }] },
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      source: "codex-jsonl",
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 2);
    assert.equal(report.drafts[0].turnCount, 2);
    assert.equal(report.drafts[0].roles.user, 1);
    assert.equal(report.drafts[0].roles.assistant, 1);
    assert.deepEqual(
      report.drafts[0].excerpts?.map((excerpt) => excerpt.text),
      ["User request.", "Mirrored assistant response."]
    );
  });
});

test("codex-jsonl keeps same-text cross-surface rows with different signals", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "rollout.jsonl"),
      [
        JSON.stringify({
          type: "event_msg",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:00.000Z",
          payload: { message: "User request." },
        }),
        JSON.stringify({
          type: "event_msg",
          id: "assistant-event-1",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:01.000Z",
          payload: { type: "agent_message", message: "OK" },
        }),
        JSON.stringify({
          type: "response_item",
          id: "assistant-response-1",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:02.000Z",
          payload: { content: [{ type: "output_text", text: "OK" }] },
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      source: "codex-jsonl",
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 3);
    assert.equal(report.drafts[0].turnCount, 3);
    assert.equal(report.drafts[0].roles.assistant, 2);
    assert.deepEqual(
      report.drafts[0].excerpts?.map((excerpt) => excerpt.text),
      ["User request.", "OK", "OK"]
    );
  });
});

test("codex-jsonl deduplicates same-surface mirrored assistant rows", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "rollout.jsonl"),
      [
        JSON.stringify({
          type: "event_msg",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:00.000Z",
          payload: { message: "User request." },
        }),
        JSON.stringify({
          type: "response_item",
          id: "assistant-1",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:01.000Z",
          payload: { content: [{ type: "output_text", text: "Repeated assistant response." }] },
        }),
        JSON.stringify({
          type: "response_item",
          id: "assistant-1",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:02.000Z",
          payload: { content: [{ type: "output_text", text: "Repeated assistant response." }] },
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      source: "codex-jsonl",
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 2);
    assert.equal(report.drafts[0].turnCount, 2);
    assert.equal(report.drafts[0].roles.assistant, 1);
    assert.deepEqual(
      report.drafts[0].excerpts?.map((excerpt) => excerpt.text),
      ["User request.", "Repeated assistant response."]
    );
  });
});

test("codex-jsonl keeps distinct same-text response item rows with different ids", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "rollout.jsonl"),
      [
        JSON.stringify({
          type: "event_msg",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:00.000Z",
          payload: { message: "User request." },
        }),
        JSON.stringify({
          type: "response_item",
          id: "assistant-1",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:01.000Z",
          payload: { content: [{ type: "output_text", text: "OK" }] },
        }),
        JSON.stringify({
          type: "response_item",
          id: "assistant-2",
          sessionKey: "codex-session",
          timestamp: "2026-02-03T00:00:02.000Z",
          payload: { content: [{ type: "output_text", text: "OK" }] },
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      source: "codex-jsonl",
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 3);
    assert.equal(report.drafts[0].roles.assistant, 2);
    assert.deepEqual(
      report.drafts[0].excerpts?.map((excerpt) => excerpt.text),
      ["User request.", "OK", "OK"]
    );
  });
});

test("codex-jsonl inherits legacy session_meta payload ids", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "rollout.jsonl");
    const writeTranscript = async (message: string): Promise<void> => {
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "session_meta",
            payload: { id: "legacy-codex-session" },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-02-03T00:00:00.000Z",
            payload: { message },
          }),
        ].join("\n"),
        "utf-8"
      );
    };

    await writeTranscript("Original message.");
    const firstReport = await collectLocalSessionSummaries({
      inputDir: dir,
      source: "codex-jsonl",
    });

    await writeTranscript("Changed message.");
    const secondReport = await collectLocalSessionSummaries({
      inputDir: dir,
      source: "codex-jsonl",
    });

    assert.equal(firstReport.drafts[0].sourceSessionRef, secondReport.drafts[0].sourceSessionRef);
    assert.equal(firstReport.drafts[0].draftId, secondReport.drafts[0].draftId);
    assert.equal(firstReport.drafts[0].turnCount, 1);
  });
});

test("payload.message metadata contributes session, role, and timestamp", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "nested.jsonl");
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: "event_msg",
        payload: {
          message: {
            sessionId: "nested-payload-session",
            role: "assistant",
            timestamp: "2026-02-03T00:00:00.000Z",
            content: "Nested assistant content.",
          },
        },
      }),
      "utf-8"
    );
    const firstReport = await collectLocalSessionSummaries({ inputDir: dir });

    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: "event_msg",
        payload: {
          message: {
            sessionId: "nested-payload-session",
            role: "assistant",
            timestamp: "2026-02-03T00:00:00.000Z",
            content: "Changed nested assistant content.",
          },
        },
      }),
      "utf-8"
    );
    const secondReport = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(firstReport.drafts[0].sourceSessionRef, secondReport.drafts[0].sourceSessionRef);
    assert.equal(firstReport.drafts[0].draftId, secondReport.drafts[0].draftId);
    assert.equal(firstReport.drafts[0].roles.assistant, 1);
    assert.equal(firstReport.drafts[0].firstTimestamp, "2026-02-03T00:00:00.000Z");
  });
});

test("top-level message metadata contributes stable session ids", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "nested-message.jsonl");
    await writeFile(
      transcriptPath,
      JSON.stringify({
        message: {
          sessionId: "top-level-message-session",
          role: "assistant",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: "Original nested content.",
        },
      }),
      "utf-8"
    );
    const firstReport = await collectLocalSessionSummaries({ inputDir: dir });

    await writeFile(
      transcriptPath,
      JSON.stringify({
        message: {
          sessionId: "top-level-message-session",
          role: "assistant",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: "Changed nested content.",
        },
      }),
      "utf-8"
    );
    const secondReport = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(firstReport.drafts[0].sourceSessionRef, secondReport.drafts[0].sourceSessionRef);
    assert.equal(firstReport.drafts[0].draftId, secondReport.drafts[0].draftId);
    assert.equal(firstReport.drafts[0].roles.assistant, 1);
  });
});

test("nested transcript id metadata contributes stable session ids", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "nested-transcript.jsonl");
    await writeFile(
      transcriptPath,
      JSON.stringify({
        message: {
          transcriptId: "top-level-message-transcript",
          role: "assistant",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: "Original nested transcript content.",
        },
      }),
      "utf-8"
    );
    const firstReport = await collectLocalSessionSummaries({ inputDir: dir });

    await writeFile(
      transcriptPath,
      JSON.stringify({
        message: {
          transcriptId: "top-level-message-transcript",
          role: "assistant",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: "Changed nested transcript content.",
        },
      }),
      "utf-8"
    );
    const secondReport = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(firstReport.drafts[0].sourceSessionRef, secondReport.drafts[0].sourceSessionRef);
    assert.equal(firstReport.drafts[0].draftId, secondReport.drafts[0].draftId);
    assert.equal(firstReport.drafts[0].roles.assistant, 1);
  });
});

test("claude-jsonl ignores tool_result blocks instead of storing them as user excerpts", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "claude.jsonl"),
      [
        JSON.stringify({
          sessionId: "claude-session",
          message: {
            role: "user",
            content: [{ type: "tool_result", content: "local command output" }],
          },
        }),
        JSON.stringify({
          sessionId: "claude-session",
          message: {
            role: "user",
            content: [{ type: "text", text: "Actual user message." }],
          },
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      source: "claude-jsonl",
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 1);
    assert.equal(report.drafts[0].roles.user, 1);
    assert.deepEqual(
      report.drafts[0].excerpts?.map((excerpt) => excerpt.text),
      ["Actual user message."]
    );
  });
});

test("sessionId fields produce stable session refs across content changes", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "session.jsonl");
    await writeFile(
      transcriptPath,
      JSON.stringify({
        sessionId: "stable-session",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "Original content.",
      }),
      "utf-8"
    );
    const firstReport = await collectLocalSessionSummaries({ inputDir: dir });

    await writeFile(
      transcriptPath,
      JSON.stringify({
        sessionId: "stable-session",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "Changed content.",
      }),
      "utf-8"
    );
    const secondReport = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(firstReport.drafts[0].sourceSessionRef, secondReport.drafts[0].sourceSessionRef);
    assert.equal(firstReport.drafts[0].draftId, secondReport.drafts[0].draftId);
  });
});

test("numeric sessionId fields produce stable session refs", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      [
        JSON.stringify({
          sessionId: 12345,
          role: "user",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: "One",
        }),
        JSON.stringify({
          sessionId: 12345,
          role: "assistant",
          timestamp: "2026-02-03T00:00:01.000Z",
          content: "Two",
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(report.sessionsSummarized, 1);
    assert.equal(report.drafts[0].turnCount, 2);
  });
});

test("JSONL rows inherit the previous stable session id in file order", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      [
        JSON.stringify({
          sessionId: "jsonl-session",
          role: "user",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: "One",
        }),
        JSON.stringify({
          role: "assistant",
          timestamp: "2026-02-03T00:00:01.000Z",
          content: "Two",
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(report.sessionsSummarized, 1);
    assert.equal(report.drafts[0].turnCount, 2);
  });
});

test("JSONL rows inherit stable session id from metadata-only rows", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "session.jsonl");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "metadata-session", created_at: "2026-02-03T00:00:00.000Z" }),
        JSON.stringify({
          role: "user",
          timestamp: "2026-02-03T00:00:01.000Z",
          content: "Original content.",
        }),
      ].join("\n"),
      "utf-8"
    );
    const firstReport = await collectLocalSessionSummaries({ inputDir: dir });

    await writeFile(
      transcriptPath,
      [
        JSON.stringify({ sessionId: "metadata-session", created_at: "2026-02-03T00:00:00.000Z" }),
        JSON.stringify({
          role: "user",
          timestamp: "2026-02-03T00:00:01.000Z",
          content: "Changed content.",
        }),
      ].join("\n"),
      "utf-8"
    );
    const secondReport = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(firstReport.drafts[0].sourceSessionRef, secondReport.drafts[0].sourceSessionRef);
    assert.equal(firstReport.drafts[0].draftId, secondReport.drafts[0].draftId);
  });
});

test("JSON envelope sessionId fields are inherited by child rows", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "session.json");
    await writeFile(
      transcriptPath,
      JSON.stringify({
        sessionId: "stable-envelope-session",
        messages: [
          {
            role: "user",
            timestamp: "2026-02-03T00:00:00.000Z",
            content: "Original content.",
          },
        ],
      }),
      "utf-8"
    );
    const firstReport = await collectLocalSessionSummaries({ inputDir: dir });

    await writeFile(
      transcriptPath,
      JSON.stringify({
        sessionId: "stable-envelope-session",
        messages: [
          {
            role: "user",
            timestamp: "2026-02-03T00:00:00.000Z",
            content: "Changed content.",
          },
        ],
      }),
      "utf-8"
    );
    const secondReport = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(firstReport.drafts[0].sourceSessionRef, secondReport.drafts[0].sourceSessionRef);
    assert.equal(firstReport.drafts[0].draftId, secondReport.drafts[0].draftId);
  });
});

test("JSON envelope sessionId fields override unusable child session ids", async () => {
  await withTempDir(async (dir) => {
    const transcriptPath = path.join(dir, "session.json");
    await writeFile(
      transcriptPath,
      JSON.stringify({
        sessionId: "stable-envelope-session",
        messages: [
          {
            sessionId: "",
            role: "user",
            timestamp: "2026-02-03T00:00:00.000Z",
            content: "Original content.",
          },
          {
            sessionId: null,
            role: "assistant",
            timestamp: "2026-02-03T00:00:01.000Z",
            content: "Original reply.",
          },
        ],
      }),
      "utf-8"
    );
    const firstReport = await collectLocalSessionSummaries({ inputDir: dir });

    await writeFile(
      transcriptPath,
      JSON.stringify({
        sessionId: "stable-envelope-session",
        messages: [
          {
            sessionId: "",
            role: "user",
            timestamp: "2026-02-03T00:00:00.000Z",
            content: "Changed content.",
          },
          {
            sessionId: null,
            role: "assistant",
            timestamp: "2026-02-03T00:00:01.000Z",
            content: "Changed reply.",
          },
        ],
      }),
      "utf-8"
    );
    const secondReport = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(firstReport.sessionsSummarized, 1);
    assert.equal(firstReport.drafts[0].turnCount, 2);
    assert.equal(firstReport.drafts[0].sourceSessionRef, secondReport.drafts[0].sourceSessionRef);
    assert.equal(firstReport.drafts[0].draftId, secondReport.drafts[0].draftId);
  });
});

test("JSON envelope parsing skips empty row arrays in favor of populated arrays", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.json"),
      JSON.stringify({
        sessionId: "envelope-session",
        turns: [],
        messages: [
          {
            role: "user",
            timestamp: "2026-02-03T00:00:00.000Z",
            content: "Message content survives empty turns.",
          },
        ],
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(report.turnsParsed, 1);
    assert.equal(report.drafts[0].sourceSessionRef, "9a04ff52f050d0b4");
    assert.equal(report.drafts[0].excerpts?.[0].text, "Message content survives empty turns.");
  });
});

test("inputDir supports tilde expansion", async () => {
  const dir = await mkdtemp(path.join(os.homedir(), ".remnic-session-summary-"));
  try {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "home-session",
        role: "assistant",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "Home-relative input worked.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: `~/${path.basename(dir)}`,
    });

    assert.equal(report.filesParsed, 1);
    assert.equal(report.sessionsSummarized, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inputDir rejects symlinked roots", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "target");
    const link = path.join(dir, "link");
    await mkdir(target);
    await writeFile(
      path.join(target, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "Should not be scanned through symlink.",
      }),
      "utf-8"
    );
    await symlink(target, link, "dir");

    await assert.rejects(() => collectLocalSessionSummaries({ inputDir: link }), /symbolic link/i);
  });
});

test("inputDir skips nested symlinks while scanning", async () => {
  await withTempDir(async (dir) => {
    const inputDir = path.join(dir, "input");
    const outsideDir = path.join(dir, "outside");
    await mkdir(inputDir);
    await mkdir(outsideDir);
    await writeFile(
      path.join(outsideDir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "outside",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "Should not be read through a nested symlink.",
      }),
      "utf-8"
    );
    await symlink(outsideDir, path.join(inputDir, "linked-outside"), "dir");

    const report = await collectLocalSessionSummaries({ inputDir });

    assert.equal(report.filesScanned, 0);
    assert.equal(report.turnsParsed, 0);
  });
});

test("maxFiles reports truncation instead of dropping files silently", async () => {
  await withTempDir(async (dir) => {
    for (const name of ["a", "b"]) {
      await writeFile(
        path.join(dir, `${name}.jsonl`),
        JSON.stringify({
          sessionKey: name,
          role: "user",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: name,
        }),
        "utf-8"
      );
    }

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      maxFiles: 1,
    });

    assert.equal(report.filesScanned, 1);
    assert.equal(
      report.warnings.some((warning) => warning.code === "session-summaries.max_files_truncated"),
      true
    );
  });
});

test("maxFiles stops walking after enough transcript candidates are found", async () => {
  await withTempDir(async (dir) => {
    for (const name of ["a", "b"]) {
      await writeFile(
        path.join(dir, `${name}.jsonl`),
        JSON.stringify({
          sessionKey: name,
          role: "user",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: name,
        }),
        "utf-8"
      );
    }

    const neverReadDir = path.join(dir, "z-never-read");
    await mkdir(neverReadDir);
    await chmod(neverReadDir, 0o000);
    try {
      const report = await collectLocalSessionSummaries({
        inputDir: dir,
        maxFiles: 1,
      });

      assert.equal(report.filesScanned, 1);
      assert.equal(
        report.warnings.some((warning) => warning.code === "session-summaries.max_files_truncated"),
        true
      );
    } finally {
      await chmod(neverReadDir, 0o700);
    }
  });
});

test("maxFiles uses deterministic sorted file order", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "b.jsonl"),
      JSON.stringify({
        sessionKey: "b",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "B",
      }),
      "utf-8"
    );
    await writeFile(
      path.join(dir, "a.jsonl"),
      JSON.stringify({
        sessionKey: "a",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "A",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
      maxFiles: 1,
    });

    assert.equal(report.drafts[0].sourceSessionRef, "ca978112ca1bbdca");
    assert.equal(report.drafts[0].excerpts?.[0].text, "A");
  });
});

test("maxSessions reports truncation instead of dropping sessions silently", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "sessions.jsonl"),
      [
        JSON.stringify({
          sessionKey: "session-a",
          role: "user",
          timestamp: "2026-02-03T00:00:00.000Z",
          content: "A",
        }),
        JSON.stringify({
          sessionKey: "session-b",
          role: "user",
          timestamp: "2026-02-03T00:01:00.000Z",
          content: "B",
        }),
      ].join("\n"),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      maxSessions: 1,
    });

    assert.equal(report.sessionsSummarized, 1);
    assert.equal(
      report.warnings.some((warning) => warning.code === "session-summaries.max_sessions_truncated"),
      true
    );
  });
});

test("session ordering handles large sessions without spreading timestamp arrays", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "a-small.jsonl"),
      JSON.stringify({
        sessionKey: "small-session",
        role: "user",
        timestamp: "2026-02-03T00:00:00.000Z",
        content: "Small session wins the first slot.",
      }),
      "utf-8"
    );

    const largeTurnCount = 130_000;
    const largeRows = Array.from({ length: largeTurnCount }, () =>
      JSON.stringify({
        sessionKey: "large-session",
        role: "assistant",
        timestamp: "2026-02-04T00:00:00.000Z",
        content: "Large later session.",
      })
    ).join("\n");
    await writeFile(path.join(dir, "b-large.jsonl"), largeRows, "utf-8");

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      maxSessions: 1,
    });

    assert.equal(report.turnsParsed, largeTurnCount + 1);
    assert.equal(report.sessionsSummarized, 1);
    assert.equal(report.drafts[0].turnCount, 1);
    assert.equal(
      report.warnings.some((warning) => warning.code === "session-summaries.max_sessions_truncated"),
      true
    );
  });
});

test("duplicate transcript files are skipped by content hash", async () => {
  await withTempDir(async (dir) => {
    const content = JSON.stringify({
      sessionKey: "duplicate-session",
      role: "user",
      timestamp: "2026-02-03T00:00:00.000Z",
      content: "Count this once.",
    });
    await writeFile(path.join(dir, "a.jsonl"), content, "utf-8");
    await writeFile(path.join(dir, "b.jsonl"), content, "utf-8");

    const report = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(report.filesScanned, 2);
    assert.equal(report.filesParsed, 1);
    assert.equal(report.turnsParsed, 1);
    assert.equal(report.drafts[0].turnCount, 1);
    assert.equal(
      report.warnings.some((warning) => warning.code === "session-summaries.duplicate_file_skipped"),
      true
    );
  });
});

test("runLocalSessionSummaryCliCommand writes opt-in Remnic draft JSONL", async () => {
  await withTempDir(async (dir) => {
    const inputDir = path.join(dir, "transcripts");
    const memoryDir = path.join(dir, "memory");
    await mkdir(inputDir, { recursive: true });
    await writeFile(
      path.join(inputDir, "session.json"),
      JSON.stringify({
        messages: [
          {
            conversation_id: "conversation-1",
            role: "user",
            timestamp: "2026-03-04T05:00:00.000Z",
            content: "Remember project status without raw transcript storage.",
          },
        ],
      }),
      "utf-8"
    );

    const report = await runLocalSessionSummaryCliCommand({
      inputDir,
      memoryDir,
      write: true,
      now: new Date("2026-03-04T06:00:00.000Z"),
    });

    assert.equal(report.wroteFiles.length, 1);
    assert.match(report.wroteFiles[0], /state\/session-summary-drafts\/session-summaries-/);
    const written = await readFile(report.wroteFiles[0], "utf-8");
    assert.equal(written.trim().split("\n").length, 1);
    assert.equal(written.includes("conversation-1"), false);
    assert.equal(written.includes(inputDir), false);
  });
});

test("custom redaction config adds user-defined rules", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: "Internal ticket ABC-123 should be hidden.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
      redactionConfig: {
        rules: [
          {
            name: "ticket",
            pattern: "\\bABC-\\d+\\b",
            replacement: "[REDACTED_TICKET]",
          },
        ],
      },
    });

    assert.equal(report.drafts[0].excerpts?.[0].text, "Internal ticket [REDACTED_TICKET] should be hidden.");
    assert.equal(report.drafts[0].redaction.ruleNames.includes("ticket"), true);
  });
});

test("custom redaction flags remain global", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: "Hide ABC and abc.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
      redactionConfig: {
        rules: [
          {
            name: "letters",
            pattern: "abc",
            flags: "i",
            replacement: "[REDACTED_LETTERS]",
          },
        ],
      },
    });

    assert.equal(report.drafts[0].excerpts?.[0].text, "Hide [REDACTED_LETTERS] and [REDACTED_LETTERS].");
    assert.equal(report.drafts[0].redaction.applied, 2);
  });
});

test("redaction covers quoted secret values with spaces", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: 'Use password="correct horse battery" for the test account.',
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(report.drafts[0].excerpts?.[0].text, "Use [REDACTED_SECRET] for the test account.");
  });
});

test("redaction covers quoted JSON secret keys", async () => {
  await withTempDir(async (dir) => {
    const passwordKey = `${"password"}`;
    const authKey = `${"Authorization"}`;
    const authScheme = `${"Bearer"}`;
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: `Use {"${passwordKey}": "correct horse battery", "${authKey}": "${authScheme} sample-json-value"} before retrying.`,
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      "Use {[REDACTED_SECRET], [REDACTED_SECRET]} before retrying."
    );
  });
});

test("redaction covers prefixed environment secret keys", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: 'Use ANTHROPIC_API_KEY="correct horse" and ACCESS_TOKEN=abc123 before running tests.',
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      "Use [REDACTED_SECRET] and [REDACTED_SECRET] before running tests."
    );
  });
});

test("redaction covers common access and private key assignments", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content:
          'Use AWS_SECRET_ACCESS_KEY=aws-secret, ACCESS_KEY=plain-access, and PRIVATE_KEY="private material" for tests.',
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      "Use [REDACTED_SECRET], [REDACTED_SECRET], and [REDACTED_SECRET] for tests."
    );
  });
});

test("redaction covers bearer Authorization header values", async () => {
  await withTempDir(async (dir) => {
    const authHeader = `${"Authorization"}: ${"Bearer"} sample-bearer-value`;
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: `Run curl -H "${authHeader}" before retrying.`,
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(report.drafts[0].excerpts?.[0].text, 'Run curl -H "[REDACTED_SECRET]" before retrying.');
  });
});

test("redaction covers Basic Authorization header values", async () => {
  await withTempDir(async (dir) => {
    const authHeader = `${"Authorization"}: ${"Basic"} sample-basic-value`;
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: `Run curl -H "${authHeader}" before retrying.`,
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(report.drafts[0].excerpts?.[0].text, 'Run curl -H "[REDACTED_SECRET]" before retrying.');
  });
});

test("custom redaction rules must be an array", async () => {
  assert.throws(
    () => compileRedactionRules({ rules: { name: "bad", pattern: "bad" } } as never),
    /redaction rules must be an array/
  );
});

test("redaction covers common absolute POSIX paths", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content:
          "Inspect /workspace/remnic/secrets, /root/.ssh/config, /home/alex/.env.local, /Users/alex/My Documents/secret.txt, /Users/alex/secret file.txt, /Users/alex/Project (Client)/secret.txt, /secrets, and /tmp/customer-notes.pdf.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      "Inspect [REDACTED_PATH], [REDACTED_PATH], [REDACTED_PATH], [REDACTED_PATH], [REDACTED_PATH], [REDACTED_PATH], [REDACTED_PATH], and [REDACTED_PATH]."
    );
  });
});

test("redaction covers POSIX paths with common non-alphanumeric characters", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content:
          "Inspect /Users/alex/client+secret/file.txt, /Users/alex/team@client/config.json, and /Users/alex/caf\u00e9/notes.md.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      "Inspect [REDACTED_PATH], [REDACTED_PATH], and [REDACTED_PATH]."
    );
  });
});

test("redaction covers home-relative POSIX paths with spaced filenames", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: "Inspect ~/My Documents/secret file.txt before replying.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(report.drafts[0].excerpts?.[0].text, "Inspect [REDACTED_PATH] before replying.");
  });
});

test("redaction covers extensionless POSIX paths with spaced names", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: "Open /Users/alex/Secret Project before replying and ~/My Documents/Client Folder after.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      "Open [REDACTED_PATH] before replying and [REDACTED_PATH] after."
    );
  });
});

test("redaction covers POSIX paths with connector words in spaced names", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content:
          'Open /Users/alex/Research and Development before replying and "/Users/alex/Research and Development" after.',
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      'Open [REDACTED_PATH] before replying and "[REDACTED_PATH]" after.'
    );
  });
});

test("redaction covers single-segment POSIX paths with spaced names", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: "Inspect /Secret Project before replying and /Secret Project.txt after.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      "Inspect [REDACTED_PATH] before replying and [REDACTED_PATH] after."
    );
  });
});

test("redaction covers quoted extensionless POSIX paths with spaced names", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: 'Inspect "/Users/alex/Secret Project" and "~/Client Folder" before replying.',
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      'Inspect "[REDACTED_PATH]" and "[REDACTED_PATH]" before replying.'
    );
  });
});

test("redaction covers UNC Windows paths", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content:
          "Inspect C:\\Users\\alex\\secret file.txt, C:\\Users\\alex\\Secret Project before replying, \\\\server\\share\\client\\secret.txt, and \\\\server\\share\\client\\Secret Project before replying.",
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      "Inspect [REDACTED_PATH], [REDACTED_PATH], [REDACTED_PATH], and [REDACTED_PATH]"
    );
  });
});

test("redaction covers quoted extensionless Windows paths with spaced names", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content:
          'Inspect "C:\\Users\\alex\\Secret Project" and "\\\\server\\share\\client\\Secret Project" before replying.',
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      'Inspect "[REDACTED_PATH]" and "[REDACTED_PATH]" before replying.'
    );
  });
});

test("redaction covers UNC share roots", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: 'Inspect \\\\server\\share and "\\\\server\\quoted-share" before replying.',
      }),
      "utf-8"
    );

    const report = await collectLocalSessionSummaries({
      inputDir: dir,
      includeRedactedExcerpts: true,
    });

    assert.equal(
      report.drafts[0].excerpts?.[0].text,
      'Inspect [REDACTED_PATH] and "[REDACTED_PATH]" before replying.'
    );
  });
});

test("redaction config file must be a JSON object", async () => {
  await withTempDir(async (dir) => {
    const inputDir = path.join(dir, "transcripts");
    const configPath = path.join(dir, "redaction.json");
    await mkdir(inputDir);
    await writeFile(
      path.join(inputDir, "session.jsonl"),
      JSON.stringify({
        sessionKey: "s",
        role: "user",
        timestamp: "2026-04-05T00:00:00.000Z",
        content: "hello",
      }),
      "utf-8"
    );
    await writeFile(configPath, "[]", "utf-8");

    await assert.rejects(
      () =>
        runLocalSessionSummaryCliCommand({
          inputDir,
          redactionConfigPath: configPath,
        }),
      /redaction config must be a JSON object/
    );
  });
});

test("strict mode rejects malformed JSONL", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "bad.jsonl"), "{not json}\n", "utf-8");
    await assert.rejects(
      () => collectLocalSessionSummaries({ inputDir: dir, strict: true }),
      /invalid JSONL line 1 in fileRef [a-f0-9]+/i
    );
  });
});

test("malformed JSON warnings do not include transcript snippets", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "bad.json"), '{"content":"PRIVATE_VALUE_SHOULD_NOT_APPEAR",', "utf-8");

    const report = await collectLocalSessionSummaries({ inputDir: dir });

    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0].message, /invalid generic-jsonl JSON in fileRef [a-f0-9]+; skipping file/i);
    assert.equal(report.warnings[0].message.includes("PRIVATE_VALUE_SHOULD_NOT_APPEAR"), false);
  });
});

test("strict mode rejects malformed JSON with fileRef context", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "bad.json"), "{not json}\n", "utf-8");
    await assert.rejects(
      () => collectLocalSessionSummaries({ inputDir: dir, strict: true }),
      /invalid generic-jsonl JSON in fileRef [a-f0-9]+/i
    );
  });
});
