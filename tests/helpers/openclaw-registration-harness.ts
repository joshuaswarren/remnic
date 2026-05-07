type RegistrationArgs = unknown[];
type OpenClawRegistrationMode =
  | "full"
  | "discovery"
  | "tool-discovery"
  | "setup-only"
  | "setup-runtime"
  | "cli-metadata";

export interface CapturedOpenClawApi {
  api: Record<string, unknown>;
  hooks(name?: string): RegistrationArgs[];
  registrations(method?: string): RegistrationArgs[];
  registrationNames(method: string): string[];
}

const SERVICE_ID = "openclaw-remnic";
const LEGACY_SERVICE_ID = "openclaw-engram";
const GLOBAL_KEYS = [
  `__openclawEngramRegistered::${SERVICE_ID}`,
  `__openclawEngramHookApis::${SERVICE_ID}`,
  `__openclawEngramOrchestrator::${SERVICE_ID}`,
  `__openclawEngramAccessService::${SERVICE_ID}`,
  `__openclawEngramAccessHttpServer::${SERVICE_ID}`,
  `__openclawEngramAccessHttpAuthState::${SERVICE_ID}`,
  `__openclawEngramServiceStarted::${SERVICE_ID}`,
  `__openclawEngramInitPromise::${SERVICE_ID}`,
  `__openclawEngramRegistered::${LEGACY_SERVICE_ID}`,
  `__openclawEngramHookApis::${LEGACY_SERVICE_ID}`,
  `__openclawEngramOrchestrator::${LEGACY_SERVICE_ID}`,
  `__openclawEngramAccessService::${LEGACY_SERVICE_ID}`,
  `__openclawEngramAccessHttpServer::${LEGACY_SERVICE_ID}`,
  `__openclawEngramAccessHttpAuthState::${LEGACY_SERVICE_ID}`,
  `__openclawEngramServiceStarted::${LEGACY_SERVICE_ID}`,
  `__openclawEngramInitPromise::${LEGACY_SERVICE_ID}`,
  "__openclawEngramOrchestrator",
  "__openclawEngramCliRegistered",
  "__openclawEngramCliActiveServiceCount",
  "__openclawEngramSessionCommandsRegistered",
  "__openclawEngramMigrationPromise",
] as const;

const DISABLE_REGISTER_MIGRATION_ENV = "REMNIC_DISABLE_REGISTER_MIGRATION";

export function captureOpenClawRegistrationApi(options: {
  label?: string;
  pluginConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
  registrationMode?: OpenClawRegistrationMode;
  runtime?: Record<string, unknown>;
  disabledMethods?: string[];
  logger?: Record<"debug" | "info" | "warn" | "error", (...args: unknown[]) => void>;
} = {}): CapturedOpenClawApi {
  const captured: Record<string, RegistrationArgs[]> = {};
  const pluginConfig = options.pluginConfig ?? {};
  const config = buildGatewayConfig(options.config, pluginConfig);
  const disabledMethods = new Set(options.disabledMethods ?? []);
  const target: Record<string, unknown> = {
    id: SERVICE_ID,
    pluginId: SERVICE_ID,
    label: options.label ?? "capture",
    registrationMode: options.registrationMode ?? "full",
    pluginConfig,
    config,
    runtime: options.runtime ?? {
      version: "2026.5.3-1",
      agent: {
        id: "generalist",
        workspaceDir: process.cwd(),
      },
    },
    logger: options.logger ?? {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  const capture = (method: string, args: RegistrationArgs) => {
    captured[method] ??= [];
    captured[method].push(args);
  };

  const api = new Proxy(target, {
    get(currentTarget, property) {
      if (property in currentTarget) {
        return currentTarget[property as keyof typeof currentTarget];
      }
      if (typeof property === "string" && disabledMethods.has(property)) {
        return undefined;
      }
      if (property === "on") {
        return (...args: RegistrationArgs) => capture("on", args);
      }
      if (typeof property === "string" && property.startsWith("register")) {
        return (...args: RegistrationArgs) => capture(property, args);
      }
      return undefined;
    },
  }) as Record<string, unknown>;

  return {
    api,
    hooks(name?: string) {
      const hooks = captured.on ?? [];
      return name ? hooks.filter(([hookName]) => hookName === name) : [...hooks];
    },
    registrations(method?: string) {
      if (method) return [...(captured[method] ?? [])];
      return Object.entries(captured).flatMap(([name, argsList]) =>
        name === "on" ? [] : argsList.map((args) => [name, ...args]),
      );
    },
    registrationNames(method: string) {
      return (captured[method] ?? [])
        .map(([value, secondary]) => registrationId(value, secondary))
        .filter((value): value is string => typeof value === "string")
        .sort();
    },
  };
}

function buildGatewayConfig(
  config: Record<string, unknown> | undefined,
  pluginConfig: Record<string, unknown>,
): Record<string, unknown> {
  const plugins =
    config?.plugins && typeof config.plugins === "object" && !Array.isArray(config.plugins)
      ? (config.plugins as Record<string, unknown>)
      : {};
  const entries =
    plugins.entries && typeof plugins.entries === "object" && !Array.isArray(plugins.entries)
      ? (plugins.entries as Record<string, unknown>)
      : {};

  return {
    ...config,
    plugins: {
      ...plugins,
      entries: {
        ...entries,
        [SERVICE_ID]: {
          config: pluginConfig,
        },
      },
    },
  };
}

export function saveAndResetOpenClawRegistrationGlobals(): Map<string, unknown> {
  const saved = new Map<string, unknown>();
  for (const key of GLOBAL_KEYS) {
    saved.set(key, (globalThis as Record<string, unknown>)[key]);
    delete (globalThis as Record<string, unknown>)[key];
  }
  return saved;
}

export function restoreOpenClawRegistrationGlobals(saved: Map<string, unknown>): void {
  for (const key of GLOBAL_KEYS) {
    if (saved.get(key) === undefined) {
      delete (globalThis as Record<string, unknown>)[key];
    } else {
      (globalThis as Record<string, unknown>)[key] = saved.get(key);
    }
  }
}

export function disableRegisterMigrationForCaptureTest(): string | undefined {
  const previous = process.env[DISABLE_REGISTER_MIGRATION_ENV];
  process.env[DISABLE_REGISTER_MIGRATION_ENV] = "1";
  return previous;
}

export function restoreRegisterMigrationForCaptureTest(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[DISABLE_REGISTER_MIGRATION_ENV];
  } else {
    process.env[DISABLE_REGISTER_MIGRATION_ENV] = previous;
  }
}

function registrationId(value: unknown, secondary: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string") return record.id;
    if (typeof record.name === "string") return record.name;
  }
  if (secondary && typeof secondary === "object") {
    const record = secondary as Record<string, unknown>;
    if (Array.isArray(record.descriptors)) {
      const names = record.descriptors
        .map((descriptor) =>
          descriptor && typeof descriptor === "object"
            ? (descriptor as Record<string, unknown>).name
            : undefined,
        )
        .filter((name): name is string => typeof name === "string" && name.length > 0);
      return names.length > 0 ? names.join(", ") : undefined;
    }
  }
  return undefined;
}
