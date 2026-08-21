import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureOpenClawRegistrationApi,
  disableRegisterMigrationForCaptureTest,
  restoreOpenClawRegistrationGlobals,
  restoreRegisterMigrationForCaptureTest,
  saveAndResetOpenClawRegistrationGlobals,
} from "./helpers/openclaw-registration-harness.js";

const SERVICE_ID = "openclaw-remnic";
const ORCHESTRATOR_KEY = `__openclawEngramOrchestrator::${SERVICE_ID}`;
const RUNTIME_SECRETS = [
  "sk-runtime-openclaw-secret-893",
  "runtime-bearer-token-893",
  "provider-password-secret-893",
];

async function withPrivacyRegistration(
  fn: (context: {
    capture: ReturnType<typeof captureOpenClawRegistrationApi>;
    orchestrator: Record<string, any>;
    memoryDir: string;
    logs: string[];
  }) => Promise<void> | void,
) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-openclaw-privacy-"));
  const logs: string[] = [];
  const logger = {
    debug: (...args: unknown[]) => logs.push(args.map(formatLogArg).join(" ")),
    info: (...args: unknown[]) => logs.push(args.map(formatLogArg).join(" ")),
    warn: (...args: unknown[]) => logs.push(args.map(formatLogArg).join(" ")),
    error: (...args: unknown[]) => logs.push(args.map(formatLogArg).join(" ")),
  };
  const saved = saveAndResetOpenClawRegistrationGlobals();
  const previousMigration = disableRegisterMigrationForCaptureTest();
  try {
    const { default: plugin } = await import("../src/index.js");
    const capture = captureOpenClawRegistrationApi({
      logger,
      pluginConfig: {
        memoryDir,
        modelSource: "gateway",
        qmdEnabled: false,
        transcriptEnabled: true,
        recallTranscriptsEnabled: true,
        verboseRecallVisibility: true,
        debug: true,
      },
    });

    (plugin as { register(api: unknown): void }).register(capture.api);
    const orchestrator = (globalThis as Record<string, any>)[ORCHESTRATOR_KEY];
    assert.ok(orchestrator, "registration should expose the Remnic orchestrator");

    await fn({ capture, orchestrator, memoryDir, logs });
  } finally {
    restoreRegisterMigrationForCaptureTest(previousMigration);
    restoreOpenClawRegistrationGlobals(saved);
    fs.rmSync(memoryDir, { force: true, recursive: true });
  }
}

test("before_prompt_build does not persist OpenClaw runtime auth metadata", async () => {
  await withPrivacyRegistration(async ({ capture, orchestrator, memoryDir, logs }) => {
    orchestrator.recall = async () => "Remember operational dashboards should stay compact.";

    await registeredHook(capture, "before_prompt_build")(
      {
        prompt: "Please design a compact operational dashboard.",
        apiKey: RUNTIME_SECRETS[0],
        headers: {
          authorization: `Bearer ${RUNTIME_SECRETS[1]}`,
        },
        providerCredentials: {
          password: RUNTIME_SECRETS[2],
        },
      },
      {
        sessionKey: "privacy-before-prompt",
        authorization: `Bearer ${RUNTIME_SECRETS[1]}`,
        provider: {
          apiKey: RUNTIME_SECRETS[0],
        },
      },
    );

    assertNoSecretsInLogs(logs);
    assertNoSecretsInFiles(memoryDir);
  });
});

test("agent_end stores message content but not OpenClaw runtime auth metadata", async () => {
  await withPrivacyRegistration(async ({ capture, memoryDir, logs }) => {
    await registeredHook(capture, "agent_end")(
      {
        success: true,
        apiKey: RUNTIME_SECRETS[0],
        headers: {
          authorization: `Bearer ${RUNTIME_SECRETS[1]}`,
        },
        providerCredentials: {
          password: RUNTIME_SECRETS[2],
        },
        messages: [
          { role: "user", content: "Remember that dashboard layouts should be compact." },
          { role: "assistant", content: "Noted: dashboard layouts should be compact." },
        ],
      },
      {
        sessionKey: "privacy-agent-end",
        authorization: `Bearer ${RUNTIME_SECRETS[1]}`,
        providerCredentials: {
          apiKey: RUNTIME_SECRETS[0],
        },
      },
    );

    const persisted = readAllText(memoryDir);
    assert.match(persisted, /dashboard layouts should be compact/);
    assertNoSecretsInLogs(logs);
    assertNoSecretsInText(persisted);
  });
});

test("llm_output observation logs token metadata without auth payload fields", async () => {
  await withPrivacyRegistration(async ({ capture, memoryDir, logs }) => {
    await registeredHook(capture, "llm_output")(
      {
        model: "gpt-5.4-mini",
        tokenUsage: {
          input: 12,
          output: 34,
        },
        durationMs: 56,
        headers: {
          authorization: `Bearer ${RUNTIME_SECRETS[1]}`,
        },
        providerCredentials: {
          apiKey: RUNTIME_SECRETS[0],
          password: RUNTIME_SECRETS[2],
        },
      },
      { sessionKey: "privacy-llm-output" },
    );

    assert.match(logs.join("\n"), /llm_output: model=gpt-5\.4-mini/);
    assertNoSecretsInLogs(logs);
    assertNoSecretsInFiles(memoryDir);
  });
});

test("privacy policy documents user-authored secret text as conversation content", () => {
  const readme = fs.readFileSync(
    path.join(import.meta.dirname, "..", "packages/plugin-openclaw/README.md"),
    "utf-8",
  );

  assert.match(readme, /runtime metadata such as authorization headers/i);
  assert.match(readme, /User-authored message text is different/i);
});

function registeredHook(
  capture: ReturnType<typeof captureOpenClawRegistrationApi>,
  name: string,
) {
  const handler = capture.hooks(name)[0]?.[1];
  assert.equal(typeof handler, "function", `expected registered hook ${name}`);
  return handler as (
    event: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<unknown>;
}

function assertNoSecretsInLogs(logs: string[]) {
  assertNoSecretsInText(logs.join("\n"));
}

function assertNoSecretsInFiles(root: string) {
  assertNoSecretsInText(readAllText(root));
}

function assertNoSecretsInText(text: string) {
  for (const secret of RUNTIME_SECRETS) {
    assert.equal(
      text.includes(secret),
      false,
      `runtime metadata secret leaked into persisted/logged text: ${secret}`,
    );
  }
}

function formatLogArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function readAllText(root: string): string {
  const chunks: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (!fs.existsSync(current)) continue;
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
      continue;
    }
    if (!stat.isFile() || stat.size > 1_000_000) continue;
    chunks.push(fs.readFileSync(current, "utf-8"));
  }
  return chunks.join("\n");
}
