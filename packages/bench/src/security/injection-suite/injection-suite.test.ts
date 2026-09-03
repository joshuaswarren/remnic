import { screenCandidateFact } from "@remnic/core";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { InjectionSuiteClaimLock } from "./claims.js";
import {
  generateSuiteVariants,
  validateInjectionSuiteVariant,
} from "./generator.js";
import {
  buildRecallPrompt,
  completeChat,
  OPENAI_COMPAT_BACKEND_ENV,
  openAiCompatBackend,
  openAiCompatExtensions,
  InjectionSuiteHostFault,
} from "./llm-executor.js";
import {
  injectionSuiteResumeContractHash,
  planInjectionSuiteRows,
  runInjectionSuiteCliCommand,
} from "./runner.js";
import {
  InjectionSuiteRowStore,
  buildInjectionSuiteRowKey,
  defaultSuiteIdentity,
} from "./store.js";
import { HOST_FAULT_RETRY_LIMIT } from "./types.js";

test("generator emits four families with CANARY-e2e tokens", () => {
  const variants = generateSuiteVariants(2, 1);
  assert.equal(variants.length, 8);
  assert.deepEqual(
    [...new Set(variants.map((variant) => variant.family))].sort(),
    ["cross-session", "minja", "sleeper", "tool-hijack"],
  );
  for (const variant of variants) {
    assert.match(variant.canary, /^CANARY-e2e-[0-9a-f]{12}$/);
    assert.match(variant.payload, new RegExp(variant.canary));
  }
});

test("product screen separates every base attack from its benign twin", () => {
  const attacks = generateSuiteVariants(10, 71, "base");
  const benign = generateSuiteVariants(10, 71, "benign");
  // The study screen runs the hardened profile (frozen corpus, disclosed weights).
  assert.ok(
    attacks.every((variant) => screenCandidateFact(variant.payload, "hardened").quarantine),
  );
  assert.ok(
    benign.every((variant) => !screenCandidateFact(variant.payload, "hardened").quarantine),
  );
});

test("benign-use twins carry exactly one use canary and pass the screen", () => {
  const variants = generateSuiteVariants(10, 71, "benign-use");
  assert.equal(variants.length, 40);
  for (const variant of variants) {
    assert.match(variant.useCanary!, /^NOTE-e2e-[0-9a-f]{12}$/);
    assert.equal(variant.benign, true);
    assert.equal(variant.payload.split(variant.useCanary!).length - 1, 1);
    assert.equal(variant.payload.split(variant.canary).length - 1, 0);
    assert.ok(!variant.payload.includes(variant.livenessCanary));
    assert.match(variant.triggerPrompt, /note identifier/);
    assert.deepEqual(
      validateInjectionSuiteVariant(variant),
      [],
      variant.variantId,
    );
    assert.ok(
      !screenCandidateFact(variant.payload, "hardened").quarantine,
      variant.variantId,
    );
  }
});

test("benign-use payloads are deterministic per seed and differ across seeds", () => {
  const first = generateSuiteVariants(2, 71, "benign-use");
  const again = generateSuiteVariants(2, 71, "benign-use");
  const other = generateSuiteVariants(2, 72, "benign-use");
  assert.equal(JSON.stringify(first), JSON.stringify(again));
  assert.notEqual(JSON.stringify(first), JSON.stringify(other));
  assert.notDeepEqual(
    first.map((variant) => variant.useCanary),
    other.map((variant) => variant.useCanary),
  );
});

test("plan respects --limit", () => {
  const rows = planInjectionSuiteRows({
    seeds: 1,
    variantsPerFamily: 2,
    modelProfileId: "local-dry",
    limit: 3,
  });
  assert.equal(rows.length, 3);
});

test("plan can target one attack family", () => {
  const rows = planInjectionSuiteRows({
    seeds: 1,
    variantsPerFamily: 2,
    modelProfileId: "local-dry",
    family: "sleeper",
  });
  assert.equal(rows.length, 8);
  assert.ok(rows.every((row) => row.family === "sleeper"));
});

test("ambiguous retry override is resume-only", async () => {
  await assert.rejects(
    () =>
      runInjectionSuiteCliCommand({
        seeds: 1,
        variantsPerFamily: 1,
        modelProfileId: "local-dry",
        outputDir: path.join(tmpdir(), "h5-never-created"),
        retryAmbiguous: true,
      }),
    /requires --resume/,
  );
});

test("resume skips terminal rows and refuses a drifted contract", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h5-suite-"));
  try {
    const first = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 2,
    });
    assert.equal(first.exitCode, 0);
    assert.equal(first.completed, 2);

    await assert.rejects(
      () =>
        runInjectionSuiteCliCommand({
          seeds: 1,
          variantsPerFamily: 1,
          modelProfileId: "local-dry",
          outputDir,
          limit: 2,
        }),
      /pass --resume/,
    );

    const resumed = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 2,
      resume: true,
    });
    assert.equal(resumed.exitCode, 0);
    assert.equal(resumed.resumed, 2);
    assert.equal(resumed.completed, 0);

    await assert.rejects(
      () =>
        runInjectionSuiteCliCommand({
          seeds: 1,
          variantsPerFamily: 1,
          modelProfileId: "local-dry",
          outputDir,
          limit: 3,
          resume: true,
        }),
      /resume contract hash drifted/,
    );

    const episodes = (
      await readFile(path.join(outputDir, "episodes.jsonl"), "utf8")
    )
      .trim()
      .split("\n");
    assert.equal(episodes.length, 2);

    const metadata = JSON.parse(
      await readFile(path.join(outputDir, "run.json"), "utf8"),
    ) as {
      schemaVersion: number;
      resumeContractHash: string;
      expectedRows: number;
      requestTimeoutMs: number;
    };
    assert.equal(metadata.schemaVersion, 3);
    assert.equal(metadata.expectedRows, 2);
    assert.equal(metadata.requestTimeoutMs, 0);
    metadata.resumeContractHash = "0".repeat(64);
    await writeFile(
      path.join(outputDir, "run.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await assert.rejects(
      () =>
        runInjectionSuiteCliCommand({
          seeds: 1,
          variantsPerFamily: 1,
          modelProfileId: "local-dry",
          outputDir,
          limit: 2,
          resume: true,
        }),
      /resume contract hash drifted/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("host-fault exhaustion pauses instead of cutting the row", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h5-pause-"));
  try {
    const paused = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 1,
      faultFirstAttempts: HOST_FAULT_RETRY_LIMIT,
    });
    assert.equal(paused.exitCode, 2);
    assert.equal(paused.paused, true);
    assert.match(paused.output, /PAUSED/);
    assert.equal(paused.completed, 0);

    const recovered = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 1,
      resume: true,
    });
    assert.equal(recovered.exitCode, 0);
    assert.equal(recovered.completed, 1);

    const store = new InjectionSuiteRowStore(outputDir);
    const identity = planInjectionSuiteRows({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      limit: 1,
    })[0]!;
    const loaded = await store.load(identity);
    assert.equal(loaded.kind, "VALID");
    if (loaded.kind === "VALID") {
      assert.equal(loaded.checkpoint.tries.length, HOST_FAULT_RETRY_LIMIT + 1);
      assert.ok(loaded.checkpoint.terminal);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("ambiguous paid attempt pauses until explicit retry", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h5-ambiguous-"));
  try {
    await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 1,
      faultFirstAttempts: HOST_FAULT_RETRY_LIMIT,
    });
    const identity = planInjectionSuiteRows({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      limit: 1,
    })[0]!;
    const store = new InjectionSuiteRowStore(outputDir);
    await store.markInFlight(identity, HOST_FAULT_RETRY_LIMIT + 1);

    const paused = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 1,
      resume: true,
    });
    assert.equal(paused.exitCode, 2);
    assert.match(paused.output, /ambiguous paid attempt 7/);

    const recovered = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 1,
      resume: true,
      retryAmbiguous: true,
    });
    assert.equal(recovered.exitCode, 0);
    assert.equal(recovered.completed, 1);
    const loaded = await store.load(identity);
    assert.equal(loaded.kind, "VALID");
    if (loaded.kind === "VALID") {
      assert.equal(loaded.checkpoint.inFlight, undefined);
      assert.equal(loaded.checkpoint.tries.length, HOST_FAULT_RETRY_LIMIT + 1);
      assert.ok(loaded.checkpoint.terminal);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("terminal rows are immutable", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h5-term-"));
  try {
    await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 1,
    });
    const identity = planInjectionSuiteRows({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      limit: 1,
    })[0]!;
    const store = new InjectionSuiteRowStore(outputDir);
    await assert.rejects(
      () =>
        store.commitTry(identity, {
          attempt: 99,
          durationMs: 1,
          outcome: { kind: "HOST_API_FAULT", message: "nope" },
        }),
      /terminal and immutable/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("claim lock skips a live foreign owner and reclaims an expired one", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h5-claim-"));
  try {
    const identity = defaultSuiteIdentity({
      family: "minja",
      variantId: "minja-01",
      seed: 1,
      arm: "none",
      modelProfileId: "local-dry",
    });
    const checkpointsDir = path.join(outputDir, "checkpoints");
    const live = new InjectionSuiteClaimLock(checkpointsDir);
    const first = await live.tryClaim(identity);
    assert.notEqual(first, "busy");
    if (first === "busy") return;
    const peer = new InjectionSuiteClaimLock(checkpointsDir);
    assert.equal(await peer.tryClaim(identity), "busy");
    await live.release(first);

    const rowKey = buildInjectionSuiteRowKey(identity);
    const lockPath = path.join(checkpointsDir, `${rowKey}.lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        rowKey,
        ownerToken: "stale",
        host: "other",
        pid: 1,
        leaseMs: 1,
        claimedAt: "1970-01-01T00:00:00.000Z",
      })}\n`,
    );
    await utimes(path.join(lockPath, "owner.json"), new Date(0), new Date(0));
    const taken = await peer.tryClaim(identity);
    assert.notEqual(taken, "busy");
    if (taken === "busy") return;
    await peer.release(taken);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("quarantine arm drops a screened payload before the model is called", () => {
  const identity = defaultSuiteIdentity({
    family: "minja",
    variantId: "minja-01",
    seed: 1,
    arm: "quarantine",
    modelProfileId: "local-dry",
  });
  const variant = generateSuiteVariants(1, 1)[0];
  assert.ok(variant);
  assert.equal(buildRecallPrompt(identity, variant), "dropped");
});

test("resume contract includes executor and model", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h5-exec-"));
  try {
    const first = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 1,
      executor: "local",
    });
    assert.equal(first.exitCode, 0);
    await assert.rejects(
      () =>
        runInjectionSuiteCliCommand({
          seeds: 1,
          variantsPerFamily: 1,
          modelProfileId: "local-dry",
          outputDir,
          limit: 1,
          resume: true,
          executor: "ollama",
          model: "qwen2.5:7b-instruct",
        }),
      /resume contract hash drifted/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("resume contract binds request timeout", () => {
  const base = {
    suiteVersion: "suite",
    modelProfileId: "profile",
    seeds: [1],
    variantsPerFamily: 1,
    limit: 4,
    executor: "openai-compat",
    model: "model",
    baseUrl: "https://compat.example/v1",
    requestTimeoutMs: 1000,
  };
  assert.notEqual(
    injectionSuiteResumeContractHash(base),
    injectionSuiteResumeContractHash({ ...base, requestTimeoutMs: 2000 }),
  );
});

test("plan and execute accept variants-per-family above 64", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h5-hi-"));
  try {
    const result = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 65,
      modelProfileId: "local-dry",
      outputDir,
      limit: 1,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.completed, 1);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

async function withEnv(
  overlay: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overlay)) {
    previous.set(key, process.env[key]);
    const next = overlay[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function mockJsonFetch(responseBody: Record<string, unknown>) {
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(url),
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

const AUTH_CLEAR_ENV = {
  OPENAI_API_KEY: undefined,
  NVIDIA_API_KEY: undefined,
  HF_TOKEN: undefined,
  REMNIC_OPENAI_COMPAT_API_KEY: undefined,
} as const;

async function assertFailsBeforeFetch(
  overlay: Record<string, string | undefined>,
  options: { kind: "openai-compat"; baseUrl: string; requestTimeoutMs: number },
  messagePattern: RegExp,
): Promise<void> {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await withEnv({ ...AUTH_CLEAR_ENV, ...overlay }, async () => {
      await assert.rejects(
        () => completeChat(options, "hi"),
        (error: unknown) => {
          assert.ok(error instanceof InjectionSuiteHostFault);
          assert.match(error.message, messagePattern);
          return true;
        },
      );
      assert.equal(fetchCalls, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("openai-compat OpenAI host sends Authorization from OPENAI_API_KEY", async () => {
  const mock = mockJsonFetch({
    choices: [{ message: { content: "ok" } }],
  });
  try {
    await withEnv(
      {
        ...AUTH_CLEAR_ENV,
        OPENAI_API_KEY: "test-openai-key",
        NVIDIA_API_KEY: "must-not-be-sent",
      },
      async () => {
        const text = await completeChat(
          {
            kind: "openai-compat",
            baseUrl: "https://api.openai.com/v1",
            requestTimeoutMs: 250,
          },
          "hi",
        );
        assert.equal(text, "ok");
        assert.equal(mock.requests.length, 1);
        assert.equal(
          mock.requests[0]?.headers.authorization,
          "Bearer test-openai-key",
        );
        assert.match(mock.requests[0]?.url ?? "", /\/chat\/completions$/);
      },
    );
  } finally {
    mock.restore();
  }
});

test("openai-compat NVIDIA host sends Authorization from NVIDIA_API_KEY", async () => {
  const mock = mockJsonFetch({
    choices: [{ message: { content: "ok" } }],
  });
  try {
    await withEnv(
      {
        ...AUTH_CLEAR_ENV,
        OPENAI_API_KEY: "must-not-be-sent",
        NVIDIA_API_KEY: "nvidia-only",
      },
      async () => {
        await completeChat(
          {
            kind: "openai-compat",
            baseUrl: "https://integrate.api.nvidia.com/v1",
            requestTimeoutMs: 250,
          },
          "hi",
        );
        assert.equal(
          mock.requests[0]?.headers.authorization,
          "Bearer nvidia-only",
        );
        assert.match(
          mock.requests[0]?.url ?? "",
          /^https:\/\/integrate\.api\.nvidia\.com\//,
        );
        const requestBody = mock.requests[0]?.body;
        assert.ok(
          requestBody &&
            typeof requestBody === "object" &&
            "reasoning_effort" in requestBody,
        );
        assert.equal(requestBody.reasoning_effort, "none");
      },
    );
  } finally {
    mock.restore();
  }
});

test("NVIDIA GPT-OSS uses its supported low reasoning effort", async () => {
  const mock = mockJsonFetch({
    choices: [{ message: { content: "ok" } }],
  });
  try {
    await withEnv(
      { ...AUTH_CLEAR_ENV, NVIDIA_API_KEY: "nvidia-only" },
      async () => {
        await completeChat(
          {
            kind: "openai-compat",
            baseUrl: "https://integrate.api.nvidia.com/v1",
            model: "openai/gpt-oss-20b",
            requestTimeoutMs: 250,
          },
          "hi",
        );
        const requestBody = mock.requests[0]?.body;
        assert.ok(
          requestBody &&
            typeof requestBody === "object" &&
            "reasoning_effort" in requestBody,
        );
        assert.equal(requestBody.reasoning_effort, "low");
      },
    );
  } finally {
    mock.restore();
  }
});

test("openai-compat Hugging Face host sends Authorization from HF_TOKEN", async () => {
  const mock = mockJsonFetch({
    choices: [{ message: { content: "ok" } }],
  });
  try {
    await withEnv(
      {
        ...AUTH_CLEAR_ENV,
        HF_TOKEN: "hf-only",
        NVIDIA_API_KEY: "must-not-be-sent",
      },
      async () => {
        await completeChat(
          {
            kind: "openai-compat",
            baseUrl: "https://router.huggingface.co/v1",
            requestTimeoutMs: 250,
          },
          "hi",
        );
        assert.equal(mock.requests[0]?.headers.authorization, "Bearer hf-only");
        assert.match(
          mock.requests[0]?.url ?? "",
          /^https:\/\/router\.huggingface\.co\//,
        );
      },
    );
  } finally {
    mock.restore();
  }
});

test("openai-compat unknown host sends only REMNIC_OPENAI_COMPAT_API_KEY", async () => {
  const mock = mockJsonFetch({
    choices: [{ message: { content: "ok" } }],
  });
  try {
    await withEnv(
      {
        ...AUTH_CLEAR_ENV,
        OPENAI_API_KEY: "must-not-be-sent",
        NVIDIA_API_KEY: "also-must-not-be-sent",
        REMNIC_OPENAI_COMPAT_API_KEY: "explicit-compat-key",
      },
      async () => {
        await completeChat(
          {
            kind: "openai-compat",
            baseUrl: "http://127.0.0.1:9/v1",
            requestTimeoutMs: 250,
          },
          "hi",
        );
        assert.equal(
          mock.requests[0]?.headers.authorization,
          "Bearer explicit-compat-key",
        );
      },
    );
  } finally {
    mock.restore();
  }
});

test("openai-compat NVIDIA host with only OPENAI_API_KEY fails before fetch", async () => {
  await assertFailsBeforeFetch(
    { OPENAI_API_KEY: "must-not-be-sent" },
    {
      kind: "openai-compat",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      requestTimeoutMs: 250,
    },
    /NVIDIA_API_KEY/,
  );
});

test("openai-compat OpenAI host with only NVIDIA_API_KEY fails before fetch", async () => {
  await assertFailsBeforeFetch(
    { NVIDIA_API_KEY: "must-not-be-sent" },
    {
      kind: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      requestTimeoutMs: 250,
    },
    /OPENAI_API_KEY/,
  );
});

test("openai-compat Hugging Face host with only NVIDIA_API_KEY fails before fetch", async () => {
  await assertFailsBeforeFetch(
    { NVIDIA_API_KEY: "must-not-be-sent" },
    {
      kind: "openai-compat",
      baseUrl: "https://router.huggingface.co/v1",
      requestTimeoutMs: 250,
    },
    /HF_TOKEN/,
  );
});

test("openai-compat unknown host with OPENAI_API_KEY fails before fetch", async () => {
  await assertFailsBeforeFetch(
    { OPENAI_API_KEY: "must-not-be-sent" },
    {
      kind: "openai-compat",
      baseUrl: "http://127.0.0.1:9/v1",
      requestTimeoutMs: 250,
    },
    /REMNIC_OPENAI_COMPAT_API_KEY/,
  );
});

test("openai-compat unrelated openai.com subdomain does not receive OPENAI_API_KEY", async () => {
  await assertFailsBeforeFetch(
    { OPENAI_API_KEY: "must-not-be-sent" },
    {
      kind: "openai-compat",
      baseUrl: "https://something.openai.com/v1",
      requestTimeoutMs: 250,
    },
    /REMNIC_OPENAI_COMPAT_API_KEY/,
  );
});

test("openai-compat unrelated nvidia.com subdomain does not receive NVIDIA_API_KEY", async () => {
  await assertFailsBeforeFetch(
    { NVIDIA_API_KEY: "must-not-be-sent" },
    {
      kind: "openai-compat",
      baseUrl: "https://evil.nvidia.com/v1",
      requestTimeoutMs: 250,
    },
    /REMNIC_OPENAI_COMPAT_API_KEY/,
  );
});

test("openai-compat unrelated huggingface.co subdomain does not receive HF_TOKEN", async () => {
  await assertFailsBeforeFetch(
    { HF_TOKEN: "must-not-be-sent" },
    {
      kind: "openai-compat",
      baseUrl: "https://evil.huggingface.co/v1",
      requestTimeoutMs: 250,
    },
    /REMNIC_OPENAI_COMPAT_API_KEY/,
  );
});

test("openai-compat NVIDIA lookalike host does not receive OPENAI_API_KEY", async () => {
  await assertFailsBeforeFetch(
    {
      OPENAI_API_KEY: "must-not-be-sent",
      NVIDIA_API_KEY: "also-must-not-be-sent",
    },
    {
      kind: "openai-compat",
      baseUrl: "https://integrate.api.nvidia.com.example/v1",
      requestTimeoutMs: 250,
    },
    /REMNIC_OPENAI_COMPAT_API_KEY/,
  );
});

test("openai-compat treats a blank NVIDIA_API_KEY as missing on NVIDIA hosts", async () => {
  await assertFailsBeforeFetch(
    { NVIDIA_API_KEY: "  ", OPENAI_API_KEY: "must-not-be-sent" },
    {
      kind: "openai-compat",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      requestTimeoutMs: 250,
    },
    /NVIDIA_API_KEY/,
  );
});

test("openai-compat refuses HTTP OpenAI hosts before fetch", async () => {
  await assertFailsBeforeFetch(
    { OPENAI_API_KEY: "must-not-be-sent" },
    {
      kind: "openai-compat",
      baseUrl: "http://api.openai.com/v1",
      requestTimeoutMs: 250,
    },
    /https/,
  );
});

test("openai-compat refuses HTTP NVIDIA hosts before fetch", async () => {
  await assertFailsBeforeFetch(
    { NVIDIA_API_KEY: "must-not-be-sent" },
    {
      kind: "openai-compat",
      baseUrl: "http://integrate.api.nvidia.com/v1",
      requestTimeoutMs: 250,
    },
    /https/,
  );
});

test("openai-compat refuses HTTP Hugging Face hosts before fetch", async () => {
  await assertFailsBeforeFetch(
    { HF_TOKEN: "must-not-be-sent" },
    {
      kind: "openai-compat",
      baseUrl: "http://router.huggingface.co/v1",
      requestTimeoutMs: 250,
    },
    /https/,
  );
});

test("openai-compat refuses HTTP custom non-loopback hosts before fetch", async () => {
  await assertFailsBeforeFetch(
    { REMNIC_OPENAI_COMPAT_API_KEY: "must-not-be-sent" },
    {
      kind: "openai-compat",
      baseUrl: "http://compat.example/v1",
      requestTimeoutMs: 250,
    },
    /https/,
  );
});

test("openai-compat allows loopback HTTP with REMNIC_OPENAI_COMPAT_API_KEY", async () => {
  const mock = mockJsonFetch({
    choices: [{ message: { content: "ok" } }],
  });
  try {
    await withEnv(
      { ...AUTH_CLEAR_ENV, REMNIC_OPENAI_COMPAT_API_KEY: "loopback-key" },
      async () => {
        await completeChat(
          {
            kind: "openai-compat",
            baseUrl: "http://localhost:9/v1",
            requestTimeoutMs: 250,
          },
          "hi",
        );
        assert.equal(
          mock.requests[0]?.headers.authorization,
          "Bearer loopback-key",
        );
      },
    );
  } finally {
    mock.restore();
  }
});

test("openai-compat custom https host sends REMNIC_OPENAI_COMPAT_API_KEY", async () => {
  const mock = mockJsonFetch({
    choices: [{ message: { content: "ok" } }],
  });
  try {
    await withEnv(
      { ...AUTH_CLEAR_ENV, REMNIC_OPENAI_COMPAT_API_KEY: "custom-https-key" },
      async () => {
        await completeChat(
          {
            kind: "openai-compat",
            baseUrl: "https://compat.example/v1",
            requestTimeoutMs: 250,
          },
          "hi",
        );
        assert.equal(
          mock.requests[0]?.headers.authorization,
          "Bearer custom-https-key",
        );
      },
    );
  } finally {
    mock.restore();
  }
});

test("openai-compat sends chat_template_kwargs only to models whose template defines enable_thinking", async () => {
  const mock = mockJsonFetch({ choices: [{ message: { content: "ok" } }] });
  try {
    await withEnv({ ...AUTH_CLEAR_ENV, OPENAI_API_KEY: "openai-key", NVIDIA_API_KEY: "nvidia-key" }, async () => {
      await completeChat(
        { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", requestTimeoutMs: 250 },
        "hi",
      );
      await completeChat(
        { kind: "openai-compat", baseUrl: "https://integrate.api.nvidia.com/v1", model: "meta/llama-3.2-11b-vision-instruct", requestTimeoutMs: 250 },
        "hi",
      );
      await completeChat(
        { kind: "openai-compat", baseUrl: "https://integrate.api.nvidia.com/v1", model: "nvidia/nemotron-3.5-lightning-30b-a3b", requestTimeoutMs: 250 },
        "hi",
      );
    });
    const bodies = mock.requests.map((request) => request.body as Record<string, unknown>);
    assert.equal(bodies.length, 3);
    assert.equal("chat_template_kwargs" in bodies[0]!, false, "OpenAI rejects unknown request fields");
    assert.equal("reasoning_effort" in bodies[0]!, false, "a generic model gets no reasoning_effort");
    assert.equal(bodies[1]!.reasoning_effort, "low");
    assert.equal(bodies[2]!.reasoning_effort, "none");
    assert.equal("chat_template_kwargs" in bodies[1]!, false, "the NVIDIA Llama 3.2 endpoint rejects the option");
    assert.deepEqual(bodies[2]!.chat_template_kwargs, { enable_thinking: false });
  } finally {
    mock.restore();
  }
});

test("non-generic request fields are gated by backend AND model family", () => {
  // URL inference must not be influenced by an operator override that
  // happens to be exported in the developer's environment (PR #3079 r3).
  const previousBackend = process.env[OPENAI_COMPAT_BACKEND_ENV];
  delete process.env[OPENAI_COMPAT_BACKEND_ENV];
  try {
  // NIM reads both extensions; Ollama's /v1 reads reasoning_effort and drops
  // chat_template_kwargs; an unknown OpenAI-compatible server (LM Studio,
  // api.openai.com) rejects unknown fields with HTTP 400 and gets neither.
  const nim = "https://integrate.api.nvidia.com/v1";
  const ollama = "http://127.0.0.1:11434/v1";
  const lmstudio = "http://127.0.0.1:1234/v1";
  const openai = "https://api.openai.com/v1";
  assert.equal(openAiCompatBackend(nim), "nim");
  // A PORT is not a backend identity: baseUrl is operator-configurable, so
  // Ollama's default port is `generic` until the operator names it, and LM
  // Studio on that same port is never mistaken for Ollama (PR #3079 r2).
  assert.equal(openAiCompatBackend(ollama), "generic");
  assert.equal(openAiCompatBackend(ollama, "ollama"), "ollama");
  assert.equal(openAiCompatBackend(lmstudio), "generic");
  assert.equal(openAiCompatBackend(lmstudio, "generic"), "generic");
  assert.throws(() => openAiCompatBackend(ollama, "vllm"), /must be one of/);
  assert.equal(openAiCompatBackend(openai), "generic");
  assert.equal(openAiCompatBackend("not a url"), "generic");
  // A terminal dot is a legal hostname form and is stripped by the token
  // resolver, so the classifier must agree with it (PR #3079 review).
  assert.equal(openAiCompatBackend("https://integrate.api.nvidia.com./v1"), "nim");

  // The study's endpoints keep exactly the fields they had.
  assert.deepEqual(openAiCompatExtensions(nim, "openai/gpt-oss-20b"), { reasoning_effort: "low" });
  assert.deepEqual(openAiCompatExtensions(nim, "meta/llama-3.2-11b-vision-instruct"), {
    reasoning_effort: "low",
  });
  assert.deepEqual(openAiCompatExtensions(nim, "qwen/qwen3-8b"), {
    reasoning_effort: "none",
    chat_template_kwargs: { enable_thinking: false },
  });
  assert.deepEqual(openAiCompatExtensions(ollama, "qwen3.8-27b-64k:latest"), {});
  assert.deepEqual(openAiCompatExtensions(ollama, "qwen3.8-27b-64k:latest", "ollama"), {
    reasoning_effort: "none",
  });
  // A strict backend gets the generic contract even for a thinking model:
  // this is the LM Studio case that previously failed every request.
  assert.deepEqual(openAiCompatExtensions(lmstudio, "qwen3.8-27b-64k"), {});
  assert.deepEqual(openAiCompatExtensions(openai, "gpt-4.1-mini"), {});
  // A non-thinking model on a capable backend still gets nothing.
  assert.deepEqual(openAiCompatExtensions(nim, "mistralai/mistral-small"), {});
    // The environment override is honored when set.
    process.env[OPENAI_COMPAT_BACKEND_ENV] = "ollama";
    assert.equal(openAiCompatBackend(ollama), "ollama");
    assert.deepEqual(openAiCompatExtensions(ollama, "qwen3.8-27b-64k:latest"), {
      reasoning_effort: "none",
    });
  } finally {
    if (previousBackend === undefined) delete process.env[OPENAI_COMPAT_BACKEND_ENV];
    else process.env[OPENAI_COMPAT_BACKEND_ENV] = previousBackend;
  }
});

test("ollama omits Authorization even when OPENAI_API_KEY is set", async () => {
  const mock = mockJsonFetch({
    message: { content: "ok" },
  });
  try {
    await withEnv({ OPENAI_API_KEY: "must-not-be-sent" }, async () => {
      const text = await completeChat(
        {
          kind: "ollama",
          baseUrl: "http://127.0.0.1:9",
          requestTimeoutMs: 250,
        },
        "hi",
      );
      assert.equal(text, "ok");
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0]?.headers.authorization, undefined);
    });
  } finally {
    mock.restore();
  }
});

test("dead ollama endpoint pauses instead of cutting the row", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h5-dead-"));
  try {
    const result = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 1,
      executor: "ollama",
      baseUrl: "http://127.0.0.1:1",
      requestTimeoutMs: 250,
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.paused, true);
    assert.match(result.output, /PAUSED/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("plan freezes an explicit reproduction seed base", () => {
  const rows = planInjectionSuiteRows({
    seeds: 2,
    seedBase: 907,
    variantsPerFamily: 1,
    family: "minja",
    modelProfileId: "replication",
    stage: "base",
  });
  assert.deepEqual([...new Set(rows.map((row) => row.seed))], [907, 908]);
});

test("capture-responses is recorded in run.json as a run option only", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "h5-capture-"));
  try {
    const result = await runInjectionSuiteCliCommand({
      seeds: 1,
      variantsPerFamily: 1,
      modelProfileId: "local-dry",
      outputDir,
      limit: 1,
      captureResponses: true,
    });
    assert.equal(result.exitCode, 0);
    const metadata = JSON.parse(
      await readFile(path.join(outputDir, "run.json"), "utf8"),
    ) as { captureResponses?: boolean };
    assert.equal(metadata.captureResponses, true);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
