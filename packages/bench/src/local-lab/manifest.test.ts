import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import test from "node:test";

import {
  LOCAL_LAB_PROVIDER_KINDS,
  loadLocalLabManifest,
  parseLocalLabManifest,
  type LocalLabManifest,
} from "./manifest.ts";

function validManifest(): LocalLabManifest {
  return {
    profile: "local-lab",
    responder: {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "qwen3:14b",
      quantization: "Q4_K_M",
      ctx: 16384,
      temperature: 0,
      seed: 1573,
    },
    judge: {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma3:27b",
      ctx: 16384,
      temperature: 0,
      seed: 1573,
    },
    phases: "sequential",
  };
}

test("parseLocalLabManifest accepts a well-formed manifest with optional fields elided", () => {
  const parsed = parseLocalLabManifest(validManifest());
  assert.equal(parsed.profile, "local-lab");
  assert.equal(parsed.phases, "sequential");
  assert.equal(parsed.responder.provider, "openai-compatible");
  assert.equal(parsed.responder.temperature, 0);
  assert.equal(parsed.responder.seed, 1573);
  assert.equal(parsed.judge.provider, "ollama");
  assert.equal(parsed.embedding, undefined);
});

test("parseLocalLabManifest preserves optional quantization + embedding + notes", () => {
  const manifest = validManifest();
  manifest.embedding = {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:8081/v1",
    model: "bge-m3",
    ctx: 8192,
    temperature: 0,
    seed: 1573,
  };
  manifest.notes = {
    responderToJudgeHandoff: "stop responder, then `ollama serve`",
    hardware: { gpu: "RTX 3090" },
  };
  const parsed = parseLocalLabManifest(manifest);
  assert.equal(parsed.embedding?.model, "bge-m3");
  assert.equal(parsed.notes?.responderToJudgeHandoff, "stop responder, then `ollama serve`");
  assert.deepEqual(parsed.notes?.hardware, { gpu: "RTX 3090" });
});

test("parseLocalLabManifest rejects an unknown provider and lists the valid ones (rule 51)", () => {
  const manifest = validManifest();
  // Deliberately invalid kind — must be rejected, never silently coerced.
  manifest.responder.provider = "vllm" as never;
  assert.throws(
    () => parseLocalLabManifest(manifest),
    (err: unknown) => {
      assert.ok(err instanceof Error, "expected an Error");
      const msg = err.message;
      // Rule 51: error must enumerate the valid kinds.
      for (const kind of LOCAL_LAB_PROVIDER_KINDS) {
        assert.ok(msg.includes(kind), `error must list "${kind}"\n-- message was:\n${msg}`);
      }
      assert.ok(/responder\.provider/.test(msg), `error must name the offending field\n-- message was:\n${msg}`);
      assert.ok(/"vllm"/.test(msg), `error must echo the rejected value\n-- message was:\n${msg}`);
      return true;
    },
  );
});

test("parseLocalLabManifest rejects judge provider not in the valid kinds even if responder is fine", () => {
  const manifest = validManifest();
  manifest.judge.provider = "openai" as never;
  assert.throws(
    () => parseLocalLabManifest(manifest),
    /judge\.provider must be one of \[openai-compatible, ollama\]; received "openai"/,
  );
});

test("parseLocalLabManifest rejects non-zero temperature (rule 39: no silent coercion)", () => {
  for (const bad of [0.0, "0", null, undefined, 1, -0.5, Number.NaN]) {
    const manifest = validManifest();
    // The literal `0.0` is `=== 0`, so skip it as a valid case.
    if (bad === 0) continue;
    (manifest.responder as { temperature: unknown }).temperature = bad;
    assert.throws(
      () => parseLocalLabManifest(manifest),
      /responder\.temperature must be the number 0/,
      `expected rejection for temperature=${JSON.stringify(bad)}`,
    );
  }
});

test("parseLocalLabManifest rejects missing seed, non-integer ctx, empty model, empty baseUrl", () => {
  const cases: Array<{ name: string; mutate: (m: LocalLabManifest) => void; pattern: RegExp }> = [
    {
      name: "missing seed",
      mutate: (m) => {
        delete (m.responder as { seed?: number }).seed;
      },
      pattern: /responder\.seed must be an integer; received undefined/,
    },
    {
      name: "non-integer ctx",
      mutate: (m) => {
        m.responder.ctx = 1.5 as never;
      },
      pattern: /responder\.ctx must be a positive integer; received 1\.5/,
    },
    {
      name: "zero ctx",
      mutate: (m) => {
        m.responder.ctx = 0;
      },
      pattern: /responder\.ctx must be a positive integer; received 0/,
    },
    {
      name: "empty model",
      mutate: (m) => {
        m.responder.model = "   ";
      },
      pattern: /responder\.model must be a non-empty string; received "   "/,
    },
    {
      name: "empty baseUrl",
      mutate: (m) => {
        m.judge.baseUrl = "";
      },
      pattern: /judge\.baseUrl must be a non-empty string; received ""/,
    },
  ];
  for (const c of cases) {
    const manifest = validManifest();
    c.mutate(manifest);
    assert.throws(() => parseLocalLabManifest(manifest), c.pattern, c.name);
  }
});

test("parseLocalLabManifest rejects wrong profile discriminator and non-sequential phases", () => {
  const wrongProfile = validManifest() as unknown as { profile: string };
  wrongProfile.profile = "baseline";
  assert.throws(
    () => parseLocalLabManifest(wrongProfile),
    /profile === "local-lab"; received "baseline"/,
  );

  const wrongPhases = validManifest() as unknown as { phases: string };
  wrongPhases.phases = "parallel";
  assert.throws(
    () => parseLocalLabManifest(wrongPhases),
    /phases must be "sequential" in PR2; received "parallel"/,
  );
});

test("parseLocalLabManifest rejects non-object root (rule 18: object-not-null)", () => {
  for (const bad of [null, [], "local-lab", 42, true]) {
    assert.throws(
      () => parseLocalLabManifest(bad),
      /local-lab manifest must be a JSON object/,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test("loadLocalLabManifest read failure reports errno code, not raw error path diagnostics (cursor review: #1573 PR2)", async () => {
  // Node readFile errors embed the absolute path + system diagnostics in
  // error.message. The thrown error must use the stable errno code instead.
  const missingPath = "/tmp/remnic-local-lab-manifest-nonexistent-" + Date.now() + ".json";
  await assert.rejects(
    () => loadLocalLabManifest(missingPath),
    (error: Error) => {
      assert.match(error.message, /could not be read \(ENOENT\)/);
      // The absolute path appears once (as filePath) but must NOT be doubled
      // by a raw Node message like "open '/tmp/...'".
      const occurrences = error.message.split(missingPath).length - 1;
      assert.equal(occurrences, 1, "filePath should appear exactly once, not echoed from raw error");
      return true;
    },
  );
});

test("loadLocalLabManifest invalid JSON reports parse detail without path leakage", async () => {
  const tmpPath = "/tmp/remnic-local-lab-manifest-badjson-" + Date.now() + ".json";
  await writeFile(tmpPath, "{ not valid json }", "utf8");
  try {
    await assert.rejects(
      () => loadLocalLabManifest(tmpPath),
      (error: Error) => {
        assert.match(error.message, /contains invalid JSON/);
        // JSON.parse errors carry position info but not file-system paths,
        // so the detail is safe to surface.
        assert.match(error.message, /position \d+/);
        return true;
      },
    );
  } finally {
    await rm(tmpPath, { force: true });
  }
});
