import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTokenStore, saveTokenStore, type PublishContext } from "@remnic/core";

import { PiMemoryExtensionPublisher } from "./publisher.js";

class FailingPiPublisher extends PiMemoryExtensionPublisher {
  async renderInstructions(ctx: PublishContext): Promise<string> {
    await super.renderInstructions(ctx);
    throw new Error("readme write failed");
  }
}

test("Pi publisher restores prior extension files and token when publish fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-pi-publisher-test-"));
  const home = path.join(root, "home");
  const piAgentHome = path.join(root, "pi-agent");
  const extensionRoot = path.join(piAgentHome, "extensions", "remnic");
  const configPath = path.join(extensionRoot, "remnic.config.json");
  const wrapperPath = path.join(extensionRoot, "index.ts");
  const readmePath = path.join(extensionRoot, "README.md");
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(path.join(home, ".remnic"), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ authToken: "old-token", remnicDaemonUrl: "http://old" }, null, 2)}\n`);
  fs.writeFileSync(wrapperPath, "old wrapper\n");
  fs.writeFileSync(readmePath, "old readme\n");

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_AGENT_HOME = piAgentHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousPiAgentHome === undefined) delete process.env.PI_AGENT_HOME;
    else process.env.PI_AGENT_HOME = previousPiAgentHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  saveTokenStore({
    tokens: [{ connector: "pi", token: "new-token", createdAt: "2026-05-10T00:00:00.000Z" }],
  });

  const publisher = new FailingPiPublisher();
  await assert.rejects(
    () => publisher.publish({
      config: { memoryDir: path.join(root, "memory") },
      skillsRoot: path.join(root, "memory", "skills"),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    }),
    /readme write failed/,
  );

  assert.equal(fs.readFileSync(configPath, "utf8"), `${JSON.stringify({ authToken: "old-token", remnicDaemonUrl: "http://old" }, null, 2)}\n`);
  assert.equal(fs.readFileSync(wrapperPath, "utf8"), "old wrapper\n");
  assert.equal(fs.readFileSync(readmePath, "utf8"), "old readme\n");
  const piToken = loadTokenStore().tokens.find((entry) => entry.connector === "pi");
  assert.equal(piToken?.token, "old-token");
});
