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
 * Physical lines joined into LOGICAL ones, the way systemd.syntax specifies:
 * a trailing backslash continues the directive on the next line, and the
 * backslash-newline is replaced by a space. Parsing physical lines would drop
 * a wrapped `--port`, `--config`, or credential — values the daemon receives
 * but detection would not see.
 */
function foldContinuationLines(unit: string): string[] {
  const logical: string[] = [];
  let pending: string | undefined;
  for (const raw of unit.split("\n")) {
    const line = raw.replace(/\r$/, "");
    // An ODD number of trailing backslashes continues; an even count is an
    // escaped backslash that ends the line.
    const trailing = /(\\*)$/.exec(line)?.[1]?.length ?? 0;
    const continues = trailing % 2 === 1;
    const body = continues ? line.slice(0, -1) : line;
    pending = pending === undefined ? body : `${pending} ${body.trim()}`;
    if (continues) continue;
    logical.push(pending);
    pending = undefined;
  }
  // A file ending mid-continuation still contributes what it had.
  if (pending !== undefined) logical.push(pending);
  return logical;
}

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
  envFiles: string[];
  unsetEnv: string[];
  execStart: string[];
  workingDirectory: string | undefined;
} {
  const env = new Map<string, string>();
  const envFiles: string[] = [];
  const unsetEnv: string[] = [];
  const execStart: string[] = [];
  let workingDirectory: string | undefined;
  for (const line of foldContinuationLines(unit)) {
    const directive =
      /^\s*(Environment|EnvironmentFile|UnsetEnvironment|ExecStart|WorkingDirectory)=(.*)$/.exec(
        line,
      );
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
    if (name === "EnvironmentFile") {
      // An empty assignment resets the FILE LIST, like every other list-type
      // setting. Several paths may be listed per directive.
      if (value === "") {
        envFiles.length = 0;
        continue;
      }
      for (const rawToken of value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) {
        const token = /^(["']).*\1$/.test(rawToken) ? rawToken.slice(1, -1) : rawToken;
        // A leading `-` marks the file optional; it is not part of the path.
        envFiles.push(token.startsWith("-") ? token.slice(1) : token);
      }
      continue;
    }
    if (name === "UnsetEnvironment") {
      // Applied as the FINAL environment-building step (systemd.exec), after
      // every `Environment=` and `EnvironmentFile=`, so it is only collected
      // here. An empty assignment resets the removal list.
      if (value === "") {
        unsetEnv.length = 0;
        continue;
      }
      for (const rawToken of value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) {
        unsetEnv.push(/^(["']).*\1$/.test(rawToken) ? rawToken.slice(1, -1) : rawToken);
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
  return { env, envFiles, unsetEnv, execStart, workingDirectory };
}

/**
 * Parse a systemd environment file: `NAME=value` lines, `#`/`;` comments,
 * optionally quoted values.
 */
function parseEnvironmentFile(body: string): Map<string, string> {
  const parsed = new Map<string, string>();
  // Environment files take continuation lines too: systemd drops the
  // backslash-newline pair and hands the daemon one joined value, so reading
  // physical lines would record the first fragment WITH its trailing `\` and
  // silently discard the rest of a long path or credential.
  for (const line of foldContinuationLines(body)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const split = trimmed.indexOf("=");
    if (split <= 0) continue;
    const key = trimmed.slice(0, split).trim();
    const raw = trimmed.slice(split + 1).trim();
    parsed.set(key, /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw);
  }
  return parsed;
}

/**
 * The unit's effective environment: inline `Environment=` assignments with
 * every `EnvironmentFile=` merged over them.
 *
 * systemd.exec is explicit that "settings from these files override settings
 * made with Environment=", regardless of the order the directives appear in,
 * and later files override earlier ones. A daemon running under another
 * account commonly keeps its credential in exactly such a file, so reading
 * only the inline assignments probes with the wrong token, reads a failure,
 * and starts an embedded orchestrator beside the live daemon.
 */
function readUnitEnvironment(
  unit: string,
  scope: UnitScope,
  readFile: (candidate: string) => string | undefined,
  listDir: (directory: string) => string[],
): Map<string, string> {
  const directives = readEffectiveDirectives(unit);
  const merged = new Map(directives.env);
  for (const candidate of directives.envFiles) {
    // Same account-scope rule as every other unit-supplied path.
    const expandedFile = expandAccountRelative(candidate, scope);
    if (!scope.userScoped && (expandedFile.includes("%") || expandedFile.startsWith("~"))) continue;
    const resolved = settleUnitValue(expandedFile);
    // systemd requires an absolute path here; anything else cannot be read in
    // the daemon's frame with any confidence.
    if (!path.isAbsolute(resolved)) continue;
    // `EnvironmentFile=` accepts a wildcard expression as well as a plain
    // filename, so a unit pointing at `/etc/remnic/*.env` must contribute the
    // files systemd actually loads, not a literal path that reads as missing.
    for (const match of expandEnvironmentFilePattern(resolved, listDir)) {
      const body = readFile(match);
      if (body === undefined) continue;
      for (const [key, value] of parseEnvironmentFile(body)) merged.set(key, value);
    }
  }
  // LAST, per systemd.exec: `UnsetEnvironment=` is the final environment-
  // building step, so it removes an assignment whichever tier supplied it. A
  // unit that removes `REMNIC_PORT` leaves the daemon on its config's value —
  // keeping the stale assignment would probe the wrong endpoint.
  for (const name of directives.unsetEnv) {
    // The `NAME=value` spelling removes only that exact assignment.
    const split = name.indexOf("=");
    if (split <= 0) {
      merged.delete(name);
      continue;
    }
    const key = name.slice(0, split);
    if (merged.get(key) === name.slice(split + 1)) merged.delete(key);
  }
  return merged;
}

/**
 * The files a single `EnvironmentFile=` entry names.
 *
 * A plain filename is itself; a wildcard expression matches within its
 * directory, in the sorted order systemd applies. Only the FINAL segment may
 * be a pattern, which matches systemd's own globbing of this setting.
 */
function expandEnvironmentFilePattern(
  candidate: string,
  listDir: (directory: string) => string[],
): string[] {
  if (!/[*?[]/.test(candidate)) return [candidate];
  const directory = path.dirname(candidate);
  const pattern = path.basename(candidate);
  if (/[*?[]/.test(directory)) return [];
  const matcher = new RegExp(
    `^${pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`,
  );
  return listDir(directory)
    .filter((entry) => matcher.test(entry))
    .sort()
    .map((entry) => path.join(directory, entry));
}

function defaultUnitDirLister(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function defaultUnitFileReader(candidate: string): string | undefined {
  try {
    return fs.readFileSync(candidate, "utf8");
  } catch {
    // An unreadable file contributes nothing — `EnvironmentFile=-path` is the
    // documented spelling for that, and an unreadable required one only means
    // this process cannot see what the daemon saw.
    return undefined;
  }
}

function readUnitEnv(
  unit: string,
  name: string,
  scope: UnitScope,
  readFile: (candidate: string) => string | undefined = defaultUnitFileReader,
  listDir: (directory: string) => string[] = defaultUnitDirLister,
): string | undefined {
  const systemdValue = readUnitEnvironment(unit, scope, readFile, listDir).get(name);
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
  const expanded = expandAccountRelative(raw, scope);
  // Only what is STILL unresolved is refused: `%h` and `~` name the account a
  // system unit's `User=` selects, which this process cannot know. The
  // directory specifiers resolve for either manager.
  if (!scope.userScoped && (expanded.includes("%") || expanded.startsWith("~"))) return undefined;
  return settleUnitValue(expanded);
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
  const withSpecifier = expandUnitSpecifiers(value, scope);
  // `~` is expanded ONLY for a user unit, exactly like `%h`. Leaving it
  // literal for a system unit is what lets the callers' guard refuse it: that
  // account is whatever `User=` names, which this process cannot resolve.
  if (!scope.userScoped) return withSpecifier;
  if (withSpecifier === "~") return scope.homeDir;
  if (withSpecifier.startsWith("~/")) return path.join(scope.homeDir, withSpecifier.slice(2));
  return withSpecifier;
}

/**
 * systemd path specifiers, resolved for the unit's own manager.
 *
 * The DIRECTORY specifiers are account-independent for a system unit
 * (`%E` is `/etc`, `%S` is `/var/lib`, …) and account-relative for a user one,
 * so a system unit can resolve them even though `%h` remains unknowable there.
 * Only `%%` needs escaping, and it is handled last so an escaped percent never
 * introduces a specifier.
 */
const ESCAPED_PERCENT = "\u0000remnic-escaped-percent\u0000";

/**
 * `%t` for a user manager is the account's own runtime directory —
 * `/run/user/<uid>`, not the shared `/run/user` parent. The gateway runs as
 * the same account a user unit does, so its uid is the right one; without
 * `getuid` (Windows) there is no such directory to name.
 */
function userRuntimeDir(): string {
  const getuid = (globalThis.process as { getuid?: () => number } | undefined)?.getuid;
  const uid = typeof getuid === "function" ? getuid.call(globalThis.process) : undefined;
  return uid === undefined ? "/run/user" : `/run/user/${uid}`;
}

/** Restore literal percents, once the unresolved-specifier guard has run. */
function settleUnitValue(value: string): string {
  return value.replaceAll(ESCAPED_PERCENT, "%");
}

function expandUnitSpecifiers(value: string, scope: UnitScope): string {
  const home = scope.homeDir;
  const env = (globalThis.process as { env?: Record<string, string | undefined> } | undefined)?.["env"];
  const xdg = (name: string, fallback: string): string => {
    const configured = scope.userScoped ? env?.[name] : undefined;
    return configured !== undefined && configured.trim() !== "" ? configured : fallback;
  };
  const directories: Record<string, string> = scope.userScoped
    ? {
        E: xdg("XDG_CONFIG_HOME", path.join(home, ".config")),
        S: xdg("XDG_STATE_HOME", path.join(home, ".local", "state")),
        C: xdg("XDG_CACHE_HOME", path.join(home, ".cache")),
        L: path.join(xdg("XDG_STATE_HOME", path.join(home, ".local", "state")), "log"),
        t: xdg("XDG_RUNTIME_DIR", userRuntimeDir()),
      }
    : { E: "/etc", S: "/var/lib", C: "/var/cache", L: "/var/log", t: "/run" };
  // An escaped `%%` becomes a placeholder rather than a literal `%`, so the
  // callers' "anything still unresolved?" guard cannot mistake it for a
  // specifier this process failed to expand. `settleUnitValue` restores it
  // once that check has passed.
  return value.replace(/%(.)/g, (match, specifier: string) => {
    if (specifier === "%") return ESCAPED_PERCENT;
    if (specifier === "h") return scope.userScoped ? home : match;
    return directories[specifier] ?? match;
  });
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
  readFile: (candidate: string) => string | undefined,
  listDir: (directory: string) => string[],
): UnitEndpoint {
  const tokens: string[] = [];
  // systemd substitutes `$VAR` and `${VAR}` in a command line from the unit's
  // own environment before launching, so a `--port ${PORT}` reaches the daemon
  // as a number. Leaving it literal makes `coercePort` discard it and sends
  // detection to the default endpoint instead of the running one.
  const environment = readUnitEnvironment(unit, scope, readFile, listDir);
  // Substitution happens AFTER tokenization, per token: systemd expands a
  // variable into exactly ONE argument, so a value containing whitespace
  // ("alpha beta") must not split into two. Splitting it truncated a
  // credential to its first word and 401ed the probe.
  const substitute = (token: string): string =>
    token.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (match, braced, bare) =>
      environment.get(braced ?? bare) ?? match,
    );
  // Every command that survived the resets, in order. A `Type=oneshot` unit
  // may legitimately keep several, and `readFlag` takes the last occurrence
  // across all of them — which is also what a replacement command needs.
  for (const command of readEffectiveDirectives(unit).execStart) {
    for (const token of command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) {
      tokens.push(substitute(token));
    }
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
    const expanded = expandAccountRelative(value, scope);
    if (!scope.userScoped && (expanded.includes("%") || expanded.startsWith("~"))) return undefined;
    return settleUnitValue(expanded);
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
  /** Injected in tests; reads a unit's `EnvironmentFile=` from disk. */
  readFile: (candidate: string) => string | undefined = defaultUnitFileReader,
  /** Injected in tests; lists a directory for `EnvironmentFile=` wildcards. */
  listDir: (directory: string) => string[] = defaultUnitDirLister,
): UnitEndpoint {
  // The server accepts --host/--port/--auth-token/--config on its command line
  // and they win over both its config file and its environment, so a unit that
  // launches it that way is the only place the endpoint is written down.
  const cli = readUnitCliOverrides(unit, scope, readFile, listDir);
  // `??` on the PRIMARY spelling only when it is absent entirely — a blank
  // primary shadows the legacy one exactly as it does for the server.
  const envOverride = (primary: string, legacy: string): string | undefined => {
    const value = readUnitEnv(unit, primary, scope, readFile, listDir);
    if (value !== undefined) return value === "" ? undefined : value;
    const legacyValue = readUnitEnv(unit, legacy, scope, readFile, listDir);
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
    ...resolveUnitConfigPathInner(unit, scope, readFile, listDir),
    ...configFromCli,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(authToken === undefined ? {} : { authToken }),
  };
}

function resolveUnitConfigPathInner(
  unit: string,
  scope: UnitScope,
  readFile: (candidate: string) => string | undefined,
  listDir: (directory: string) => string[],
): { configPath?: string } {
  // The daemon resolves a relative REMNIC_CONFIG_PATH against its own cwd,
  // exactly as it does for `--config`, so the unit's working directory is the
  // frame here too. Discarding it would lose that config's endpoint AND its
  // credential.
  const workingDirectory = readUnitWorkingDirectory(unit);
  for (const name of ["REMNIC_CONFIG_PATH", "ENGRAM_CONFIG_PATH"]) {
    const raw = readUnitEnv(unit, name, scope, readFile, listDir);
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
  const expanded = settleUnitValue(expandAccountRelative(workingDirectory, scope));
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
