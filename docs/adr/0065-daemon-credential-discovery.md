# Daemon credentials are discovered from the daemon's own unit and config files and re-read fresh per request

Status: accepted

## Context
The gateway process does not inherit the daemon service unit's environment, so a token written in a unit (or its drop-ins) is invisible to ordinary config resolution. Administrators rotate or delete `REMNIC_AUTH_TOKEN` in units while the gateway runs, canonical and legacy unit names coexist during migration and either may be the active service, and credential loading ranks the gateway's own token store above a config file — which is wrong for a daemon running under another account with a static `server.authToken`. Rescanning config per request can also pair an endpoint with a different file's token than the one discovery resolved, which the daemon answers with a 401 that reads as "no daemon".

## Decision
- Enumerate EVERY distinct installed unit, not the first: canonical and legacy units coexist during migration and the inactive one can sort first. An XDG override is scanned ALONGSIDE its default, not instead of it; duplicates are dropped preserving discovery order.
- A unit is remembered as the credential source for EVERY endpoint it describes, not only endpoints that name a token today, so a token added later has a source to re-read from.
- Read the credential FRESH for each delegated request. A drop-in rotation outranks the base unit.
- A readable unit that no longer names a token is a DELIBERATE removal: fall through to normal resolution — the bound config file first — rather than replaying a credential nobody serves.
- An UNREADABLE unit proves nothing: keep the last value that actually authenticated instead of sending none.
- A unit-supplied credential has no other source and is carried by value; a config-supplied credential is re-read from its own file. The endpoint's credential is bound to the SAME config file discovery resolved (the first existing candidate), never reassigned by a rescan that might find a later file.
- On an authorization refusal, retry once after resolving the credential again; report the auth status as auth, never as a network outage.
- Unit directories are absolute, so unit/config probes are injectable for tests; test environments isolate HOME and the daemon-auth environment so each resolution branch is hit exactly.

## Consequences
- Token rotation in a unit, drop-in, or config file propagates to delegated requests without a gateway restart; deleting a token stops replay on the next request.
- One extra read of the unit or config per delegated request.
- A removed credential now 401s (named as auth) instead of silently replaying a stale value; an unreadable unit degrades to the frozen fallback rather than failing closed.
- Discovery order and dedup semantics become load-bearing for tests; seams are required because system unit directories cannot be redirected.

## Origin comments
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2454` — "// wrong token, reads a failure, and starts an orchestrator beside it."
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2571` — "// An administrator who rotates the token in the unit and restarts the"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2600` — "// A drop-in rotation counts too, and outranks the base unit."
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2609` — "// A readable unit that no longer names a token is a DELIBERATE removal:"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2610` — "// the daemon has fallen back to its config or token store, and the caller"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2611` — "// must too rather than replaying a credential nobody serves."
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2616` — "// An UNREADABLE unit proves nothing, so the caller keeps the last value"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2617` — "// that actually authenticated instead of sending none."
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2706` — "// An administrator who deletes `REMNIC_AUTH_TOKEN` from a still-readable"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2707` — "// unit has moved the daemon onto its config or token store. Replaying the"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2708` — "// credential the probe authenticated with would 401 every route until the"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2734` — "// Token removed, unit still readable: fall through to normal resolution."
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2738` — "// Unit unreadable: nothing is proven, so the last working value stands."
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2886` — "// `remnic-server`'s `resolveConfigPath` takes the FIRST EXISTING candidate"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2887` — "// and `parseServerConfig` defaults its missing fields to 127.0.0.1:4318. A"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2888` — "// later file that declares an endpoint is not the daemon's config, so"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2890` — "// credential to the wrong file."
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:3111` — "// With no `--config` and no `REMNIC_CONFIG_PATH`, the server auto-selects"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:3112` — "// `<cwd>/remnic.config.json`, and the unit sets that cwd. Reporting no"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:3113` — "// config path skipped the unit entirely, hiding its endpoint."
- `packages/plugin-openclaw/src/bridge-health-worker.ts:49` — "// The caller must not report an HTTP auth response as a network outage."
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:29` — "/** Preserve order, drop repeats — the XDG default and its override can agree. */"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:133` — "/** * A unit's credential, read FRESH. * * Delegate requests call this per request rather than reusing the value * detec"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:145` — "// The two outcomes are NOT the same. A unit this process can no longer read"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:146` — "// proves nothing, so the caller keeps the credential that last worked. A"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:147` — "// readable unit that supplies no token is a deliberate removal: the daemon"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:148` — "// has fallen back to its config or token store, and so must the caller."
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:159` — "/** * Every installed unit's endpoint hints, in discovery order. * * `exists` is injectable for the same reason `resolve"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:200` — "// EVERY distinct unit, not the first: canonical and legacy units coexist"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:201` — "// during migration, and the inactive one can sort first. Stopping there"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:202` — "// would hide the running daemon's endpoint from the candidate walk."
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:229` — "// The UNIT is part of the identity now that credentials are re-read"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:230` — "// from it per request. Canonical and legacy units can start out"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:231` — "// identical while either is the active service; dropping the second"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:232` — "// would pin refresh to a unit that may never change again while the"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:233` — "// active one rotates its token."
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:237` — "// The unit is remembered for EVERY endpoint it describes, not just one"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:238` — "// that names a token today: an administrator who later adds"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:239` — "// `REMNIC_AUTH_TOKEN` to the unit (or a drop-in) needs a source to"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:240` — "// re-read, or delegated requests keep sending the old config credential"
- `packages/plugin-openclaw/src/bridge-unit-discovery.ts:241` — "// until the gateway restarts."
- `packages/plugin-openclaw/src/bridge.ts:60` — "/** * One endpoint `auto` may dial, plus the config file it came from — the * credential tier is bound to that file so a"
- `packages/plugin-openclaw/src/bridge.ts:71` — "/** * A credential the unit file supplies directly, which outranks anything the * config path resolves to. Carried onto "
- `packages/plugin-openclaw/src/bridge.ts:77` — "/** The unit that supplied `authTokenOverride`, so it can be re-read. */"
- `packages/plugin-openclaw/src/bridge.ts:87` — "/** * The credential written in this candidate's own config file, retried when * the primary (gateway token store) one i"
- `packages/plugin-openclaw/src/bridge.ts:111` — "/** * The config file the resolved endpoint came from, when discovery found one. * Delegate requests bind their credenti"
- `packages/plugin-openclaw/src/bridge.ts:117` — "/** * A credential taken from the installed unit's environment, which the * gateway does not inherit and no config file "
- `packages/plugin-openclaw/src/bridge.ts:127` — "/** * The unit `daemonAuthTokenOverride` came from. Delegate requests re-read it * per request, so rotating the token in"
- `packages/plugin-openclaw/src/bridge.ts:134` — "/** * The probe authenticated with `daemonConfigPath`'s own `server.authToken` * rather than the gateway token store. De"
- `packages/plugin-openclaw/src/bridge.ts:577` — "/** * Injectable unit-file probe. The SYSTEM unit directories are absolute, so a * caller that redirects `HOME` still di"
- `packages/plugin-openclaw/src/bridge.ts:730` — "// A unit-supplied credential has no other source, so it is carried by"
- `packages/plugin-openclaw/src/bridge.ts:731` — "// value; a config-supplied one is re-read from its file per request."
- `packages/plugin-openclaw/src/bridge.ts:735` — "// The unit rides along so the credential can be re-read per"
- `packages/plugin-openclaw/src/bridge.ts:736` — "// request; the frozen value stays as the fallback for a unit that"
- `packages/plugin-openclaw/src/bridge.ts:737` — "// later becomes unreadable."
- `packages/plugin-openclaw/src/bridge.ts:838` — "// The config the endpoint came from rides along so delegate requests bind"
- `packages/plugin-openclaw/src/bridge.ts:839` — "// their credential to the SAME file. Without it `loadDaemonAuth` rescans and"
- `packages/plugin-openclaw/src/bridge.ts:840` — "// can pair this endpoint with another file's token, which the daemon answers"
- `packages/plugin-openclaw/src/bridge.ts:841` — "// with a 401 and the plugin reads as "no daemon"."
- `packages/plugin-openclaw/src/bridge.ts:854` — "/** * The `server.authToken` a specific config file declares, read fresh. * * Delegate requests call this per request ra"
- `packages/plugin-openclaw/src/bridge.ts:950` — "// Unreadable or malformed: it names no credential. Keep looking when we"
- `packages/plugin-openclaw/src/bridge.ts:951` — "// are scanning; a caller-bound path simply has none."
- `packages/plugin-openclaw/src/delegate-daemon-target.ts:42` — "// A unit-supplied credential is re-read from its unit — including its"
- `packages/plugin-openclaw/src/delegate-daemon-target.ts:43` — "// drop-ins and `EnvironmentFile=`."
- `packages/plugin-openclaw/src/delegate-daemon-target.ts:49` — "// A unit that is no longer READABLE proves nothing, so the value the"
- `packages/plugin-openclaw/src/delegate-daemon-target.ts:56` — "// Readable and deliberately carrying no token: the daemon has fallen"
- `packages/plugin-openclaw/src/delegate-daemon-target.ts:57` — "// back to its config or token store, so fall through to the same"
- `packages/plugin-openclaw/src/delegate-daemon-target.ts:58` — "// resolution rather than replaying a credential nobody serves. The"
- `packages/plugin-openclaw/src/delegate-daemon-target.ts:59` — "// BOUND config is tried first — `loadDaemonAuth` puts the gateway's"
- `packages/plugin-openclaw/src/delegate-daemon-target.ts:60` — "// own token store ahead of it, which is wrong for a daemon running"
- `packages/plugin-openclaw/src/delegate-daemon-target.ts:61` — "// under another account and would keep 401ing after the restart."
- `packages/plugin-openclaw/src/delegate-http.ts:30` — "/** * Report an authorization refusal once, then drain the body so the socket * is reusable. */"
- `packages/plugin-openclaw/src/delegate-http.ts:47` — "/** * Retry one unauthorized request after resolving the credential again. * * OpenClaw can rotate a connector token w"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:2205` — "/** * Run `body` against a scratch HOME with the daemon-auth environment set to * exactly `env` — every name not list..."
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:4196` — "// End-to-end counterpart to the config-token rotation above: the credential"
