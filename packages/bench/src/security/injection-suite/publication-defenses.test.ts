import assert from "node:assert/strict";
import test from "node:test";
import { generateFamilyVariants } from "./generator.js";
import {
  buildInjectionSuiteAdapterOptions,
  buildInjectionSuiteBehaviorMessages,
} from "./product-lifecycle.js";
import { planInjectionSuiteRows } from "./runner.js";

test("publication prompt baselines preserve their registered boundaries", () => {
  const recalled = "stored CANARY instruction";
  const current = "current request";

  const structured = buildInjectionSuiteBehaviorMessages(
    "structured-boundary",
    recalled,
    current,
    false,
  );
  assert.equal(structured.length, 3);
  assert.deepEqual(JSON.parse(structured[1]!.content), {
    kind: "untrusted_recalled_memory",
    data: recalled,
  });

  const spotlighting = buildInjectionSuiteBehaviorMessages(
    "spotlighting-marking",
    recalled,
    current,
    false,
  );
  assert.match(spotlighting[1]!.content, /\^stored \^CANARY \^instruction/);

  const isolated = buildInjectionSuiteBehaviorMessages(
    "control-data-isolation",
    recalled,
    current,
    false,
  );
  assert.equal(isolated.length, 2);
  assert.ok(isolated.every((message) => !message.content.includes(recalled)));
});

test("publication arms map to the frozen product modes", () => {
  const input = {
    seeds: 1,
    variantsPerFamily: 1,
    modelProfileId: "model-a",
    outputDir: "/tmp/h5-publication-defense-test",
    executor: "ollama" as const,
    baseUrl: "http://127.0.0.1:11434",
  };
  assert.equal(
    buildInjectionSuiteAdapterOptions("structured-boundary", input)
      .configOverrides?.memoryInjectionDefenseMode,
    "off",
  );
  assert.equal(
    buildInjectionSuiteAdapterOptions("spotlighting-marking", input)
      .configOverrides?.memoryInjectionDefenseMode,
    "off",
  );
  assert.equal(
    buildInjectionSuiteAdapterOptions("source-authenticated-fencing", input)
      .configOverrides?.memoryInjectionDefenseMode,
    "fencing",
  );
  assert.equal(
    buildInjectionSuiteAdapterOptions("control-data-isolation", input)
      .configOverrides?.memoryInjectionDefenseMode,
    "off",
  );
  assert.equal(
    buildInjectionSuiteAdapterOptions("layered-fence-quarantine", input)
      .configOverrides?.memoryInjectionDefenseMode,
    "layered",
  );
});

test("selected publication arms and all adaptive rounds are deterministic", () => {
  const arms = [
    "source-authenticated-fencing",
    "layered-fence-quarantine",
  ] as const;
  const rows = planInjectionSuiteRows({
    seeds: 1,
    variantsPerFamily: 1,
    family: "minja",
    modelProfileId: "model-a",
    stage: "adaptive-r3",
    arms,
  });
  assert.deepEqual(
    rows.map((row) => row.arm),
    arms,
  );

  const hashes = ["adaptive-r1", "adaptive-r2", "adaptive-r3"].map(
    (stage) =>
      generateFamilyVariants(
        "minja",
        1,
        71,
        stage as "adaptive-r1" | "adaptive-r2" | "adaptive-r3",
      )[0]!.payload,
  );
  assert.equal(new Set(hashes).size, 3);
});
