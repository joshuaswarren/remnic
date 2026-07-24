import assert from "node:assert/strict";
import test from "node:test";

import { CaptureConfigError } from "./errors.js";
import {
  DEFAULT_SERVICE_LABEL,
  installService,
  planService,
  renderLaunchAgent,
  renderSystemdUnit,
  uninstallService,
  type ServiceSpec,
} from "./service.js";

const SPEC: ServiceSpec = {
  programArguments: ["/usr/bin/node", "/app/cli.js", "start", "--foreground", "--capture"],
  logPath: "/home/user/.remnic/audio.log",
};

test("renderLaunchAgent emits a plist with the label, args, and log paths", () => {
  const plist = renderLaunchAgent(SPEC);
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.remnic\.capture-audio<\/string>/);
  assert.match(plist, /<string>--capture<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /audio\.log/);
});

test("renderLaunchAgent xml-escapes argument content", () => {
  const plist = renderLaunchAgent({ ...SPEC, programArguments: ["/a & b/node <x>"] });
  assert.match(plist, /&amp;/);
  assert.match(plist, /&lt;x&gt;/);
  assert.equal(plist.includes("<x>"), false);
});

test("renderSystemdUnit quotes args with spaces and restarts on failure", () => {
  const unit = renderSystemdUnit({ ...SPEC, programArguments: ["/usr/bin/node", "/a b/cli.js", "start"] });
  assert.match(unit, /ExecStart=\/usr\/bin\/node "\/a b\/cli\.js" start/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("planService picks the platform-appropriate unit path", () => {
  const darwin = planService({ platform: "darwin", home: "/Users/jane", spec: SPEC });
  assert.equal(darwin.path, `/Users/jane/Library/LaunchAgents/${DEFAULT_SERVICE_LABEL}.plist`);
  assert.match(darwin.loadHint, /launchctl load/);
  const linux = planService({ platform: "linux", home: "/home/user", spec: SPEC });
  assert.equal(linux.path, "/home/user/.config/systemd/user/remnic-capture-audio.service");
  assert.match(linux.loadHint, /systemctl --user enable --now/);
});

test("planService rejects an unsupported platform", () => {
  assert.throws(() => planService({ platform: "win32", home: "C:/u", spec: SPEC }), CaptureConfigError);
});

test("installService writes the unit, creating its directory; force guards an existing unit", () => {
  const writes: Array<{ file: string; contents: string }> = [];
  const mkdirs: string[] = [];
  const plan = installService({
    platform: "linux",
    home: "/home/user",
    spec: SPEC,
    exists: () => false,
    mkdir: (dir) => mkdirs.push(dir),
    writeFile: (file, contents) => writes.push({ file, contents }),
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].file, plan.path);
  assert.equal(mkdirs[0], "/home/user/.config/systemd/user");

  assert.throws(
    () =>
      installService({
        platform: "linux",
        home: "/home/user",
        spec: SPEC,
        exists: () => true,
        mkdir: () => undefined,
        writeFile: () => undefined,
      }),
    CaptureConfigError,
  );
  // --force overwrites without throwing.
  assert.doesNotThrow(() =>
    installService({
      platform: "linux",
      home: "/home/user",
      spec: SPEC,
      force: true,
      exists: () => true,
      mkdir: () => undefined,
      writeFile: () => undefined,
    }),
  );
});

test("uninstallService removes an existing unit and reports absence", () => {
  const removed: string[] = [];
  const present = uninstallService({
    platform: "darwin",
    home: "/Users/jane",
    spec: SPEC,
    exists: () => true,
    remove: (f) => removed.push(f),
  });
  assert.equal(present.removed, true);
  assert.equal(removed.length, 1);

  const absent = uninstallService({
    platform: "darwin",
    home: "/Users/jane",
    spec: SPEC,
    exists: () => false,
    remove: () => assert.fail("must not remove when absent"),
  });
  assert.equal(absent.removed, false);
});

test("planService rejects an unsafe label (path/injection guard)", () => {
  assert.throws(
    () => planService({ platform: "darwin", home: "/Users/j", spec: { ...SPEC, label: "../evil" } }),
    CaptureConfigError,
  );
  assert.throws(
    () => planService({ platform: "linux", home: "/home/u", spec: { ...SPEC, label: "a/b c" } }),
    CaptureConfigError,
  );
});

test("renderSystemdUnit escapes percent specifiers", () => {
  const unit = renderSystemdUnit({ ...SPEC, programArguments: ["/bin/node", "--flag=100%done"] });
  assert.match(unit, /100%%done/);
  assert.equal(/[^%]%[^%]/.test(unit.split("\n").find((l) => l.startsWith("ExecStart")) ?? ""), false);
});
