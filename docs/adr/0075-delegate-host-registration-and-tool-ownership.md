# Both bridge runtimes register through shared per-api ownership records, and an api's bridge mode latches at first binding

Status: accepted

## Context
The canonical and legacy plugin IDs register separately against ONE host api, service registration can span distinct api objects, the host exposes no tool unregister, and an api's memory slot may be owned by an active entry while a passive sibling (or a disabled one) registers around it. A second registration of the same tool name on one api is a host tool-name conflict, not a second tool. Meanwhile `register()` is synchronous, `auto` mode probes the daemon during registration, and OpenClaw 2.0 removed the synchronous prompt-section registration the 1.x contract used.

The detached observe/flush queueing, host command-descriptor, HTTP transport extraction, and gateway-surface notes were merged into this record as the nearest neighbour (the delegate plugin's host integration) to respect the ten-file limit.

## Decision
- Each shared tool name (`memory_search`, `memory_get`) registers AT MOST ONCE per api, through an ownership record that holds name-independent metadata and the currently executing implementations. An ACTIVE entry arriving after a passive one takes the names over — its opt-out included, since previously installed tools go inert rather than being unregistered. A disabled entry also records itself: as slot owner it is a tombstone a later enabled passive sibling cannot bypass; as a passive entry it yields like any other.
- An api's bridge mode latches at first binding: an embedded fallback is recorded so a later `register()` on the same api cannot switch to delegate, a delegate binding excludes a sibling's embedded hooks, and passive mode attaches no hooks and is not recorded as bound. Config is parsed and validated BEFORE mode resolution, so a typo throws consistently in either mode.
- The delegate capability is always built, even when the host registers none of its surfaces, so hook paths reuse the same default-namespace resolution as search; the capability types mirror the host SDK's memory runtime contract structurally, and callbacks use method syntax so the real host api's parameter types check.
- Observe flushing detaches from the hook: per-session queues drain through ONE follow-up per session with a token-based ownership marker, released before the flush so a queue that outlasts the handler re-chains instead of being lost; the follow-up is bounded (a ceiling of rounds), releases ownership before its own flush, and the durable notes are written before the transcript flush.
- The public active-memory shape is what tools return in both modes: `id` as the `.md` basename, snippet text under the configured budget, and no absolute filesystem path; an unresolvable handle-shaped id is a miss (embedded parity), while other 400s surface; a fractional limit floors like embedded; command descriptors carry the top-level handler and description the host validator requires while keeping `subcommands` for discovery.
- `openclawToolsEnabled` is an ADAPTER toggle, not a global tool opt-out: embedded mode answers it by registering its legacy search instead of the adapters, and delegate mode keeps the daemon-backed search while only `memory_get` — which exists solely as an adapter — goes away.
- In gateway mode, dreams never depend on the direct client, so gateway-only operators work; an empty `gatewayAgentId` falls through to the default chain.

## Consequences
- No duplicate tool names or registration-order races: what executes is determined by the ownership record, not by which plugin ID registered first.
- Mid-lifetime bridge-mode flips are impossible on an api that already bound a mode; deployments that must re-decide must re-create the api.
- Tools can be made inert or taken over but never removed; the ownership record is load-bearing indirection in every tool call.
- Detached flush chains add bounded background work after hooks return; its ordering (durable notes before transcript flush) is part of the contract.

## Origin comments
- `packages/plugin-openclaw/src/delegate-capability.ts:862` — "// No `sync`: indexing belongs to the daemon in delegate mode. Omitting the"
- `packages/plugin-openclaw/src/delegate-capability.ts:863` — "// optional member is honest — the host will not call what is not offered."
- `packages/plugin-openclaw/src/delegate-capability.ts:964` — "// Always BUILT, even when the host registers none of it: the caller reuses"
- `packages/plugin-openclaw/src/delegate-capability.ts:965` — "// `daemonDefaultNamespace` so the hook paths scope exactly like search."
- `packages/plugin-openclaw/src/delegate-http.ts:1` — "/** * JSON transport for the delegate's daemon routes. * * Extracted from `delegate-runtime.ts` so both the runtime an"
- `packages/plugin-openclaw/src/delegate-http.ts:84` — "/** * POST that reports the daemon's status instead of collapsing it. * * `postJson` below cannot tell a caller WHY a "
- `packages/plugin-openclaw/src/delegate-http.ts:110` — "/** * Legacy contract kept for every existing delegate route: `null` on an * authorization refusal, a throw on any oth"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:265` — "/** * `agent_end` returns before its observe POST settles (the turn capture is * detached from the hook), so a test t..."
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:399` — "// respond() throwing crashes the handler; use 500 instead"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:923` — "// Each observe fits its own cap (half the flush budget), but a QUEUE of them"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:937` — "// Drain and per-observe cap are both 500ms: each 350ms observe fits its"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:972` — "// A turn observed under the same key after the lifecycle hook returned must"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:1023` — "// The follow-up releases its ownership marker before its own flush so that"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:1071` — "// Two lifecycle flushes plus at most one deferred chain link per lifecycle"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:1081` — "// The batch request is an optimization whose failure path is the singular"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:1126` — "// The `/engram/v1/capabilities` probe is an optimization: one batched flush"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:1179` — "// Wide enough that the lifecycle drain (half the flush budget) is not the"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:2546` — "// A daemon that accepts the connection and never answers must not hold the"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:2577` — "// Real time, deliberately: the daemon still holds the observe open, and a"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:3168` — "// The guard must be intrinsic to the runtime, not an artifact of the"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:3234` — "// Second call on the SAME api: daemon now up, but must NOT switch to delegate"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:3972` — "// The timeout is parsed before mode resolution, so a bad value throws even"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:4064` — "// Canonical and legacy plugin IDs register separately on ONE api. If the"
- `packages/plugin-openclaw/src/delegate-runtime.test.ts:4125` — "// The result is irrevocably embedded, so running `auto`'s synchronous walk"
- `packages/plugin-openclaw/src/delegate-runtime.ts:1` — "/** * Delegate bridge runtime (issue #2120). * * When bridge mode is `delegate`, the plugin does NOT construct the em"
- `packages/plugin-openclaw/src/delegate-runtime.ts:152` — "// Method syntax (bivariant params) so the real OpenClaw api — whose"
- `packages/plugin-openclaw/src/delegate-runtime.ts:256` — "// Passive (slot not owned) still serves the explicit tools, like embedded:"
- `packages/plugin-openclaw/src/delegate-runtime.ts:315` — "// Detached observe POSTs, per session (see `agent_end`). A flush for the"
- `packages/plugin-openclaw/src/delegate-runtime.ts:511` — "// The daemon call is DETACHED from the hook. A daemon that accepts the"
- `packages/plugin-openclaw/src/delegate-runtime.ts:617` — "// The session's last turns may still be on their way to the daemon"
- `packages/plugin-openclaw/src/delegate-runtime.ts:632` — "// One follow-up per session, draining the whole queue — the ended"
- `packages/plugin-openclaw/src/delegate-runtime.ts:640` — "// Ownership is a TOKEN, not mere presence: the release below precedes"
- `packages/plugin-openclaw/src/delegate-runtime.ts:652` — "// ponytail: 8 rounds is the ceiling on ONE follow-up — a session"
- `packages/plugin-openclaw/src/delegate-runtime.ts:660` — "// Released BEFORE the flush: when the queue outlasted those"
- `packages/plugin-openclaw/src/delegate-runtime.ts:679` — "// BEFORE the transcript flush, so the host's durable notes and the"
- `packages/plugin-openclaw/src/delegate-runtime.ts:850` — "// `recall` is exercised only when prompt injection is on; observe, flush,"
- `packages/plugin-openclaw/src/delegate-runtime.ts:857` — "// Mirrors the embedded runtime's per-api hook dedup (globalThis HOOK_APIS"
- `packages/plugin-openclaw/src/delegate-runtime.ts:863` — "// Service registration can span distinct OpenClaw api objects. Keep the active"
- `packages/plugin-openclaw/src/delegate-runtime.ts:866` — "// Apis that previously fell back to embedded because the daemon was down. A"
- `packages/plugin-openclaw/src/delegate-runtime.ts:871` — "/** * Apis where SOME service has bound delegate hooks. The canonical and legacy * plugin IDs register separately aga"
- `packages/plugin-openclaw/src/delegate-runtime.ts:918` — "// BEFORE any health-dependent resolution: if this service already has"
- `packages/plugin-openclaw/src/delegate-runtime.ts:930` — "// BEFORE any health-dependent resolution. The result is already irrevocably"
- `packages/plugin-openclaw/src/delegate-runtime.ts:943` — "// Parsed BEFORE mode resolution: `auto` probes the daemon inside"
- `packages/plugin-openclaw/src/delegate-runtime.ts:955` — "// An invalid bridgeMode or health timeout (config typo or bad env"
- `packages/plugin-openclaw/src/delegate-runtime.ts:966` — "// Returning `false` has the caller bind the embedded runtime on this api,"
- `packages/plugin-openclaw/src/delegate-runtime.ts:978` — "// A SIBLING service (canonical + legacy plugin IDs register separately"
- `packages/plugin-openclaw/src/delegate-runtime.ts:991` — "// The caller will bind embedded hooks on this api (unless passive, which"
- `packages/plugin-openclaw/src/delegate-runtime.ts:1014` — "// register() is synchronous, so the preflight uses the bridge's"
- `packages/plugin-openclaw/src/delegate-runtime.ts:1021` — "// The configured interface address is tried only after loopback refuses:"
- `packages/plugin-openclaw/src/delegate-runtime.ts:1027` — "// ONE preflight budget across both dials, as the auto walk already does:"
- `packages/plugin-openclaw/src/delegate-runtime.ts:1052` — "// Same sibling rule as the embedded-resolution branch: when delegate hooks"
- `packages/plugin-openclaw/src/delegate-runtime.ts:1063` — "// Record the fallback so a later register() on the same api does not switch"
- `packages/plugin-openclaw/src/delegate-runtime.ts:1073` — "// Passive mode attaches no hooks — recording it as bound would make a later"
- `packages/plugin-openclaw/src/delegate-runtime.ts:1080` — "// Delegate is now the api's established mode, so a sibling service"
- `packages/plugin-openclaw/src/delegate-runtime.ts:1085` — "// Embedded toggle-store parity: same primary path (per-service plugin state)"
- `packages/plugin-openclaw/src/delegate-tools.test.ts:33` — "/** * The canonical and legacy plugin ids register separately against one api, so a * passive delegate entry can inst"
- `packages/plugin-openclaw/src/delegate-tools.test.ts:74` — "/** * The reverse order: a PASSIVE embedded sibling registers first. Its * registration must join the same record, so"
- `packages/plugin-openclaw/src/delegate-tools.test.ts:119` — "/** * A passive sibling with the adapters disabled installs `memory_search` alone, * so the embedded owner must still"
- `packages/plugin-openclaw/src/delegate-tools.test.ts:183` — "/** * Embedded parity for the handle contract: `getMemoryForActiveMemory` answers * an unresolvable `[m:xxxx]` handle"
- `packages/plugin-openclaw/src/delegate-tools.test.ts:214` — "// A 400 for a raw id is a real protocol error, not a miss."
- `packages/plugin-openclaw/src/delegate-tools.test.ts:224` — "/** * With the adapters disabled, the embedded owner hands over its LEGACY search * implementation. Handing over the "
- `packages/plugin-openclaw/src/delegate-tools.test.ts:264` — "/** * A name keeps the schema it was registered with (there is no unregister), * while ownership of its executor can "
- `packages/plugin-openclaw/src/delegate-tools.ts:236` — "/** * Apis that already carry the delegate `memory_search` / `memory_get` tools, * with the entry whose closures the too"
- `packages/plugin-openclaw/src/delegate-tools.ts:245` — "/** * Ownership of the `memory_search` / `memory_get` names on one api. * * Both bridge modes register through this reco"
- `packages/plugin-openclaw/src/delegate-tools.ts:259` — "/** * What each registered name executes right now. The ACTIVE slot owner puts * its own implementations here, so a name"
- `packages/plugin-openclaw/src/delegate-tools.ts:267` — "/** * The metadata a SHARED name is advertised with, independent of which entry * happens to register it first. * * A na"
- `packages/plugin-openclaw/src/delegate-tools.ts:289` — "/** * Register `tools` on the api under the shared ownership record: each name is * registered at most once — with the p"
- `packages/plugin-openclaw/src/delegate-tools.ts:342` — "/** * Register the daemon-backed tools on a host that exposes `registerTool`. * Embedded mode builds these over the in-p"
- `packages/plugin-openclaw/src/delegate-tools.ts:355` — "// Once per api object: the canonical and legacy plugin ids both register"
- `packages/plugin-openclaw/src/delegate-tools.ts:356` — "// here, and a second `memory_search` on one api is a host tool-name"
- `packages/plugin-openclaw/src/delegate-tools.ts:357` — "// conflict, not a second tool. The tools read their wiring through the"
- `packages/plugin-openclaw/src/delegate-tools.ts:358` — "// owner record, so an active entry arriving after a passive one takes it"
- `packages/plugin-openclaw/src/delegate-tools.ts:359` — "// over — its opt-out included: the host exposes no unregister, so tools a"
- `packages/plugin-openclaw/src/delegate-tools.ts:360` — "// passive sibling already installed go inert. A disabled entry records"
- `packages/plugin-openclaw/src/delegate-tools.ts:361` — "// itself too: as the slot owner it is a tombstone a later enabled passive"
- `packages/plugin-openclaw/src/delegate-tools.ts:362` — "// sibling cannot bypass; as a passive entry it yields like any other."
- `packages/plugin-openclaw/src/delegate-tools.ts:372` — "// An ACTIVE delegate entry takes the names over from a passive sibling of"
- `packages/plugin-openclaw/src/delegate-tools.ts:373` — "// either mode: that sibling's implementations belong to a runtime which"
- `packages/plugin-openclaw/src/delegate-tools.ts:374` — "// does not own the memory slot."
- `packages/plugin-openclaw/src/delegate-tools.ts:378` — "// `openclawToolsEnabled` is an ADAPTER toggle (see the manifest), not a"
- `packages/plugin-openclaw/src/delegate-tools.ts:379` — "// global tool opt-out: embedded mode answers it by registering its legacy"
- `packages/plugin-openclaw/src/delegate-tools.ts:380` — "// `memory_search` instead of the adapters, so a search surface always"
- `packages/plugin-openclaw/src/delegate-tools.ts:381` — "// survives. Delegate mode has no separate legacy implementation, so the"
- `packages/plugin-openclaw/src/delegate-tools.ts:382` — "// daemon-backed search stays registered and only `memory_get` — which"
- `packages/plugin-openclaw/src/delegate-tools.ts:383` — "// exists solely as an adapter — goes away with the flag."
- `packages/plugin-openclaw/src/delegate-tools.ts:384` — "//"
- `packages/plugin-openclaw/src/delegate-tools.ts:408` — "/** * Register the EMBEDDED runtime's memory tools through the same ownership * record the delegate path uses, and repor"
- `packages/plugin-openclaw/src/memory-capability-types.ts:1` — "/** * Structural types for the OpenClaw memory-slot capability. * * These mirror the host SDK's memory runtime contract "
- `packages/plugin-openclaw/src/runtime-surfaces.test.ts:1430` — "// gatewayAgentId is a required string (default ""); an empty value makes"
- `packages/plugin-openclaw/src/runtime-surfaces.test.ts:1431` — "// gatewayTaskChainOptions fall through to the default chain."
- `packages/plugin-openclaw/src/runtime-surfaces.test.ts:1461` — "// The core fix: gateway mode never depends on the direct client, so dreams"
- `packages/plugin-openclaw/src/runtime-surfaces.test.ts:1462` — "// work for gateway-only operators (ZAI/Fireworks/OpenRouter, no OpenAI key)."
- `packages/plugin-openclaw/src/session-command-descriptors.test.ts:128` — "// Shape required by openclaw's validatePluginCommandDefinition"
- `packages/plugin-openclaw/src/session-command-descriptors.test.ts:129` — "// (see openclaw/dist/command-registration:*)."
- `packages/plugin-openclaw/src/session-command-descriptors.ts:156` — "// Top-level handler + description + acceptsArgs let the OpenClaw host"
- `packages/plugin-openclaw/src/session-command-descriptors.ts:157` — "// registerPluginCommand validator accept this descriptor. The validator"
- `packages/plugin-openclaw/src/session-command-descriptors.ts:158` — "// (openclaw/dist/command-registration:validatePluginCommandDefinition)"
- `packages/plugin-openclaw/src/session-command-descriptors.ts:159` — "// requires a function `handler` and a non-empty string `description` on the"
- `packages/plugin-openclaw/src/session-command-descriptors.ts:160` — "// registered command itself; it does not walk a `subcommands` array. The"
- `packages/plugin-openclaw/src/session-command-descriptors.ts:161` — "// dispatcher below routes `/remnic <sub>` to the matching subcommand while"
- `packages/plugin-openclaw/src/session-command-descriptors.ts:162` — "// keeping the `subcommands` array available for command-discovery surfaces"
- `packages/plugin-openclaw/src/session-command-descriptors.ts:163` — "// that introspect it."
