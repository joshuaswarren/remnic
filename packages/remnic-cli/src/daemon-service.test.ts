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
