/**
 * Endpoint facts read out of an installed daemon service unit.
 *
 * The gateway does not inherit the daemon's environment, so a systemd unit or
 * launchd plist is often the only place the live endpoint is written down:
 * `REMNIC_CONFIG_PATH`, `REMNIC_HOST`/`PORT`/`AUTH_TOKEN`, and the equivalent
 * `remnic-server` command-line flags. Parsing lives here rather than in
 * bridge.ts so the host-detection module stays under its size cap.
 */

import fs from "node:fs";
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
/**
 * The EFFECTIVE value of every systemd directive this module reads, after
 * drop-in merging.
 *
 * Drop-ins are concatenated after the base unit, so applying them means
 * replaying the assignments in order with systemd's own reset rule: a
 * directive assigned an EMPTY value clears everything accumulated for it so
 * far, and a later non-empty assignment supersedes an earlier one. Reading
 * only the first match — as this module used to — returns the base unit's
 * value for exactly the units an administrator has overridden.
 */
function readEffectiveDirectives(unit: string): {
  env: Map<string, string>;
  execStart: string[];
  workingDirectory: string | undefined;
} {
  const env = new Map<string, string>();
  const execStart: string[] = [];
  let workingDirectory: string | undefined;
  for (const line of unit.split("\n")) {
    const directive = /^\s*(Environment|ExecStart|WorkingDirectory)=(.*)$/.exec(line);
    if (directive === null) continue;
    const [, name, rawValue = ""] = directive;
    const value = rawValue.trim();
    if (name === "Environment") {
      // A bare `Environment=` resets the whole environment block.
      if (value === "") {
        env.clear();
        continue;
      }
      // systemd allows SEVERAL assignments per directive, quoted or bare:
      //   Environment=NAME=value
      //   Environment="NAME=value" "OTHER=value"
      // so every directive is tokenized rather than matched as one assignment.
      for (const rawToken of value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) {
        const token = /^(["']).*\1$/.test(rawToken) ? rawToken.slice(1, -1) : rawToken;
        const split = token.indexOf("=");
        if (split <= 0) continue;
        env.set(token.slice(0, split), token.slice(split + 1));
      }
      continue;
    }
    if (name === "ExecStart") {
      // `ExecStart=` resets the command list; `systemctl edit` pairs that
      // reset with the replacement command on the next line.
      if (value === "") {
        execStart.length = 0;
        continue;
      }
      execStart.push(value);
      continue;
    }
    workingDirectory = value === "" ? undefined : value;
  }
  return { env, execStart, workingDirectory };
}

function readUnitEnv(
  unit: string,
  name: string,
  scope: UnitScope,
): string | undefined {
  const systemdValue = readEffectiveDirectives(unit).env.get(name);
  const systemd = systemdValue === undefined ? null : [undefined, systemdValue];
  // launchd: <key>NAME</key><string>value</string>
  const launchdRaw = new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`).exec(unit);
  const launchd = launchdRaw === null ? null : [undefined, decodePlistString(launchdRaw[1] ?? "")];
  const raw = (systemd?.[1] ?? launchd?.[1])?.trim();
  if (raw === undefined) return undefined;
  // An EMPTY assignment is present-but-blank. The server reads it as set, so
  // it overrides nothing but also stops the legacy variable from applying;
  // returning `undefined` here would let a stale `ENGRAM_*` win instead.
  if (raw === "") return "";
  // `%h` AND a leading `~` are both account-relative. For a user unit the
  // account is ours; for a SYSTEM unit it is whatever `User=` names, which
  // this process cannot resolve — expanding either against the gateway's home
  // would read a different account's file than the daemon did.
  if (!scope.userScoped && (raw.includes("%") || raw.startsWith("~"))) return undefined;
  return expandAccountRelative(raw, scope);
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
/**
 * Decode the XML entities a plist stores values with. launchd hands the daemon
 * the DECODED value, so reading the encoded text would compare a different
 * path, endpoint, or credential than the one actually in use.
 */
/**
 * Expand the account-relative spellings against the UNIT's account rather than
 * the ambient `HOME`: `%h` is systemd's specifier and a leading `~` means the
 * same thing. Callers reject both for a system unit before getting here, since
 * that account is unknowable from this process.
 */
function expandAccountRelative(value: string, scope: UnitScope): string {
  const withSpecifier = value.replace(/%h/g, scope.homeDir);
  if (withSpecifier === "~") return scope.homeDir;
  if (withSpecifier.startsWith("~/")) return path.join(scope.homeDir, withSpecifier.slice(2));
  return withSpecifier;
}

function decodePlistString(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // `&amp;` LAST so an encoded `&amp;lt;` does not become `<`.
    .replace(/&amp;/g, "&");
}

function readUnitWorkingDirectory(unit: string): string | undefined {
  const systemd = readEffectiveDirectives(unit).workingDirectory;
  const launchdRaw = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(unit)?.[1];
  const launchd = launchdRaw === undefined ? undefined : decodePlistString(launchdRaw).trim();
  const raw = systemd ?? launchd;
  if (raw === undefined || raw === "") return undefined;
  return /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
}

function readUnitCliOverrides(
  unit: string,
  scope: UnitScope,
): UnitEndpoint {
  const tokens: string[] = [];
  // Every command that survived the resets, in order. A `Type=oneshot` unit
  // may legitimately keep several, and `readFlag` takes the last occurrence
  // across all of them — which is also what a replacement command needs.
  for (const command of readEffectiveDirectives(unit).execStart) {
    tokens.push(...(command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []));
  }
  const programArgs = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(unit);
  if (programArgs?.[1]) {
    for (const entry of programArgs[1].matchAll(/<string>([^<]*)<\/string>/g)) {
      tokens.push(decodePlistString(entry[1] ?? ""));
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
    // Same account-scope rule as the environment reader, `~` included.
    if (!scope.userScoped && (value.includes("%") || value.startsWith("~"))) return undefined;
    return expandAccountRelative(value, scope);
  };
  const configPath = expand(readFlag("--config"));
  // The server resolves a relative `--config` against its own cwd, which the
  // unit sets. Discarding it would hide that config's host, port, and token.
  const resolvedConfig =
    configPath === undefined
      ? undefined
      : resolveAgainstWorkingDirectory(
          configPath,
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
    const resolved = resolveAgainstWorkingDirectory(raw, workingDirectory, scope);
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
  if (!scope.userScoped && (workingDirectory.includes("%") || workingDirectory.startsWith("~"))) {
    return undefined;
  }
  const expanded = expandAccountRelative(workingDirectory, scope);
  if (!path.isAbsolute(expanded)) return undefined;
  return path.resolve(expanded, candidate);
}

/**
 * The base unit file and drop-in directories for each named SYSTEM unit,
 * following systemd's load-path rules.
 *
 * The base unit is the HIGHEST-precedence file that exists — `/etc` masks
 * `/run` masks `/usr/lib`. Drop-in directories come from every load path,
 * because `systemctl edit` writes its override under `/etc` even when the
 * packaged unit ships in `/usr/lib`; deriving the drop-in directory from the
 * base unit's own location alone would miss exactly the administrator
 * customization that matters.
 *
 * @param unitDirs load path in ASCENDING precedence
 */
export function resolveSystemUnitSources(
  unitDirs: readonly string[],
  unitNames: readonly string[],
  exists: (candidate: string) => boolean = (candidate) => fs.existsSync(candidate),
): Array<{ unitPath: string; dropInDirs: string[] }> {
  const sources: Array<{ unitPath: string; dropInDirs: string[] }> = [];
  for (const name of unitNames) {
    const unitPath = [...unitDirs]
      .reverse()
      .map((dir) => path.join(dir, name))
      .find((candidate) => exists(candidate));
    if (unitPath === undefined) continue;
    sources.push({ unitPath, dropInDirs: unitDirs.map((dir) => path.join(dir, `${name}.d`)) });
  }
  return sources;
}
