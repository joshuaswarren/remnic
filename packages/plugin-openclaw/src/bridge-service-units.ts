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
  if (raw === undefined) return undefined;
  // An EMPTY assignment is present-but-blank. The server reads it as set, so
  // it overrides nothing but also stops the legacy variable from applying;
  // returning `undefined` here would let a stale `ENGRAM_*` win instead.
  if (raw === "") return "";
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
    // LAST occurrence wins: the daemon's own parser overwrites `args[key]` on
    // every repeat, so `--port 4318 --port 4813` makes it listen on 4813.
    let found: string | undefined;
    for (const [index, rawToken] of tokens.entries()) {
      const token = unquote(rawToken);
      if (token === flag) {
        const next = tokens[index + 1];
        if (next === undefined) continue;
        const value = unquote(next);
        // `--host --port` means --host was given no value.
        if (value.startsWith("-")) continue;
        found = value;
        continue;
      }
      if (token.startsWith(`${flag}=`)) found = unquote(token.slice(flag.length + 1));
    }
    return found;
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
  const resolvedConfig =
    configPath === undefined
      ? undefined
      : resolveAgainstWorkingDirectory(
          expandTildePath(configPath),
          readUnitWorkingDirectory(unit),
          scope,
        );
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
  // `??` on the PRIMARY spelling only when it is absent entirely — a blank
  // primary shadows the legacy one exactly as it does for the server.
  const envOverride = (primary: string, legacy: string): string | undefined => {
    const value = readUnitEnv(unit, primary, scope);
    if (value !== undefined) return value === "" ? undefined : value;
    const legacyValue = readUnitEnv(unit, legacy, scope);
    return legacyValue === "" ? undefined : legacyValue;
  };
  const host = cli.host ?? envOverride("REMNIC_HOST", "ENGRAM_HOST");
  const port = cli.port ?? coercePort(envOverride("REMNIC_PORT", "ENGRAM_PORT"));
  // The server merges REMNIC_AUTH_TOKEN over `server.authToken` the same way
  // it merges host and port, so a unit that sets it is the only place the
  // gateway can learn the live credential.
  const authToken = cli.authToken ?? envOverride("REMNIC_AUTH_TOKEN", "ENGRAM_AUTH_TOKEN");
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
  // The daemon resolves a relative REMNIC_CONFIG_PATH against its own cwd,
  // exactly as it does for `--config`, so the unit's working directory is the
  // frame here too. Discarding it would lose that config's endpoint AND its
  // credential.
  const workingDirectory = readUnitWorkingDirectory(unit);
  for (const name of ["REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH"]) {
    const raw = readUnitEnv(unit, name, scope);
    // A blank primary shadows the legacy spelling, same as the endpoint vars.
    if (raw === "") return {};
    if (raw === undefined) continue;
    const resolved = resolveAgainstWorkingDirectory(expandTildePath(raw), workingDirectory, scope);
    if (resolved === undefined) continue;
    return { configPath: resolved };
  }
  return {};
}

/**
 * Make a unit-supplied path absolute in the frame the daemon would use, or
 * `undefined` when this process cannot know that frame.
 */
function resolveAgainstWorkingDirectory(
  candidate: string,
  workingDirectory: string | undefined,
  scope: UnitScope,
): string | undefined {
  if (path.isAbsolute(candidate)) return candidate;
  if (workingDirectory === undefined) return undefined;
  // Same account-scope rule: a system unit's `%h` names an unknowable home.
  if (!scope.userScoped && workingDirectory.includes("%")) return undefined;
  const expanded = expandTildePath(workingDirectory.replace(/%h/g, scope.homeDir));
  if (!path.isAbsolute(expanded)) return undefined;
  return path.resolve(expanded, candidate);
}
