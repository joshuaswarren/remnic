import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getConnectorsConfigRoot,
  getLegacyConnectorsConfigRoot,
  getActiveConnectorsConfigRoot,
  getRegistryPath,
  getConnectorsDir,
  REGISTRY_DIR_NAME,
  LEGACY_REGISTRY_DIR_NAME,
} from "./paths.js";

/**
 * Issue #1518 — the connector registry path moved from
 * `~/.config/engram/.engram-connectors/` to `~/.config/remnic/.remnic-connectors/`,
 * with a read-fallback so existing engram-era installs keep resolving until
 * the user migrates. These tests lock in that contract.
 */

function withXdgHome<T>(body: (xdg: string) => T): T {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-paths-test-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    return body(xdg);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(xdg, { recursive: true, force: true });
  }
}

test("getConnectorsConfigRoot: canonical root is remnic/, not engram/ (#1518)", () => {
  withXdgHome((xdg) => {
    const root = getConnectorsConfigRoot();
    assert.equal(root, path.join(xdg, "remnic"));
    assert.notEqual(root, path.join(xdg, "engram"));
  });
});

test("getLegacyConnectorsConfigRoot: legacy root is still engram/ (read-fallback)", () => {
  withXdgHome((xdg) => {
    assert.equal(getLegacyConnectorsConfigRoot(), path.join(xdg, "engram"));
  });
});

test("REGISTRY_DIR_NAME: canonical subdir is .remnic-connectors", () => {
  assert.equal(REGISTRY_DIR_NAME, ".remnic-connectors");
  assert.equal(LEGACY_REGISTRY_DIR_NAME, ".engram-connectors");
});

test("getConnectorsDir: fresh install writes to remnic/.remnic-connectors/connectors", () => {
  withXdgHome((xdg) => {
    // Neither remnic nor engram exists → canonical remnic wins.
    const dir = getConnectorsDir();
    assert.equal(
      dir,
      path.join(xdg, "remnic", ".remnic-connectors", "connectors"),
      "fresh install must resolve to the canonical remnic path",
    );
  });
});

test("getRegistryPath: fresh install writes registry.json under remnic/.remnic-connectors", () => {
  withXdgHome((xdg) => {
    const reg = getRegistryPath();
    assert.equal(
      reg,
      path.join(xdg, "remnic", ".remnic-connectors", "registry.json"),
    );
  });
});

test("read-fallback: when ONLY engram/ exists, active root resolves to engram (#1518 back-compat)", () => {
  withXdgHome((xdg) => {
    // Seed the legacy engram tree — no remnic dir.
    fs.mkdirSync(path.join(xdg, "engram", ".engram-connectors", "connectors"), {
      recursive: true,
    });
    assert.equal(getActiveConnectorsConfigRoot(), path.join(xdg, "engram"));
    assert.equal(
      getConnectorsDir(),
      path.join(xdg, "engram", ".engram-connectors", "connectors"),
    );
    assert.equal(
      getRegistryPath(),
      path.join(xdg, "engram", ".engram-connectors", "registry.json"),
    );
  });
});

test("read-fallback: once remnic/ exists, it wins over engram (post-migration)", () => {
  withXdgHome((xdg) => {
    // Seed BOTH trees — the user has started migrating.
    fs.mkdirSync(path.join(xdg, "engram", ".engram-connectors", "connectors"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(xdg, "remnic", ".remnic-connectors", "connectors"), {
      recursive: true,
    });
    assert.equal(getActiveConnectorsConfigRoot(), path.join(xdg, "remnic"));
    assert.equal(
      getConnectorsDir(),
      path.join(xdg, "remnic", ".remnic-connectors", "connectors"),
    );
  });
});

test("read-fallback: a bare config-root dir without its registry subdir does NOT trigger fallback (#1620 round 1)", () => {
  withXdgHome((xdg) => {
    // A stray engram/ dir (no .engram-connectors inside) is NOT evidence of a
    // connector install. The probe targets the registry subdir, so this falls
    // through to the canonical remnic root.
    fs.mkdirSync(path.join(xdg, "engram"), { recursive: true });
    assert.equal(
      getActiveConnectorsConfigRoot(),
      path.join(xdg, "remnic"),
      "bare engram/ without .engram-connectors must not trigger the legacy fallback",
    );
  });
});

test("read-fallback: stray remnic/config.json must not hide legacy engram connector data (#1620 round 1 regression)", () => {
  // The cursor-reported bug: the daemon creates ~/.config/remnic/config.json
  // for its own setup, so the bare remnic/ config root exists on a machine
  // that has NEVER installed a connector under remnic. The active root must
  // still resolve to engram when connector data lives there, otherwise
  // loadRegistry would read an empty remnic tree and legacy installs would
  // look uninstalled.
  withXdgHome((xdg) => {
    // Daemon setup created remnic/config.json (no .remnic-connectors).
    fs.mkdirSync(path.join(xdg, "remnic"), { recursive: true });
    fs.writeFileSync(path.join(xdg, "remnic", "config.json"), "{}\n");
    // Real connector data still lives under the legacy engram tree.
    fs.mkdirSync(path.join(xdg, "engram", ".engram-connectors", "connectors"), {
      recursive: true,
    });
    assert.equal(getActiveConnectorsConfigRoot(), path.join(xdg, "engram"));
    assert.equal(
      getConnectorsDir(),
      path.join(xdg, "engram", ".engram-connectors", "connectors"),
    );
  });
});
