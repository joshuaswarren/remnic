import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTurnFingerprint,
  codexLogicalSessionKey,
  extractCodexThreadId,
  resolveCodexSessionIdentity,
} from "../src/codex-compat.js";
import { parseConfig } from "../src/config.js";

test("resolveCodexSessionIdentity keeps Codex compat opt-in by default", () => {
  const cfg = parseConfig({});
  const identity = resolveCodexSessionIdentity({
    sessionKey: "session-default-opt-in",
    ctx: {
      provider: { id: "codex", name: "codex/gpt-5.4", model: "codex/gpt-5.4" },
      providerThreadId: "thread-default-opt-in",
      messageCount: 17,
    },
    codexCompat: cfg.codexCompat,
  });

  assert.equal(cfg.codexCompat.enabled, false);
  assert.equal(identity.isCodex, false);
  assert.equal(identity.providerThreadId, null);
  assert.equal(identity.logicalSessionKey, "session-default-opt-in");
  assert.equal(identity.messageCount, 17);
});

test("extractCodexThreadId reads direct and nested provider thread ids", () => {
  assert.equal(
    extractCodexThreadId({ providerThreadId: "thread-direct" }),
    "thread-direct",
  );
  assert.equal(
    extractCodexThreadId({ provider: { thread: { id: "thread-nested" } } }),
    "thread-nested",
  );
  assert.equal(extractCodexThreadId({ provider: { id: "codex" } }), null);
});

test("resolveCodexSessionIdentity keeps non-Codex providers on raw session keys", () => {
  const cfg = parseConfig({});
  const identity = resolveCodexSessionIdentity({
    sessionKey: "session-a",
    ctx: {
      provider: { id: "openai", name: "gpt-5.4" },
      providerThreadId: "thread-openai-2",
      modelId: "gpt-5.4",
    },
    codexCompat: cfg.codexCompat,
  });

  assert.equal(identity.isCodex, false);
  assert.equal(identity.providerThreadId, null);
  assert.equal(identity.logicalSessionKey, "session-a");
});

test("resolveCodexSessionIdentity collapses Codex sessions onto provider thread ids", () => {
  const cfg = parseConfig({ codexCompat: { enabled: true } });
  const identity = resolveCodexSessionIdentity({
    sessionKey: "session-b",
    ctx: {
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-42",
      messageCount: 17,
    },
    codexCompat: cfg.codexCompat,
  });

  assert.equal(identity.isCodex, true);
  assert.equal(identity.providerThreadId, "thread-42");
  assert.equal(identity.logicalSessionKey, codexLogicalSessionKey("thread-42"));
  assert.equal(identity.messageCount, 17);
});

test("resolveCodexSessionIdentity prefers explicit Codex event thread over unrelated context thread", () => {
  const cfg = parseConfig({ codexCompat: { enabled: true } });
  const identity = resolveCodexSessionIdentity({
    sessionKey: "raw",
    ctx: {
      providerThreadId: "host-thread",
      provider: { id: "openai", model: "gpt-5.4" },
    },
    event: {
      codexThreadId: "codex-thread",
    },
    codexCompat: cfg.codexCompat,
  });

  assert.equal(identity.isCodex, true);
  assert.equal(identity.providerThreadId, "codex-thread");
  assert.equal(
    identity.logicalSessionKey,
    codexLogicalSessionKey("codex-thread"),
  );
});

test("resolveCodexSessionIdentity does not infer message count from hook message arrays", () => {
  const cfg = parseConfig({ codexCompat: { enabled: true } });
  const identity = resolveCodexSessionIdentity({
    sessionKey: "session-c",
    event: {
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: "Second message" },
      ],
    },
    ctx: {
      provider: { id: "codex", model: "codex/gpt-5.4" },
      providerThreadId: "thread-43",
    },
    codexCompat: cfg.codexCompat,
  });

  assert.equal(identity.messageCount, null);
});

test("buildTurnFingerprint is stable for the same logical turn", () => {
  const left = buildTurnFingerprint({
    role: "assistant",
    content: "Memory saved.",
    logicalSessionKey: codexLogicalSessionKey("thread-9"),
    providerThreadId: "thread-9",
    turnIndex: 1,
  });
  const right = buildTurnFingerprint({
    role: "assistant",
    content: "Memory   saved.\n",
    logicalSessionKey: codexLogicalSessionKey("thread-9"),
    providerThreadId: "thread-9",
    turnIndex: 1,
  });

  assert.equal(left, right);
});

test("buildTurnFingerprint truncates content to the extraction fingerprint budget", () => {
  const earlier = buildTurnFingerprint({
    role: "assistant",
    content: `${"A".repeat(32)}tail-one`,
    logicalSessionKey: codexLogicalSessionKey("thread-9"),
    providerThreadId: "thread-9",
    maxContentChars: 32,
    turnIndex: 1,
  });
  const replayed = buildTurnFingerprint({
    role: "assistant",
    content: `${"A".repeat(32)}tail-two`,
    logicalSessionKey: codexLogicalSessionKey("thread-9"),
    providerThreadId: "thread-9",
    maxContentChars: 32,
    turnIndex: 1,
  });

  assert.equal(earlier, replayed);
});
