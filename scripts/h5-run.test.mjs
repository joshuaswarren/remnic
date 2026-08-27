import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { buildH5SmokeCommand } from "./h5-run.mjs";

function environment(baseUrl, token = {}) {
  return {
    H5_BASE_URL: baseUrl,
    H5_MODEL: "model-a",
    H5_MODEL_PROFILE: "profile-a",
    H5_RUN_DIR: path.join(os.tmpdir(), "h5-run-test"),
    ...token,
  };
}

test("NVIDIA exact host requires NVIDIA_API_KEY", () => {
  const command = buildH5SmokeCommand(
    "smoke",
    environment("https://integrate.api.nvidia.com/v1", { NVIDIA_API_KEY: "secret" }),
  );
  assert.equal(command.tokenName, "NVIDIA_API_KEY");
  assert.deepEqual(command.args.slice(-2), ["--out", command.runDir]);
});

test("Hugging Face exact host requires HF_TOKEN", () => {
  const command = buildH5SmokeCommand(
    "resume",
    environment("https://router.huggingface.co/v1", { HF_TOKEN: "secret" }),
  );
  assert.equal(command.tokenName, "HF_TOKEN");
  assert.deepEqual(command.args.slice(-2), ["--run", command.runDir]);
});

test("custom host cannot reuse a provider key", () => {
  assert.throws(
    () => buildH5SmokeCommand(
      "smoke",
      environment("https://compat.example/v1", { NVIDIA_API_KEY: "wrong" }),
    ),
    /REMNIC_OPENAI_COMPAT_API_KEY/,
  );
});

test("run artifacts cannot be written inside the public checkout", () => {
  assert.throws(
    () => buildH5SmokeCommand("smoke", {
      ...environment("http://127.0.0.1:4400/v1", { REMNIC_OPENAI_COMPAT_API_KEY: "local" }),
      H5_RUN_DIR: path.resolve("results/h5"),
    }),
    /outside the checkout/,
  );
});
