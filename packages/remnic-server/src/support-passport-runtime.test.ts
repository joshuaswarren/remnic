import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { type Orchestrator, parseConfig } from "@remnic/core";

import { createSupportPassportServerRuntime } from "./support-passport-runtime.js";

test("plugin model mode exposes a fail-closed passport gateway bridge", async () => {
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
      const startedAt = Date.now();
      const result = await runtime.service.supportPassportGatewayRouteRef?.invoke(
        [
          { role: "system", content: "Return JSON." },
          { role: "user", content: "Draft a support card." },
        ],
        {
          temperature: 0,
          maxTokens: 100,
          timeoutMs: 30_000,
          operation: "support-passport-draft",
          jsonSchema: { name: "drafts", schema: { type: "object" } },
        },
      );
      assert.equal(result, null);
      assert.ok(Date.now() - startedAt < 250);
    } finally {
      runtime.close();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
