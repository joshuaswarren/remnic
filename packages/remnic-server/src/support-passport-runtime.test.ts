import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { type Orchestrator, parseConfig } from "@remnic/core";

import { createSupportPassportServerRuntime } from "./support-passport-runtime.js";

test("plugin model mode exposes the passport gateway bridge", async () => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-passport-runtime-"));
  try {
    const config = parseConfig({
      memoryDir,
      modelSource: "plugin",
      supportPassport: { enabled: true },
    });
    const runtime = createSupportPassportServerRuntime({ config } as Orchestrator, config);
    try {
      assert.equal(runtime.service.supportPassportGatewayRouteRef?.kind, "gateway");
    } finally {
      runtime.close();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
