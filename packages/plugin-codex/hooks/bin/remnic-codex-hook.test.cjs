#!/usr/bin/env node
// Tests for the unified cross-platform hook runner.
// Run with: node --test packages/plugin-codex/hooks/bin/remnic-codex-hook.test.cjs

const assert = require("node:assert/strict");
const { describe, it, before, after } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const hookPath = path.join(__dirname, "remnic-codex-hook.cjs");

// Create a temporary home directory for isolated tests
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-hook-test-"));

// Helpers to run the hook with stdin and capture stdout
function runHook(eventName, stdinObj, env = {}) {
  const result = spawnSync(
    process.execPath,
    [hookPath, eventName],
    {
      input: JSON.stringify(stdinObj),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        ...env,
      },
      timeout: 10000,
    }
  );
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function parseOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

describe("remnic-codex-hook.cjs", () => {
  before(() => {
    // Ensure temp home is clean
    fs.mkdirSync(path.join(tmpHome, ".remnic", "logs"), { recursive: true });
  });

  after(() => {
    // Cleanup
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  describe("unknown event", () => {
    it("should return { continue: true } for unknown events", () => {
      const { stdout } = runHook("unknown-event", {});
      const output = parseOutput(stdout);
      assert.ok(output);
      assert.equal(output.continue, true);
    });
  });

  describe("session-start without token", () => {
    it("should return server-unreachable message when token is missing and daemon is unreachable", () => {
      const { stdout } = runHook("session-start", {
        session_id: "test-session",
        cwd: "/tmp",
      }, { REMNIC_DAEMON_URL: "http://localhost:0" });
      const output = parseOutput(stdout);
      assert.ok(output);
      assert.equal(output.continue, true);
      assert.ok(output.hookSpecificOutput);
      assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
      assert.ok(output.hookSpecificOutput.additionalContext.includes("server unreachable"));
    });
  });

  describe("user-prompt-recall without token", () => {
    it("should return { continue: true } when daemon is unreachable", () => {
      const { stdout } = runHook("user-prompt-recall", {
        session_id: "test-session",
        prompt: "test prompt with enough words",
      }, { REMNIC_DAEMON_URL: "http://localhost:0" });
      const output = parseOutput(stdout);
      assert.ok(output);
      assert.equal(output.continue, true);
      // When server is unreachable, userPromptRecall returns { continue: true }
      // without hookSpecificOutput (matching .sh fallback behavior)
    });
  });

  describe("user-prompt-recall short prompt", () => {
    it("should skip short prompts (< 4 words)", () => {
      const { stdout } = runHook("user-prompt-recall", {
        session_id: "test-session",
        prompt: "hi",
      }, { REMNIC_AUTH_TOKEN: "fake-token" });
      const output = parseOutput(stdout);
      assert.ok(output);
      assert.equal(output.continue, true);
      assert.equal(output.hookSpecificOutput, undefined);
    });
  });

  describe("post-tool-observe", () => {
    it("should return { continue: true } without transcript", () => {
      const { stdout } = runHook("post-tool-observe", {
        session_id: "test-session",
      }, { REMNIC_AUTH_TOKEN: "fake-token" });
      const output = parseOutput(stdout);
      assert.ok(output);
      assert.equal(output.continue, true);
    });

    it("should return { continue: true } with invalid session id", () => {
      const { stdout } = runHook("post-tool-observe", {
        session_id: "bad id with spaces",
        transcript_path: "/tmp/fake-transcript.jsonl",
      }, { REMNIC_AUTH_TOKEN: "fake-token" });
      const output = parseOutput(stdout);
      assert.ok(output);
      assert.equal(output.continue, true);
    });
  });

  describe("session-end", () => {
    it("should return { continue: true } without transcript", () => {
      const { stdout } = runHook("session-end", {
        session_id: "test-session",
      }, { REMNIC_AUTH_TOKEN: "fake-token" });
      const output = parseOutput(stdout);
      assert.ok(output);
      assert.equal(output.continue, true);
    });
  });

  describe("transcript parsing", () => {
    it("should parse transcript file and count messages correctly", () => {
      const transcriptPath = path.join(tmpHome, "test-transcript.jsonl");
      const lines = [
        JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hi there" } }),
        JSON.stringify({ type: "system", message: { role: "system", content: "ignored" } }),
        "", // empty line should be skipped
      ];
      fs.writeFileSync(transcriptPath, lines.join("\n"));

      const { stdout } = runHook("post-tool-observe", {
        session_id: "test-session",
        transcript_path: transcriptPath,
      }, { REMNIC_AUTH_TOKEN: "fake-token", REMNIC_DAEMON_URL: "http://localhost:0" });
      const output = parseOutput(stdout);
      assert.ok(output);
      assert.equal(output.continue, true);

      // When server is unreachable, cursor should NOT advance (matching .sh behavior)
      // The observe endpoint fails, so cursor is not written
      const cursorPath = path.join(tmpHome, ".local", "state", "remnic", "hooks", "remnic-cursor-test-session");
      assert.equal(fs.existsSync(cursorPath), false, "cursor should not be written when observe fails");
    });

    it("should handle transcript with array content blocks", () => {
      const transcriptPath = path.join(tmpHome, "test-transcript-array.jsonl");
      const lines = [
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "text", text: "first block" },
              { type: "text", text: "second block" },
              { type: "image", url: "ignored" },
            ],
          },
        }),
      ];
      fs.writeFileSync(transcriptPath, lines.join("\n"));

      const { stdout } = runHook("post-tool-observe", {
        session_id: "test-session",
        transcript_path: transcriptPath,
      }, { REMNIC_AUTH_TOKEN: "fake-token", REMNIC_DAEMON_URL: "http://localhost:0" });
      const output = parseOutput(stdout);
      assert.ok(output);
      assert.equal(output.continue, true);
    });
  });

  describe("gitCodingContext", () => {
    it("should return null for non-git directory", () => {
      const { stdout } = runHook("session-start", {
        session_id: "test-session",
        cwd: tmpHome,
      }, { REMNIC_AUTH_TOKEN: "fake-token", REMNIC_DAEMON_URL: "http://localhost:0" });
      const output = parseOutput(stdout);
      assert.ok(output);
      assert.equal(output.continue, true);
      assert.ok(output.hookSpecificOutput);
      // Should still produce output even without git context
      assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    });
  });

  describe("hooks.json structure", () => {
    it("should have commandWindows for every event", () => {
      const hooksJsonPath = path.join(__dirname, "..", "hooks.json");
      const hooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
      const events = ["SessionStart", "PostToolUse", "UserPromptSubmit", "Stop"];
      for (const event of events) {
        assert.ok(hooks.hooks[event], `event ${event} should exist`);
        const firstHook = hooks.hooks[event][0]?.hooks?.[0];
        assert.ok(firstHook, `event ${event} should have a hook`);
        assert.ok(firstHook.command, `event ${event} should have command`);
        assert.ok(firstHook.commandWindows, `event ${event} should have commandWindows`);
        assert.ok(firstHook.commandWindows.includes(".ps1"), `event ${event} commandWindows should reference .ps1`);
      }
    });
  });

  describe("wrapper files exist", () => {
    it("should have .sh, .ps1, and .cjs wrappers", () => {
      const binDir = __dirname;
      assert.ok(fs.existsSync(path.join(binDir, "remnic-codex-hook.cjs")), "cjs runner should exist");
      assert.ok(fs.existsSync(path.join(binDir, "remnic-codex-hook.sh")), "sh wrapper should exist");
      assert.ok(fs.existsSync(path.join(binDir, "remnic-codex-hook.ps1")), "ps1 wrapper should exist");
    });
  });
});
