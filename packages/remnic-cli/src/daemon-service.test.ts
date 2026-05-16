import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  inspectLaunchdPlist,
  readLaunchdProgramArguments,
  resolveServerBinDetails,
} from "./daemon-service.js";

test("resolveServerBinDetails prefers installed @remnic/server bin through ESM resolution", () => {
  const packageEntry = "/opt/homebrew/lib/node_modules/@remnic/server/dist/index.js";
  const packageBin = "/opt/homebrew/lib/node_modules/@remnic/server/dist/bin/remnic-server.js";
  const result = resolveServerBinDetails({
    moduleDir: "/repo/packages/remnic-cli/dist",
    packageResolve: (specifier) => {
      assert.equal(specifier, "@remnic/server");
      return pathToFileURL(packageEntry).href;
    },
    existsSync: (candidate) => candidate === packageBin,
  });

  assert.deepEqual(result, {
    path: packageBin,
    source: "package",
    exists: true,
    loadableByNode: true,
  });
});

test("resolveServerBinDetails falls back to workspace dist before source", () => {
  const moduleDir = "/repo/packages/remnic-cli/dist";
  const workspaceDist = path.resolve(moduleDir, "../../remnic-server/dist/index.js");
  const workspaceSource = path.resolve(moduleDir, "../../remnic-server/src/index.ts");
  const result = resolveServerBinDetails({
    moduleDir,
    packageResolve: () => {
      throw new Error("not installed");
    },
    existsSync: (candidate) => candidate === workspaceDist || candidate === workspaceSource,
  });

  assert.equal(result.path, workspaceDist);
  assert.equal(result.source, "workspace-dist");
  assert.equal(result.exists, true);
  assert.equal(result.loadableByNode, true);
});

test("resolveServerBinDetails reports TypeScript source as not launchd-loadable", () => {
  const moduleDir = "/repo/packages/remnic-cli/src";
  const workspaceSource = path.resolve(moduleDir, "../../remnic-server/src/index.ts");
  const result = resolveServerBinDetails({
    moduleDir,
    packageResolve: () => {
      throw new Error("not installed");
    },
    existsSync: (candidate) => candidate === workspaceSource,
  });

  assert.equal(result.path, workspaceSource);
  assert.equal(result.source, "workspace-source");
  assert.equal(result.exists, true);
  assert.equal(result.loadableByNode, false);
});

test("resolveServerBinDetails falls back to PATH before TypeScript source", () => {
  const moduleDir = "/repo/packages/remnic-cli/dist";
  const pathServer = "/opt/homebrew/bin/remnic-server";
  const workspaceSource = path.resolve(moduleDir, "../../remnic-server/src/index.ts");
  const result = resolveServerBinDetails({
    moduleDir,
    pathEnv: "/opt/homebrew/bin",
    packageResolve: () => {
      throw new Error("not installed");
    },
    findCommandOnPath: (command, pathEnv) => {
      assert.equal(command, "remnic-server");
      assert.equal(pathEnv, "/opt/homebrew/bin");
      return pathServer;
    },
    existsSync: (candidate) => candidate === pathServer || candidate === workspaceSource,
  });

  assert.equal(result.path, pathServer);
  assert.equal(result.source, "path");
  assert.equal(result.exists, true);
  assert.equal(result.loadableByNode, true);
});

test("readLaunchdProgramArguments parses plist string entries", () => {
  const args = readLaunchdProgramArguments(`
    <plist><dict>
      <key>ProgramArguments</key>
      <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/test/Remnic &amp; Server/dist/index.js</string>
      </array>
    </dict></plist>
  `);

  assert.deepEqual(args, [
    "/usr/local/bin/node",
    "/Users/test/Remnic & Server/dist/index.js",
  ]);
});

test("inspectLaunchdPlist fails when installed plist points to missing server binary", () => {
  const plistPath = "/Users/test/Library/LaunchAgents/ai.remnic.daemon.plist";
  const missingServer = "/opt/homebrew/lib/node_modules/@remnic/server/dist/bin/remnic-server.js";
  const result = inspectLaunchdPlist(plistPath, {
    existsSync: (candidate) => candidate === plistPath,
    readFileSync: () => `
      <plist><dict>
        <key>ProgramArguments</key>
        <array>
          <string>/opt/homebrew/bin/node</string>
          <string>${missingServer}</string>
        </array>
      </dict></plist>
    `,
  });

  assert.equal(result.installed, true);
  assert.equal(result.ok, false);
  assert.match(result.detail, /missing/);
  assert.match(result.detail, /@remnic\/server/);
  assert.match(result.remediation ?? "", /remnic daemon install/);
});

test("inspectLaunchdPlist rejects an existing package import entry that does not run the CLI", () => {
  const plistPath = "/Users/test/Library/LaunchAgents/ai.remnic.daemon.plist";
  const server = "/opt/homebrew/lib/node_modules/@remnic/server/dist/index.js";
  const result = inspectLaunchdPlist(plistPath, {
    existsSync: (candidate) => candidate === plistPath || candidate === server,
    readFileSync: () => `
      <plist><dict>
        <key>ProgramArguments</key>
        <array>
          <string>/opt/homebrew/bin/node</string>
          <string>${server}</string>
        </array>
      </dict></plist>
    `,
  });

  assert.equal(result.installed, true);
  assert.equal(result.ok, false);
  assert.match(result.detail, /does not invoke/);
  assert.match(result.remediation ?? "", /remnic daemon install/);
});

test("inspectLaunchdPlist accepts an existing built server binary", () => {
  const plistPath = "/Users/test/Library/LaunchAgents/ai.remnic.daemon.plist";
  const server = "/opt/homebrew/lib/node_modules/@remnic/server/dist/bin/remnic-server.js";
  const result = inspectLaunchdPlist(plistPath, {
    existsSync: (candidate) => candidate === plistPath || candidate === server,
    readFileSync: () => `
      <plist><dict>
        <key>ProgramArguments</key>
        <array>
          <string>/opt/homebrew/bin/node</string>
          <string>${server}</string>
        </array>
      </dict></plist>
    `,
  });

  assert.equal(result.installed, true);
  assert.equal(result.ok, true);
  assert.match(result.detail, /dist\/bin\/remnic-server\.js/);
});

test("inspectLaunchdPlist recognizes legacy engram-server index paths", () => {
  const plistPath = "/Users/test/Library/LaunchAgents/ai.engram.daemon.plist";
  const server = "/opt/homebrew/lib/node_modules/engram-server/dist/index.js";
  const result = inspectLaunchdPlist(plistPath, {
    existsSync: (candidate) => candidate === plistPath || candidate === server,
    readFileSync: () => `
      <plist><dict>
        <key>ProgramArguments</key>
        <array>
          <string>${server}</string>
        </array>
      </dict></plist>
    `,
  });

  assert.equal(result.installed, true);
  assert.equal(result.ok, true);
  assert.match(result.detail, /engram-server\/dist\/index\.js/);
});

test("inspectLaunchdPlist expands shared home aliases in server arguments", () => {
  const originalHome = process.env.HOME;
  process.env.HOME = "/Users/test";

  try {
    const plistPath = "/Users/test/Library/LaunchAgents/ai.remnic.daemon.plist";
    const server = "/Users/test/.npm/lib/node_modules/@remnic/server/dist/bin/remnic-server.js";
    const result = inspectLaunchdPlist(plistPath, {
      existsSync: (candidate) => candidate === plistPath || candidate === server,
      readFileSync: () => `
        <plist><dict>
          <key>ProgramArguments</key>
          <array>
            <string>/opt/homebrew/bin/node</string>
            <string>\${HOME}/.npm/lib/node_modules/@remnic/server/dist/bin/remnic-server.js</string>
          </array>
        </dict></plist>
      `,
    });

    assert.equal(result.installed, true);
    assert.equal(result.ok, true);
    assert.match(result.detail, /\/Users\/test\/\.npm/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});
