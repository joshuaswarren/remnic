/**
 * WeClone connector configuration.
 *
 * Validates user-provided config and applies defaults for optional fields.
 */

import * as net from "node:net";

export interface MemoryInjectionConfig {
  maxTokens: number;
  position: "system-append" | "system-prepend";
  template: string;
}

export interface WeCloneConnectorConfig {
  wecloneApiUrl: string;
  wecloneModelName?: string;
  proxyPort: number;
  proxyBindHost?: string;
  allowPublicBind?: boolean;
  remnicDaemonUrl: string;
  remnicAuthToken?: string;
  sessionStrategy: "caller-id" | "single";
  memoryInjection: MemoryInjectionConfig;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  streamObservationMaxBytes?: number;
}

export const DEFAULT_CONFIG: WeCloneConnectorConfig = {
  wecloneApiUrl: "http://localhost:8000/v1",
  wecloneModelName: "weclone-avatar",
  proxyPort: 8100,
  proxyBindHost: "127.0.0.1",
  allowPublicBind: false,
  remnicDaemonUrl: "http://localhost:4318",
  sessionStrategy: "single",
  memoryInjection: {
    maxTokens: 1500,
    position: "system-append",
    template: "[Memory Context]\n{memories}\n[End Memory Context]",
  },
};

const VALID_SESSION_STRATEGIES = ["caller-id", "single"] as const;
const VALID_POSITIONS = ["system-append", "system-prepend"] as const;

function normalizeBindHostForValidation(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
}

function expandIpv6Groups(host: string): number[] | null {
  if (net.isIP(host) !== 6) return null;
  const parts = host.split("::");
  if (parts.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (!segment) return [];
    const groups: number[] = [];
    const rawGroups = segment.split(":");
    for (let i = 0; i < rawGroups.length; i += 1) {
      const group = rawGroups[i];
      if (group.includes(".")) {
        if (i !== rawGroups.length - 1 || net.isIP(group) !== 4) return null;
        const octets = group.split(".").map((octet) => Number.parseInt(octet, 10));
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const head = parseGroups(parts[0] ?? "");
  const tail = parts.length === 2 ? parseGroups(parts[1] ?? "") : [];
  if (!head || !tail) return null;
  const explicitGroupCount = head.length + tail.length;
  const zeroFillCount = parts.length === 2 ? 8 - explicitGroupCount : 0;
  if (parts.length === 1 && explicitGroupCount !== 8) return null;
  if (parts.length === 2 && zeroFillCount < 1) return null;

  const groups = [...head, ...Array.from({ length: zeroFillCount }, () => 0), ...tail];
  return groups.length === 8 ? groups : null;
}

function isAllZeroIpv6Address(host: string): boolean {
  const groups = expandIpv6Groups(host);
  return groups !== null && groups.every((group) => group === 0);
}

function isIpv4MappedWildcardAddress(host: string): boolean {
  const groups = expandIpv6Groups(host);
  return (
    groups !== null &&
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff &&
    groups[6] === 0 &&
    groups[7] === 0
  );
}

function isPublicBindHost(host: string): boolean {
  const normalized = normalizeBindHostForValidation(host);
  return (
    normalized === "0.0.0.0" ||
    isAllZeroIpv6Address(normalized) ||
    isIpv4MappedWildcardAddress(normalized)
  );
}

function parseOptionalPositiveInteger(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Config '${key}' must be a positive integer when provided`);
  }
  return value;
}

/**
 * Parse and validate a raw config object into a WeCloneConnectorConfig.
 *
 * Rejects missing required fields and invalid values with clear messages.
 * Applies defaults for all optional fields.
 */
export function parseConfig(raw: unknown): WeCloneConnectorConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config must be a non-null object");
  }

  const obj = raw as Record<string, unknown>;

  // --- Required fields ---
  if (typeof obj.wecloneApiUrl !== "string" || obj.wecloneApiUrl.length === 0) {
    throw new Error(
      "Config 'wecloneApiUrl' is required and must be a non-empty string"
    );
  }

  if (
    typeof obj.proxyPort !== "number" ||
    !Number.isInteger(obj.proxyPort) ||
    obj.proxyPort <= 0 ||
    obj.proxyPort > 65535
  ) {
    throw new Error(
      "Config 'proxyPort' is required and must be an integer between 1 and 65535"
    );
  }

  if (typeof obj.remnicDaemonUrl !== "string" || obj.remnicDaemonUrl.length === 0) {
    throw new Error(
      "Config 'remnicDaemonUrl' is required and must be a non-empty string"
    );
  }

  // --- Optional fields with validation ---
  let remnicAuthToken: string | undefined;
  if (obj.remnicAuthToken !== undefined) {
    if (typeof obj.remnicAuthToken !== "string" || obj.remnicAuthToken.length === 0) {
      throw new Error(
        "Config 'remnicAuthToken' must be a non-empty string when provided"
      );
    }
    remnicAuthToken = obj.remnicAuthToken;
  }

  const wecloneModelName =
    obj.wecloneModelName !== undefined
      ? String(obj.wecloneModelName)
      : DEFAULT_CONFIG.wecloneModelName;

  const proxyBindHost =
    obj.proxyBindHost !== undefined
      ? String(obj.proxyBindHost).trim()
      : DEFAULT_CONFIG.proxyBindHost;
  if (!proxyBindHost) {
    throw new Error("Config 'proxyBindHost' must be a non-empty string when provided");
  }
  const allowPublicBind = obj.allowPublicBind === true;
  if (isPublicBindHost(proxyBindHost) && !allowPublicBind) {
    throw new Error(
      "Config 'proxyBindHost' cannot bind to all interfaces unless allowPublicBind is true",
    );
  }

  let sessionStrategy = DEFAULT_CONFIG.sessionStrategy;
  if (obj.sessionStrategy !== undefined) {
    if (!VALID_SESSION_STRATEGIES.includes(obj.sessionStrategy as typeof VALID_SESSION_STRATEGIES[number])) {
      throw new Error(
        `Config 'sessionStrategy' must be one of: ${VALID_SESSION_STRATEGIES.join(", ")}. ` +
          `Got: ${JSON.stringify(obj.sessionStrategy)}`
      );
    }
    sessionStrategy = obj.sessionStrategy as typeof sessionStrategy;
  }

  // --- Memory injection ---
  let memoryInjection = { ...DEFAULT_CONFIG.memoryInjection };
  if (obj.memoryInjection !== undefined) {
    if (typeof obj.memoryInjection !== "object" || obj.memoryInjection === null) {
      throw new Error("Config 'memoryInjection' must be an object");
    }
    const mi = obj.memoryInjection as Record<string, unknown>;

    if (mi.maxTokens !== undefined) {
      if (typeof mi.maxTokens !== "number" || !Number.isInteger(mi.maxTokens) || mi.maxTokens <= 0) {
        throw new Error(
          "Config 'memoryInjection.maxTokens' must be a positive integer"
        );
      }
      memoryInjection.maxTokens = mi.maxTokens;
    }

    if (mi.position !== undefined) {
      if (!VALID_POSITIONS.includes(mi.position as typeof VALID_POSITIONS[number])) {
        throw new Error(
          `Config 'memoryInjection.position' must be one of: ` +
            `${VALID_POSITIONS.join(", ")}. Got: ${JSON.stringify(mi.position)}`
        );
      }
      memoryInjection.position = mi.position as typeof memoryInjection.position;
    }

    if (mi.template !== undefined) {
      if (typeof mi.template !== "string" || mi.template.length === 0) {
        throw new Error(
          "Config 'memoryInjection.template' must be a non-empty string"
        );
      }
      memoryInjection.template = mi.template;
    }
  }

  return {
    wecloneApiUrl: obj.wecloneApiUrl,
    wecloneModelName,
    proxyPort: obj.proxyPort,
    proxyBindHost,
    allowPublicBind,
    remnicDaemonUrl: obj.remnicDaemonUrl,
    remnicAuthToken,
    sessionStrategy,
    memoryInjection,
    maxRequestBytes: parseOptionalPositiveInteger(obj, "maxRequestBytes"),
    maxResponseBytes: parseOptionalPositiveInteger(obj, "maxResponseBytes"),
    streamObservationMaxBytes: parseOptionalPositiveInteger(obj, "streamObservationMaxBytes"),
  };
}
