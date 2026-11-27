# Bridge `auto` mode is decided by one validated preflight walk under a single shared deadline

Status: accepted

## Context
When `bridgeMode` is `auto` (issue #2120) the plugin must decide between delegating to a daemon and starting embedded beside a daemon that may already be running with the same corpus. Library consumers reach this entry point directly, bypassing the config parser, so nothing upstream validates their arguments. Registration is synchronous, so probing several candidate endpoints for the full budget each would hold gateway startup for a multiple of it, and installed-unit candidates deliberately precede cwd/home candidates, so one stale endpoint that accepts a connection and stalls would otherwise starve the live daemon behind it. A same-host daemon is reachable both through a loopback rewrite and through its configured interface address, and those are aliases of one daemon, not two probes' worth of work. A blank corpus can never match, and a non-positive budget would silently skip every probe — either failure would select embedded beside the running daemon the detector exists to find (AGENTS.md §1). The public probe rejects non-positive budgets outright, and a spent budget must not surface as a thrown configuration error from inside the walk.

## Decision
- Explicit overrides are the caller's job; `auto` only decides when the caller did not override. Requiring a corpus is part of `auto`: a blank corpus is rejected as the invalid argument it is, never answered with a mode decision.
- The probe budget (`bridgeHealthTimeoutMs`) is validated for EVERY mode, at the range the config parser enforces: zero, negative, or non-finite values are rejected, not reinterpreted.
- All probes share ONE total deadline. Each unprobed endpoint group gets a share of what is left rather than the whole budget; the share is computed over groups still unprobed, so the last group can use everything that remains.
- The loopback and interface addresses of ONE daemon share a single allocation, and the second dial happens only when the first REFUSES. A readiness stall is not something a different token fixes, so the first attempt gets the whole slice — reserving half for a retry would cut short a daemon that is still warming up.
- Retry only on an actual authentication rejection, and only with a different credential: the gateway token store outranking the config file inside credential loading is wrong for a daemon running under another account with a static `server.authToken`.
- The walk notices an elapsed slice itself; an exhausted budget degrades the walk, it never reaches the public probe as a non-positive budget and never throws a configuration error.
- The resolved endpoint carries the config file it came from, so the credential tier is bound to the file discovery actually read.

## Consequences
- A stalling stale endpoint can no longer starve the live daemon behind it; worst-case registration cost is one budget, not a multiple of it.
- Invalid caller arguments surface as boundary errors instead of silently binding an embedded runtime beside a running daemon.
- Stages that run after a slow first probe get less time; a genuinely slow-but-alive daemon late in the candidate order may be missed within one budget.
- `1` ms remains the supported minimum budget and is expected to exhaust immediately.

## Origin comments
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2458` — "// Readable HERE, so refusing it must come from the account-scope rule and"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2459` — "// not merely from a missing file."
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2572` — "// daemon would otherwise 401 every delegated route until the GATEWAY also"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2573` — "// restarted, because the value detection succeeded with was frozen."
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2709` — "// gateway restarted."
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2860` — "// Both are required arguments a library consumer can get wrong. A blank"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2861` — "// corpus can never match, so the walk would answer `embedded` — an invalid"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2862` — "// argument dressed up as a mode decision. A non-finite budget survives to"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2863` — "// `Atomics.wait` as an UNBOUNDED wait on the caller's main thread."
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2889` — "// preferring it would dial a server nobody is running — and bind the"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2959` — "// An undefined variable stays literal, and is then discarded as a bad port"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:2960` — "// rather than being guessed at."
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:3015` — "// The public probe rejects a non-positive budget — correctly — so the walk"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:3016` — "// must notice an elapsed slice itself rather than turning a spent budget"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:3017` — "// into a thrown configuration error. `bridgeHealthTimeoutMs: 1` is the"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:3018` — "// supported minimum and crosses that line immediately."
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:3056` — "// An XDG override is scanned ALONGSIDE its default, not instead of it: the"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:3057` — "// variables come from the gateway's environment, and the daemon's user"
- `packages/plugin-openclaw/src/bridge-auto-mode.test.ts:3058` — "// manager may have been started with different ones — or none."
- `packages/plugin-openclaw/src/bridge.ts:79` — "/** * Same daemon, different dial address: a same-host loopback rewrite and the * configured interface address are alias"
- `packages/plugin-openclaw/src/bridge.ts:98` — "/** * The configured interface address behind a same-host loopback rewrite, * dialed only when the loopback probe fails:"
- `packages/plugin-openclaw/src/bridge.ts:104` — "/** * True when this resolution already proved the daemon healthy. `auto` does, * as part of its corpus-identity probe; "
- `packages/plugin-openclaw/src/bridge.ts:195` — "/** * Validate a caller-supplied probe budget, in the same range the config * parser enforces. Shared so the public dete"
- `packages/plugin-openclaw/src/bridge.ts:558` — "/** * Same-host daemon detection for `bridgeMode: "auto"` (issue #2120). * * Explicit overrides are the CALLER's job — `"
- `packages/plugin-openclaw/src/bridge.ts:599` — "// `bridgeHealthTimeoutMs` is documented as the TOTAL preflight budget, and"
- `packages/plugin-openclaw/src/bridge.ts:600` — "// registration is synchronous — probing several stale endpoints for the full"
- `packages/plugin-openclaw/src/bridge.ts:601` — "// budget each would hold gateway startup for a multiple of it. Every probe"
- `packages/plugin-openclaw/src/bridge.ts:602` — "// shares one deadline."
- `packages/plugin-openclaw/src/bridge.ts:603` — "// A library consumer reaches this entry point directly, bypassing the config"
- `packages/plugin-openclaw/src/bridge.ts:604` — "// parser. An invalid budget must be REJECTED, not reinterpreted: zero or a"
- `packages/plugin-openclaw/src/bridge.ts:605` — "// negative silently skips every probe and selects embedded beside a running"
- `packages/plugin-openclaw/src/bridge.ts:606` — "// same-corpus daemon, which is the exact failure this detector exists to"
- `packages/plugin-openclaw/src/bridge.ts:607` — "// prevent (AGENTS.md §1)."
- `packages/plugin-openclaw/src/bridge.ts:608` — "// Same reasoning as the budget: a library consumer reaches this entry point"
- `packages/plugin-openclaw/src/bridge.ts:609` — "// directly. A blank corpus can never match, so the walk would return"
- `packages/plugin-openclaw/src/bridge.ts:610` — "// `embedded` — an invalid required argument dressed up as a mode decision,"
- `packages/plugin-openclaw/src/bridge.ts:611` — "// which binds an embedded runtime beside the daemon the caller meant to find."
- `packages/plugin-openclaw/src/bridge.ts:649` — "// Cap each probe at a SHARE of what is left rather than handing it the"
- `packages/plugin-openclaw/src/bridge.ts:650` — "// whole budget. Installed-unit candidates deliberately precede cwd/home,"
- `packages/plugin-openclaw/src/bridge.ts:651` — "// so one stale endpoint that accepts a connection and stalls would"
- `packages/plugin-openclaw/src/bridge.ts:652` — "// otherwise eat the entire preflight and the live daemon behind it would"
- `packages/plugin-openclaw/src/bridge.ts:653` — "// never be dialed. The share is over the endpoint GROUPS still unprobed,"
- `packages/plugin-openclaw/src/bridge.ts:654` — "// so the last group can still use everything that remains — and the"
- `packages/plugin-openclaw/src/bridge.ts:655` — "// loopback/interface aliases of ONE daemon share a single allocation"
- `packages/plugin-openclaw/src/bridge.ts:656` — "// instead of halving it, since the second dial only happens when the"
- `packages/plugin-openclaw/src/bridge.ts:657` — "// first REFUSES (which costs no time)."
- `packages/plugin-openclaw/src/bridge.ts:666` — "// BOTH attempts share this group's slice, so one stalling endpoint with a"
- `packages/plugin-openclaw/src/bridge.ts:667` — "// fallback credential cannot burn two shares and starve the healthy daemon"
- `packages/plugin-openclaw/src/bridge.ts:668` — "// behind it. The FIRST attempt gets the whole slice: reserving half for a"
- `packages/plugin-openclaw/src/bridge.ts:669` — "// retry would cut short a daemon that is merely still warming up, and a"
- `packages/plugin-openclaw/src/bridge.ts:670` — "// readiness stall is not something a different token fixes."
- `packages/plugin-openclaw/src/bridge.ts:672` — "// The clock can cross the deadline between deriving it and spending it —"
- `packages/plugin-openclaw/src/bridge.ts:673` — "// trivially so at the supported minimum budget of 1ms. The public probe"
- `packages/plugin-openclaw/src/bridge.ts:674` — "// REJECTS a non-positive budget, and rightly so, but reaching it with one"
- `packages/plugin-openclaw/src/bridge.ts:675` — "// here would turn an exhausted budget into a thrown configuration error."
- `packages/plugin-openclaw/src/bridge.ts:691` — "// Retry ONLY on an actual authentication rejection, and only with a"
- `packages/plugin-openclaw/src/bridge.ts:692` — "// different credential: the gateway's token store outranks a config file"
- `packages/plugin-openclaw/src/bridge.ts:693` — "// inside `loadDaemonAuth`, which is wrong for a daemon running under"
- `packages/plugin-openclaw/src/bridge.ts:694` — "// another account with a static `server.authToken`."
- `packages/plugin-openclaw/src/bridge.ts:749` — "/** * The mode the deployment ASKED for, without probing anything. * * Split out so a caller can tell "delegate was atte"
- `packages/plugin-openclaw/src/bridge.ts:793` — "/** * Whether this deployment was asking for delegate at all. * * An unparseable bridgeMode is itself the thing the oper"
- `packages/plugin-openclaw/src/bridge.ts:808` — "/** * Resolve the bridge mode for the plugin runtime (issue #2120). * * Precedence is env override > plugin config > `em"
- `packages/plugin-openclaw/src/bridge.ts:823` — "// Validated for EVERY mode, not just the branch that spends it: an invalid"
- `packages/plugin-openclaw/src/bridge.ts:824` — "// budget is a caller bug, and accepting it silently on an explicit mode"
- `packages/plugin-openclaw/src/bridge.ts:825` — "// would make the same value an error only after someone flips to `auto`."
