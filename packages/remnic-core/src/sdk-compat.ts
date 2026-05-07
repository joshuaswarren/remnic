/**
 * Runtime SDK capability detection.
 *
 * Probes the injected api object at registration time to determine which
 * OpenClaw SDK features are available. All hook registrations and entry-point
 * patterns branch on these flags so engram works on both old (≤2026.3.13)
 * and new (≥2026.3.22) runtimes.
 */
import { readEnvVar } from "./runtime/env.js";

export interface SdkCapabilities {
  /** api.on("before_prompt_build", ...) is available */
  hasBeforePromptBuild: boolean;
  /** api.registerMemoryPromptSection() exists */
  hasRegisterMemoryPromptSection: boolean;
  /** api.registerMemoryCapability() exists (new SDK >=2026.4.5) */
  hasRegisterMemoryCapability: boolean;
  /** definePluginEntry from openclaw/plugin-sdk/plugin-entry is importable */
  hasDefinePluginEntry: boolean;
  /** api.runtime.* namespace exists */
  hasRuntimeNamespace: boolean;
  /** api.registrationMode is present */
  hasRegistrationMode: boolean;
  /** Hooks receive typed event/context objects */
  hasTypedHooks: boolean;
  /** Detected SDK version string, or "legacy" */
  sdkVersion: string;
  /** api.registrationMode value when present */
  registrationMode: OpenClawRegistrationMode | undefined;
}

export type OpenClawRegistrationMode =
  | "full"
  | "discovery"
  | "tool-discovery"
  | "setup-only"
  | "setup-runtime"
  | "cli-metadata"
  | (string & {});

export function detectSdkCapabilities(api: Record<string, unknown>): SdkCapabilities {
  const hasRegisterMemoryPromptSection =
    typeof (api as any).registerMemoryPromptSection === "function";
  const hasRegisterMemoryCapability =
    typeof (api as any).registerMemoryCapability === "function";
  const hasRuntimeNamespace =
    typeof (api as any).runtime === "object" && (api as any).runtime !== null;
  const hasRegistrationMode = typeof (api as any).registrationMode === "string";

  const runtimeVersion =
    hasRuntimeNamespace && typeof (api as any).runtime?.version === "string"
      ? (api as any).runtime.version
      : null;
  const isNewSdk =
    hasRegisterMemoryPromptSection || hasRegisterMemoryCapability || hasRuntimeNamespace || hasRegistrationMode;
  const sdkVersion: string =
    runtimeVersion ??
    (isNewSdk ? readEnvVar("OPENCLAW_SERVICE_VERSION") : null) ??
    "legacy";

  // New SDK is indicated by any of the new API surfaces being present.
  // New hook system requires one of the authoritative new-SDK signals:
  //   - registerMemoryPromptSection (pre-capability new SDKs, ≥2026.3.22)
  //   - registerMemoryCapability   (capability-based SDKs, ≥2026.4.5; the
  //     deprecated registerMemoryPromptSection may be absent)
  //   - registrationMode           (explicit registration lifecycle signal)
  // Just having runtime.version is NOT sufficient — some legacy builds
  // expose it. Omitting registerMemoryCapability here would cause the
  // legacy before_agent_start hook to be registered on new SDKs that only
  // expose registerMemoryCapability, silently breaking memory injection.
  const hasNewHookSystem =
    hasRegisterMemoryPromptSection || hasRegisterMemoryCapability || hasRegistrationMode;

  return {
    hasBeforePromptBuild: hasNewHookSystem,
    hasRegisterMemoryPromptSection,
    hasRegisterMemoryCapability,
    hasDefinePluginEntry: isNewSdk, // entry point is less risky, keep broad detection
    hasRuntimeNamespace,
    hasRegistrationMode,
    hasTypedHooks: hasNewHookSystem,
    sdkVersion,
    registrationMode: hasRegistrationMode
      ? ((api as any).registrationMode as SdkCapabilities["registrationMode"])
      : undefined,
  };
}
