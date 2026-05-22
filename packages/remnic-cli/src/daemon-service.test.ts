import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  doesProcessCommandLookLikeRemnicDaemon,
  inspectLaunchdPlist,
  launchdLoadPlist,
  launchdUnloadPlist,
  readLaunchdProgramArguments,
  readVerifiedDaemonPid,
  resolveServerBinDetails,
} from "./daemon-service.js";

test("resolveServerBinDetails prefers installed @remnic/server bin through ESM resolution", () => {
  const packageEntry = "/opt/homebrew/lib/node_modules/@remnic/server/dist/index.js";
  const packageBin = "/opt/homebrew/lib/node_modules/@remnic/server/bin/remnic-server.js";
  const result = resolveServerBinDetails({
    moduleDir: "/repo/packages/remnic-cli/dist",
    packageResolve: (specifier) => {
      assert.equal(specifier, "@remnic/server");
      return pathToFileURL(packageEntry).href;
    },
    existsSync: (candidate) => candidate === packageBin || candidate === packageEntry,
  });

  assert.deepEqual(result, {
    path: packageBin,
    source: "package",
    exists: true,
    loadableByNode: true,
  });
});

test("resolveServerBinDetails requires installed bin wrapper to have built dist", () => {
  const packageEntry = "/opt/homebrew/lib/node_modules/@remnic/server/dist/index.js";
  const packageBin = "/opt/homebrew/lib/node_modules/@remnic/server/bin/remnic-server.js";
  const result = resolveServerBinDetails({
    moduleDir: "/repo/packages/remnic-cli/dist",
    packageResolve: () => pathToFileURL(packageEntry).href,
    existsSync: (candidate) => candidate === packageBin,
  });

  assert.equal(result.path, packageBin);
  assert.equal(result.source, "package");
  assert.equal(result.exists, true);
  assert.equal(result.loadableByNode, false);
});

test("resolveServerBinDetails falls back to workspace dist before source", () => {
  const moduleDir = "/repo/packages/remnic-cli/dist";
  const workspaceDist = path.resolve(moduleDir, "../../remnic-server/dist/index.js");
  const workspaceBin = path.resolve(moduleDir, "../../remnic-server/bin/remnic-server.js");
  const workspaceSource = path.resolve(moduleDir, "../../remnic-server/src/index.ts");
  const result = resolveServerBinDetails({
    moduleDir,
    packageResolve: () => {
      throw new Error("not installed");
    },
    existsSync: (candidate) => (
      candidate === workspaceBin ||
      candidate === workspaceDist ||
      candidate === workspaceSource
    ),
  });

  assert.equal(result.path, workspaceBin);
  assert.equal(result.source, "workspace-dist");
  assert.equal(result.exists, true);
  assert.equal(result.loadableByNode, true);
});

test("resolveServerBinDetails skips workspace bin before dist build when source fallback exists", () => {
  const moduleDir = "/repo/packages/remnic-cli/dist";
  const workspaceBin = path.resolve(moduleDir, "../../remnic-server/bin/remnic-server.js");
  const workspaceSource = path.resolve(moduleDir, "../../remnic-server/src/index.ts");
  const result = resolveServerBinDetails({
    moduleDir,
    packageResolve: () => {
      throw new Error("not installed");
    },
    existsSync: (candidate) => candidate === workspaceBin || candidate === workspaceSource,
  });

  assert.equal(result.path, workspaceSource);
  assert.equal(result.source, "workspace-source");
  assert.equal(result.exists, true);
  assert.equal(result.loadableByNode, false);
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

test("resolveServerBinDetails skips PATH bin wrapper before dist build when source fallback exists", () => {
  const moduleDir = "/repo/packages/remnic-cli/dist";
  const pathServer = "/other/repo/packages/remnic-server/bin/remnic-server.js";
  const workspaceSource = path.resolve(moduleDir, "../../remnic-server/src/index.ts");
  const result = resolveServerBinDetails({
    moduleDir,
    pathEnv: "/other/repo/node_modules/.bin",
    packageResolve: () => {
      throw new Error("not installed");
    },
    findCommandOnPath: () => pathServer,
    existsSync: (candidate) => candidate === pathServer || candidate === workspaceSource,
  });

  assert.equal(result.path, workspaceSource);
  assert.equal(result.source, "workspace-source");
  assert.equal(result.exists, true);
  assert.equal(result.loadableByNode, false);
});

test("resolveServerBinDetails uses PATH bin wrapper when its dist entry exists", () => {
  const moduleDir = "/repo/packages/remnic-cli/dist";
  const pathServer = "/other/repo/packages/remnic-server/bin/remnic-server.js";
  const pathServerDist = "/other/repo/packages/remnic-server/dist/index.js";
  const workspaceSource = path.resolve(moduleDir, "../../remnic-server/src/index.ts");
  const result = resolveServerBinDetails({
    moduleDir,
    pathEnv: "/other/repo/node_modules/.bin",
    packageResolve: () => {
      throw new Error("not installed");
    },
    findCommandOnPath: () => pathServer,
    existsSync: (candidate) => (
      candidate === pathServer ||
      candidate === pathServerDist ||
      candidate === workspaceSource
    ),
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

test("launchdLoadPlist invokes launchctl with argv instead of a shell command", () => {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const hostilePath = `/Users/test"$(touch injected)"/Library/LaunchAgents/ai.remnic.daemon.plist`;

  launchdLoadPlist(hostilePath, {
    execFileSync: (command, args, options) => {
      calls.push({ command, args: [...args], options });
      return Buffer.alloc(0);
    },
  });

  assert.deepEqual(calls, [
    {
      command: "launchctl",
      args: ["load", "-w", hostilePath],
      options: { stdio: "pipe" },
    },
  ]);
});

test("launchdUnloadPlist invokes launchctl with argv instead of a shell command", () => {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const hostilePath = `/Users/test"; touch injected; echo "/Library/LaunchAgents/ai.remnic.daemon.plist`;

  launchdUnloadPlist(hostilePath, {
    execFileSync: (command, args, options) => {
      calls.push({ command, args: [...args], options });
      return Buffer.alloc(0);
    },
  });

  assert.deepEqual(calls, [
    {
      command: "launchctl",
      args: ["unload", hostilePath],
      options: { stdio: "pipe" },
    },
  ]);
});

test("readVerifiedDaemonPid removes stale pid files for unrelated live processes", () => {
  const removed: string[] = [];
  const pid = readVerifiedDaemonPid({
    pidFiles: ["/tmp/remnic.pid"],
    expectedServerBin: "/repo/packages/remnic-server/bin/remnic-server.js",
    readFileSync: () => "12345\n",
    processKill: (candidatePid, signal) => {
      assert.equal(candidatePid, 12345);
      assert.equal(signal, 0);
      return true;
    },
    execFileSync: () => "/usr/bin/python3 unrelated.py\n",
    unlinkSync: (file) => {
      removed.push(file);
    },
  });

  assert.equal(pid, undefined);
  assert.deepEqual(removed, ["/tmp/remnic.pid"]);
});

test("readVerifiedDaemonPid accepts a live remnic-server command", () => {
  const removed: string[] = [];
  const pid = readVerifiedDaemonPid({
    pidFiles: ["/tmp/remnic.pid"],
    expectedServerBin: "/repo/packages/remnic-server/bin/remnic-server.js",
    readFileSync: () => "23456\n",
    processKill: () => true,
    execFileSync: () =>
      "/opt/homebrew/bin/node /repo/packages/remnic-server/bin/remnic-server.js\n",
    unlinkSync: (file) => {
      removed.push(file);
    },
  });

  assert.equal(pid, 23456);
  assert.deepEqual(removed, []);
});

test("doesProcessCommandLookLikeRemnicDaemon recognizes package and workspace server paths", () => {
  assert.equal(
    doesProcessCommandLookLikeRemnicDaemon(
      "node /opt/homebrew/lib/node_modules/@remnic/server/bin/remnic-server.js",
      "/different/server.js",
    ),
    true,
  );
  assert.equal(
    doesProcessCommandLookLikeRemnicDaemon(
      "npx tsx /repo/packages/remnic-server/src/index.ts",
      "/different/server.js",
    ),
    true,
  );
  assert.equal(
    doesProcessCommandLookLikeRemnicDaemon(
      "node /usr/local/bin/unrelated-service",
      "/repo/packages/remnic-server/bin/remnic-server.js",
    ),
    false,
  );
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
  const server = "/opt/homebrew/lib/node_modules/@remnic/server/bin/remnic-server.js";
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
  assert.match(result.detail, /@remnic\/server\/bin\/remnic-server\.js/);
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
