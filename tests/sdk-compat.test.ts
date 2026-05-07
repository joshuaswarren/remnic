import test from "node:test";
import assert from "node:assert/strict";
import { detectSdkCapabilities } from "../src/sdk-compat.js";

test("legacy api (no new fields) → all capabilities false, sdkVersion 'legacy'", () => {
  const api: Record<string, unknown> = {
    on: () => {},
    registerTool: () => {},
    registerCommand: () => {},
    registerService: () => {},
  };

  const caps = detectSdkCapabilities(api);

  assert.equal(caps.hasBeforePromptBuild, false);
  assert.equal(caps.hasRegisterMemoryPromptSection, false);
  assert.equal(caps.hasRegisterMemoryCapability, false);
  assert.equal(caps.hasDefinePluginEntry, false);
  assert.equal(caps.hasRuntimeNamespace, false);
  assert.equal(caps.hasRegistrationMode, false);
  assert.equal(caps.hasTypedHooks, false);
  assert.equal(caps.sdkVersion, "legacy");
  assert.equal(caps.registrationMode, undefined);
});

test("new api (registerMemoryPromptSection, runtime, registrationMode) → capabilities true, sdkVersion from runtime.version", () => {
  const api: Record<string, unknown> = {
    on: () => {},
    registerTool: () => {},
    registerCommand: () => {},
    registerService: () => {},
    registerMemoryPromptSection: () => {},
    runtime: { version: "2026.3.22" },
    registrationMode: "full",
  };

  const caps = detectSdkCapabilities(api);

  assert.equal(caps.hasBeforePromptBuild, true);
  assert.equal(caps.hasRegisterMemoryPromptSection, true);
  assert.equal(caps.hasDefinePluginEntry, true);
  assert.equal(caps.hasRuntimeNamespace, true);
  assert.equal(caps.hasRegistrationMode, true);
  assert.equal(caps.hasTypedHooks, true);
  assert.equal(caps.sdkVersion, "2026.3.22");
  assert.equal(caps.registrationMode, "full");
});

test("partial new api (only registerMemoryPromptSection, no runtime) → detects available features correctly", () => {
  const api: Record<string, unknown> = {
    on: () => {},
    registerTool: () => {},
    registerMemoryPromptSection: () => {},
  };

  const prev = process.env.OPENCLAW_SERVICE_VERSION;
  delete process.env.OPENCLAW_SERVICE_VERSION;
  const caps = detectSdkCapabilities(api);

  assert.equal(caps.hasBeforePromptBuild, true);
  assert.equal(caps.hasRegisterMemoryPromptSection, true);
  assert.equal(caps.hasDefinePluginEntry, true);
  assert.equal(caps.hasRuntimeNamespace, false);
  assert.equal(caps.hasRegistrationMode, false);
  assert.equal(caps.hasTypedHooks, true);
  assert.equal(caps.sdkVersion, "legacy");
  assert.equal(caps.registrationMode, undefined);

  if (prev !== undefined) {
    process.env.OPENCLAW_SERVICE_VERSION = prev;
  }
});

test("new api with registrationMode only → isNewSdk true even without registerMemoryPromptSection or runtime", () => {
  const api: Record<string, unknown> = {
    on: () => {},
    registrationMode: "setup-only",
  };

  const caps = detectSdkCapabilities(api);

  assert.equal(caps.hasBeforePromptBuild, true);
  assert.equal(caps.hasRegisterMemoryPromptSection, false);
  assert.equal(caps.hasDefinePluginEntry, true);
  assert.equal(caps.hasRuntimeNamespace, false);
  assert.equal(caps.hasRegistrationMode, true);
  assert.equal(caps.hasTypedHooks, true);
  assert.equal(caps.registrationMode, "setup-only");
});

test("runtime namespace alone does NOT imply hasBeforePromptBuild or hasTypedHooks", () => {
  const api: Record<string, unknown> = {
    on: () => {},
    runtime: { version: "2026.3.22" },
  };

  const caps = detectSdkCapabilities(api);

  assert.equal(caps.hasRuntimeNamespace, true);
  assert.equal(caps.hasBeforePromptBuild, false, "runtime.version alone should not set hasBeforePromptBuild");
  assert.equal(caps.hasTypedHooks, false, "runtime.version alone should not set hasTypedHooks");
  assert.equal(caps.hasDefinePluginEntry, true, "runtime.version should still set hasDefinePluginEntry");
  assert.equal(caps.sdkVersion, "2026.3.22");
});

test("runtime object without version string falls back to process.env or 'legacy'", () => {
  const api: Record<string, unknown> = {
    on: () => {},
    runtime: { someOtherProp: true },
  };

  // Ensure OPENCLAW_SERVICE_VERSION is not set for this test
  const prev = process.env.OPENCLAW_SERVICE_VERSION;
  delete process.env.OPENCLAW_SERVICE_VERSION;

  const caps = detectSdkCapabilities(api);

  assert.equal(caps.hasRuntimeNamespace, true);
  assert.equal(caps.sdkVersion, "legacy");

  // Restore env
  if (prev !== undefined) {
    process.env.OPENCLAW_SERVICE_VERSION = prev;
  }
});

test("sdkVersion falls back to OPENCLAW_SERVICE_VERSION env var when runtime.version absent", () => {
  const api: Record<string, unknown> = {
    on: () => {},
    runtime: { someOtherProp: true },
  };

  const prev = process.env.OPENCLAW_SERVICE_VERSION;
  process.env.OPENCLAW_SERVICE_VERSION = "2026.3.22-env";

  const caps = detectSdkCapabilities(api);

  assert.equal(caps.sdkVersion, "2026.3.22-env");

  // Restore env
  if (prev !== undefined) {
    process.env.OPENCLAW_SERVICE_VERSION = prev;
  } else {
    delete process.env.OPENCLAW_SERVICE_VERSION;
  }
});

test("sdkVersion falls back to OPENCLAW_SERVICE_VERSION env var even without runtime namespace", () => {
  const api: Record<string, unknown> = {
    on: () => {},
    registerMemoryPromptSection: () => {},
  };

  const prev = process.env.OPENCLAW_SERVICE_VERSION;
  process.env.OPENCLAW_SERVICE_VERSION = "2026.3.22-env";

  const caps = detectSdkCapabilities(api);

  assert.equal(caps.hasRuntimeNamespace, false);
  assert.equal(caps.sdkVersion, "2026.3.22-env");

  if (prev !== undefined) {
    process.env.OPENCLAW_SERVICE_VERSION = prev;
  } else {
    delete process.env.OPENCLAW_SERVICE_VERSION;
  }
});

test("runtime namespace null does not count as hasRuntimeNamespace", () => {
  const api: Record<string, unknown> = {
    on: () => {},
    runtime: null,
  };

  const caps = detectSdkCapabilities(api);

  assert.equal(caps.hasRuntimeNamespace, false);
});

test("modern registrationMode values are passed through correctly", () => {
  for (const mode of [
    "full",
    "discovery",
    "tool-discovery",
    "setup-only",
    "setup-runtime",
    "cli-metadata",
  ]) {
    const api: Record<string, unknown> = {
      on: () => {},
      runtime: { version: "2026.3.22" },
      registrationMode: mode,
    };

    const caps = detectSdkCapabilities(api);

    assert.equal(caps.registrationMode, mode);
    assert.equal(caps.hasRegistrationMode, true);
  }
});

test("registerMemoryCapability detection when present", () => {
  const api: Record<string, unknown> = {
    on: () => {},
    registerMemoryCapability: () => {},
    runtime: { version: "2026.4.9" },
    registrationMode: "full",
  };

  const caps = detectSdkCapabilities(api);

  assert.equal(caps.hasRegisterMemoryCapability, true);
  assert.equal(caps.hasDefinePluginEntry, true);
});

test("registerMemoryCapability absent on legacy SDK", () => {
  const api: Record<string, unknown> = {
    on: () => {},
    registerMemoryPromptSection: () => {},
    runtime: { version: "2026.3.22" },
  };

  const caps = detectSdkCapabilities(api);

  assert.equal(caps.hasRegisterMemoryCapability, false);
  assert.equal(caps.hasRegisterMemoryPromptSection, true);
});

test("registerMemoryCapability alone implies isNewSdk", () => {
  const api: Record<string, unknown> = {
    on: () => {},
    registerMemoryCapability: () => {},
  };

  const caps = detectSdkCapabilities(api);

  assert.equal(caps.hasRegisterMemoryCapability, true);
  assert.equal(caps.hasDefinePluginEntry, true, "registerMemoryCapability should imply isNewSdk");
});

test("registerMemoryCapability without registerMemoryPromptSection still routes to new hook system", () => {
  // New SDK (>=2026.4.5) exposes registerMemoryCapability but drops the
  // deprecated registerMemoryPromptSection. hasNewHookSystem must still be
  // true so index.ts registers before_prompt_build instead of the legacy
  // before_agent_start hook. Otherwise cachedMemoryBySession never gets
  // populated on the new SDK and memory injection silently breaks.
  const api: Record<string, unknown> = {
    on: () => {},
    registerMemoryCapability: () => {},
    runtime: { version: "2026.4.9" },
  };

  const caps = detectSdkCapabilities(api);

  assert.equal(caps.hasRegisterMemoryCapability, true);
  assert.equal(caps.hasRegisterMemoryPromptSection, false);
  assert.equal(caps.hasRegistrationMode, false);
  assert.equal(
    caps.hasBeforePromptBuild,
    true,
    "registerMemoryCapability alone must enable before_prompt_build hook",
  );
  assert.equal(caps.hasTypedHooks, true);
});

test("registerMemoryCapability with registrationMode still enables new hook system", () => {
  const api: Record<string, unknown> = {
    on: () => {},
    registerMemoryCapability: () => {},
    runtime: { version: "2026.4.9" },
    registrationMode: "full",
  };

  const caps = detectSdkCapabilities(api);

  assert.equal(caps.hasBeforePromptBuild, true);
  assert.equal(caps.hasRegisterMemoryCapability, true);
});
