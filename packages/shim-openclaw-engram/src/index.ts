// Re-export everything from @remnic/plugin-openclaw (types, named exports).
export * from "@remnic/plugin-openclaw";

// The shim intentionally advertises the legacy plugin id "openclaw-engram"
// so existing OpenClaw configs with `plugins.entries["openclaw-engram"]`
// keep working. The manifest in this package also declares the legacy id;
// keep the runtime default export in sync so loaders that read
// `pluginDefinition.id` see the same value as the manifest (#403).
//
// The id is hardcoded (not imported from @remnic/core) because the shim
// *is* the legacy alias — the string is its identity, not a shared constant.
import remnicPluginDefinition from "@remnic/plugin-openclaw";

type RemnicPluginDefinition = typeof remnicPluginDefinition;
type RemnicRegisterApi = Parameters<RemnicPluginDefinition["register"]>[0];

const shimPluginDefinition = {
  ...remnicPluginDefinition,
  id: "openclaw-engram" as const,
  register(api: RemnicRegisterApi) {
    return remnicPluginDefinition.register.call(shimPluginDefinition, api);
  },
};

export default shimPluginDefinition;
