import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureOpenClawRegistrationApi,
  disableRegisterMigrationForCaptureTest,
  restoreOpenClawRegistrationGlobals,
  restoreRegisterMigrationForCaptureTest,
  saveAndResetOpenClawRegistrationGlobals,
} from "./helpers/openclaw-registration-harness.js";

const ACCESS_HTTP_KEY = "__openclawEngramAccessHttpServer::openclaw-remnic";

test("the OpenClaw HTTP bridge serves support-passport share links", async () => {
  const savedGlobals = saveAndResetOpenClawRegistrationGlobals();
  const previousMigrationSetting = disableRegisterMigrationForCaptureTest();
  const memoryDir = await mkdtemp(join(tmpdir(), "remnic-support-passport-openclaw-"));
  let stop: (() => Promise<void>) | undefined;

  try {
    const capture = captureOpenClawRegistrationApi({
      pluginConfig: {
        memoryDir,
        qmdEnabled: false,
        searchBackend: "noop",
        supportPassport: { enabled: true },
        agentAccessHttp: {
          enabled: true,
          host: "127.0.0.1",
          port: 0,
          authToken: "owner-token",
        },
      },
    });
    const { default: plugin } = await import("../src/index.js");
    plugin.register(capture.api as never);

    const service = capture.registrations("registerService")[0]?.[0] as
      | { start(): Promise<void>; stop(): Promise<void> }
      | undefined;
    assert.ok(service);
    stop = service.stop;
    await service.start();

    const server = (globalThis as Record<string, unknown>)[ACCESS_HTTP_KEY] as
      | { status(): { host: string; port: number } }
      | undefined;
    assert.ok(server);
    const { host, port } = server.status();
    const response = await fetch(`http://${host}:${port}/engram/v1/support-passport/public/grants/missing-grant`, {
      headers: {
        authorization: `SupportPassport ${"s".repeat(43)}`,
      },
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "The share link was not found.",
      code: "grant_not_found",
    });
  } finally {
    await stop?.();
    await rm(memoryDir, { recursive: true, force: true });
    restoreRegisterMigrationForCaptureTest(previousMigrationSetting);
    restoreOpenClawRegistrationGlobals(savedGlobals);
  }
});
