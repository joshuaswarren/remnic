import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";

const WRITE_TIME = "2030-01-02T03:04:05.000Z";
const STALE_HEADER = "*Last updated: 2024-01-02T03:04:05.000Z*";
const FRESH_HEADER = `*Last updated: ${WRITE_TIME}*`;

async function withMemoryDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-profile-timestamp-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("writeProfile refreshes a stale header at the write time", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      const staleProfile = [
        "# Behavioral Profile",
        "",
        STALE_HEADER,
        "",
        "- Prefers concise status updates.",
        "",
      ].join("\n");

      await storage.writeProfile(staleProfile);

      assert.equal(
        await storage.readProfile(),
        staleProfile.replace(STALE_HEADER, FRESH_HEADER),
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile adds one canonical header when content has none", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);

      await storage.writeProfile("# Behavioral Profile\n\n- Values direct communication.\n");

      assert.equal(
        await storage.readProfile(),
        `# Behavioral Profile\n\n${FRESH_HEADER}\n\n- Values direct communication.\n`,
      );
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("writeProfile removes duplicate stale headers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(WRITE_TIME) });
  try {
    await withMemoryDir(async (dir) => {
      const storage = new StorageManager(dir);
      await storage.writeProfile([
        "# Behavioral Profile",
        "",
        STALE_HEADER,
        "",
        "- Keeps decisions short.",
        "",
        "*Last updated: 2023-01-02T03:04:05.000Z*",
        "",
      ].join("\n"));

      const profile = await storage.readProfile();
      assert.deepEqual(profile.match(/^\*Last updated:.*\*$/gm), [FRESH_HEADER]);
      assert.match(profile, /- Keeps decisions short\./);
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("readProfile does not rewrite a stale header", async () => {
  await withMemoryDir(async (dir) => {
    const storage = new StorageManager(dir);
    const staleProfile = `# Behavioral Profile\n\n${STALE_HEADER}\n\n- Reads are side-effect free.\n`;
    const profilePath = path.join(dir, "profile.md");
    await writeFile(profilePath, staleProfile, "utf8");

    assert.equal(await storage.readProfile(), staleProfile);
    assert.equal(await readFile(profilePath, "utf8"), staleProfile);
  });
});
