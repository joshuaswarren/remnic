/**
 * Endpoint facts read out of an installed daemon service unit.
 *
 * The gateway does not inherit the daemon's environment, so a systemd unit or
 * launchd plist is often the only place the live endpoint is written down:
 * `REMNIC_CONFIG_PATH`, `REMNIC_HOST`/`PORT`/`AUTH_TOKEN`, and the equivalent
 * `remnic-server` command-line flags. Parsing lives here rather than in
 * bridge.ts so the host-detection module stays under its size cap.
 */

import path from "node:path";

import { expandTildePath } from "@remnic/core";

/** A unit's account context, which decides whether `%h` can be expanded. */
export interface UnitScope {
  /** True for a per-user unit, whose service manager account is ours. */
  userScoped: boolean;
  homeDir: string;
}

export interface UnitEndpoint {
  configPath?: string;
  host?: string;
  port?: number;
  authToken?: string;
}

function coercePort(value: unknown): number | undefined {
  const parsed =
    typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : undefined;
}

/**
 * The config path a single unit file pins, or `undefined` when it pins none
 * this process can resolve.
 *
 * Exported for tests: a system unit lives under `/etc`, which a test cannot
 * write, so the account-scoping rule is verified against the unit TEXT.
 */
export function resolveUnitConfigPath(
  unit: string,
  scope: UnitScope,
): string | undefined {
  return resolveUnitEndpoint(unit, scope).configPath;
}

/**
 * Read a unit's environment assignment, or `undefined`. `%h` is systemd's HOME
 * specifier, expanded in the SERVICE MANAGER's account: ours for a user unit,
 * unknowable for a system one.
 */
function readUnitEnv(
  unit: string,
  name: string,
  scope: UnitScope,
): string | undefined {
  // systemd allows SEVERAL assignments per directive, quoted or bare:
  //   Environment=NAME=value
  //   Environment="NAME=value" "OTHER=value"
  // so every directive is tokenized rather than matched as one assignment.
  let systemdValue: string | undefined;
  for (const directive of unit.matchAll(/^\s*Environment=(.*)$/gm)) {
    for (const rawToken of directive[1]?.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) {
      const token = /^(["']).*\1$/.test(rawToken) ? rawToken.slice(1, -1) : rawToken;
      if (token.startsWith(`${name}=`)) systemdValue = token.slice(name.length + 1);
    }
  }
  const systemd = systemdValue === undefined ? null : [undefined, systemdValue];
  // launchd: <key>NAME</key><string>value</string>
  const launchd = new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`).exec(unit);
  const raw = (systemd?.[1] ?? launchd?.[1])?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!scope.userScoped && raw.includes("%")) return undefined;
  return raw.replace(/%h/g, scope.homeDir);
}

/**
 * Endpoint flags on the unit's launch command line.
 *
 * systemd puts them on `ExecStart=`; launchd lists them as `ProgramArguments`
 * strings. Both spellings accept `--flag value` and `--flag=value`. Quoting is
 * handled only to the extent the templates use it - a value in single or
 * double quotes is unwrapped - which covers everything the shipped units and
 * ordinary hand edits produce.
 */
/**
 * The unit's declared working directory: systemd `WorkingDirectory=`, launchd
 * `<key>WorkingDirectory</key>`. Relative CLI paths resolve against it exactly
 * as they do for the daemon process.
 */
function readUnitWorkingDirectory(unit: string): string | undefined {
  const systemd = /^\s*WorkingDirectory=(.+)$/m.exec(unit)?.[1]?.trim();
  const launchd = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/
    .exec(unit)?.[1]
    ?.trim();
  const raw = systemd ?? launchd;
  if (raw === undefined || raw === "") return undefined;
  return /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
}

function readUnitCliOverrides(
  unit: string,
  scope: UnitScope,
): UnitEndpoint {
  const tokens: string[] = [];
  const execStart = /^\s*ExecStart=(.+)$/m.exec(unit);
  if (execStart?.[1]) {
    tokens.push(...(execStart[1].match(/"[^"]*"|'[^']*'|\S+/g) ?? []));
  }
  const programArgs = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(unit);
  if (programArgs?.[1]) {
    for (const entry of programArgs[1].matchAll(/<string>([^<]*)<\/string>/g)) {
      tokens.push(entry[1]);
    }
  }
  const unquote = (value: string): string =>
    /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  const readFlag = (flag: string): string | undefined => {
    for (const [index, rawToken] of tokens.entries()) {
      const token = unquote(rawToken);
      if (token === flag) {
        const next = tokens[index + 1];
        if (next === undefined) continue;
        const value = unquote(next);
        // `--host --port` means --host was given no value.
        if (value.startsWith("-")) continue;
        return value;
      }
      if (token.startsWith(`${flag}=`)) return unquote(token.slice(flag.length + 1));
    }
    return undefined;
  };
  const expand = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    // Same account-scope rule as the environment reader.
    if (!scope.userScoped && value.includes("%")) return undefined;
    return value.replace(/%h/g, scope.homeDir);
  };
  const configPath = expand(readFlag("--config"));
  // The server resolves a relative `--config` against its own cwd, which the
  // unit sets. Discarding it would hide that config's host, port, and token.
  const workingDirectory = expand(readUnitWorkingDirectory(unit));
  const expandedConfig = configPath === undefined ? undefined : expandTildePath(configPath);
  const resolvedConfig =
    expandedConfig === undefined || path.isAbsolute(expandedConfig)
      ? expandedConfig
      : workingDirectory !== undefined && path.isAbsolute(workingDirectory)
        ? path.resolve(workingDirectory, expandedConfig)
        : undefined;
  const host = expand(readFlag("--host"));
  const authToken = expand(readFlag("--auth-token"));
  return {
    ...(resolvedConfig !== undefined && path.isAbsolute(resolvedConfig)
      ? { configPath: resolvedConfig }
      : {}),
    ...(host === undefined ? {} : { host }),
    ...(coercePort(expand(readFlag("--port"))) === undefined
      ? {}
      : { port: coercePort(expand(readFlag("--port"))) }),
    ...(authToken === undefined ? {} : { authToken }),
  };
}

/**
 * Everything a unit file says about the daemon's endpoint.
 *
 * The server merges `REMNIC_HOST`/`REMNIC_PORT` from its own environment OVER
 * its config file, and the gateway does not inherit that environment - so a
 * unit that sets them would otherwise leave `auto` probing the file's stale
 * default and starting a second orchestrator beside the live daemon.
 */
export function resolveUnitEndpoint(
  unit: string,
  scope: UnitScope,
): UnitEndpoint {
  // The server accepts --host/--port/--auth-token/--config on its command line
  // and they win over both its config file and its environment, so a unit that
  // launches it that way is the only place the endpoint is written down.
  const cli = readUnitCliOverrides(unit, scope);
  const host =
    cli.host ?? readUnitEnv(unit, "REMNIC_HOST", scope) ?? readUnitEnv(unit, "ENGRAM_HOST", scope);
  const port =
    cli.port ??
    coercePort(
      readUnitEnv(unit, "REMNIC_PORT", scope) ?? readUnitEnv(unit, "ENGRAM_PORT", scope),
    );
  // The server merges REMNIC_AUTH_TOKEN over `server.authToken` the same way
  // it merges host and port, so a unit that sets it is the only place the
  // gateway can learn the live credential.
  const authToken =
    cli.authToken ??
    readUnitEnv(unit, "REMNIC_AUTH_TOKEN", scope) ??
    readUnitEnv(unit, "ENGRAM_AUTH_TOKEN", scope);
  const configFromCli =
    cli.configPath === undefined ? {} : { configPath: cli.configPath };
  return {
    ...resolveUnitConfigPathInner(unit, scope),
    ...configFromCli,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(authToken === undefined ? {} : { authToken }),
  };
}

function resolveUnitConfigPathInner(
  unit: string,
  scope: UnitScope,
): { configPath?: string } {
  for (const name of ["REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH"]) {
    const raw = readUnitEnv(unit, name, scope);
    if (raw === undefined) continue;
    const resolved = expandTildePath(raw);
    if (!path.isAbsolute(resolved)) continue;
    return { configPath: resolved };
  }
  return {};
}
