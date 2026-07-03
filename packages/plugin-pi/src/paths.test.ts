import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveOmpAgentHome, resolveOmpExtensionRoot } from "./paths.js";

test("resolveOmpAgentHome defaults to ~/.omp/agent", () => {
  assert.equal(
    resolveOmpAgentHome({ HOME: "/home/alice" }),
    path.join("/home/alice", ".omp", "agent"),
  );
});

test("resolveOmpAgentHome honors PI_CODING_AGENT_DIR override", () => {
  assert.equal(
    resolveOmpAgentHome({
      HOME: "/home/alice",
      PI_CODING_AGENT_DIR: "/custom/omp-agent",
    }),
    "/custom/omp-agent",
  );
});

test("resolveOmpAgentHome honors PI_CONFIG_DIR for the config dir name", () => {
  assert.equal(
    resolveOmpAgentHome({ HOME: "/home/alice", PI_CONFIG_DIR: ".myomp" }),
    path.join("/home/alice", ".myomp", "agent"),
  );
});

test("resolveOmpAgentHome lets an active profile take precedence over PI_CODING_AGENT_DIR", () => {
  // Matches omp's DirResolver: when a profile is active, the agent-dir
  // override is discarded, so the extension must land in the profile dir.
  assert.equal(
    resolveOmpAgentHome({
      HOME: "/home/alice",
      OMP_PROFILE: "work",
      PI_CODING_AGENT_DIR: "/custom/omp-agent",
    }),
    path.join("/home/alice", ".omp", "profiles", "work", "agent"),
  );
});

test("resolveOmpAgentHome combines PI_CONFIG_DIR with a named profile", () => {
  assert.equal(
    resolveOmpAgentHome({ HOME: "/home/alice", PI_CONFIG_DIR: ".myomp", PI_PROFILE: "scratch" }),
    path.join("/home/alice", ".myomp", "profiles", "scratch", "agent"),
  );
});

test("resolveOmpAgentHome resolves a named profile under ~/.omp/profiles", () => {
  assert.equal(
    resolveOmpAgentHome({ HOME: "/home/alice", OMP_PROFILE: "work" }),
    path.join("/home/alice", ".omp", "profiles", "work", "agent"),
  );
});

test("resolveOmpAgentHome falls back to PI_PROFILE for the profile name", () => {
  assert.equal(
    resolveOmpAgentHome({ HOME: "/home/alice", PI_PROFILE: "scratch" }),
    path.join("/home/alice", ".omp", "profiles", "scratch", "agent"),
  );
});

test("resolveOmpAgentHome treats the default profile as the base agent dir", () => {
  assert.equal(
    resolveOmpAgentHome({ HOME: "/home/alice", OMP_PROFILE: "default" }),
    path.join("/home/alice", ".omp", "agent"),
  );
});

test("resolveOmpExtensionRoot appends extensions/remnic to the agent home", () => {
  assert.equal(
    resolveOmpExtensionRoot({ HOME: "/home/alice" }),
    path.join("/home/alice", ".omp", "agent", "extensions", "remnic"),
  );
});
