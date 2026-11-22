import { type PluginConfig, isNamespacePolicyCovered } from "@remnic/core";

/** A single `remnic doctor` check row (mirrors the inline shape in cmdDoctor). */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  warn?: boolean;
  detail: string;
  remediation?: string;
}

/** Outcome of reading the raw client/plugin `namespace` key for the config-time lint. */
export interface ConfiguredNamespace {
  /** The trimmed configured write namespace, when present and usable. */
  configuredNamespace?: string;
  /** True when a `namespace` key is present but not a non-empty string. */
  invalid: boolean;
}

export function readConfiguredNamespace(remnicCfg: Record<string, unknown>): ConfiguredNamespace {
  if (!("namespace" in remnicCfg)) return { invalid: false };
  const value = remnicCfg.namespace;
  if (typeof value === "string" && value.trim().length > 0) {
    return { configuredNamespace: value.trim(), invalid: false };
  }
  return { invalid: true };
}

export function buildNamespacePolicyCheck(args: {
  invalid: boolean;
  configuredNamespace?: string;
  config?: PluginConfig;
}): DoctorCheck | undefined {
  if (args.invalid) {
    return {
      name: "Namespace policy",
      ok: false,
      detail: "config `namespace` is set but is not a non-empty string",
      remediation:
        "Set `namespace` to a non-empty string (a namespacePolicies name or the default namespace), or remove it.",
    };
  }
  if (!args.config || !args.configuredNamespace) return undefined;
  const covered = isNamespacePolicyCovered(args.configuredNamespace, args.config);
  return {
    name: "Namespace policy",
    ok: covered,
    warn: !covered,
    detail: covered
      ? `configured namespace "${args.configuredNamespace}" is writable`
      : `configured namespace "${args.configuredNamespace}" is writable by no one — its namespacePolicies entry grants no writer, or it has no entry and is not the default namespace`,
    remediation: covered
      ? undefined
      : `Give "${args.configuredNamespace}" a namespacePolicies entry with a non-blank writePrincipals value, or set namespace to a writable one — otherwise every write is rejected and dead-lettered.`,
  };
}
