# Local file-backed reads exist only while the daemon provably serves this corpus on this host

Status: accepted

## Context
Explicit `delegate` may target a REMOTE daemon, and canonicalizing two path strings on this host proves nothing about a daemon that happens to use the same absolute pathname. A daemon can restart onto ANOTHER corpus inside any cache window and leave no probe failure behind to notice. Health reports only the daemon's `memoryDir` (the namespace-resolved storage dir), the gateway's own workspace sits beside the corpus, namespaces keep hits in per-namespace directories, and the daemon reloads token entries per request — so a grant revoked in place keeps the same token, operations, and namespace, invisible to any cache key.

## Decision
- File-backed surfaces (`readFile`, artifact listing) require `corpusShared` to be confirmed for THIS configuration, and revalidate it per read: the cache window is not trusted, because a restart onto another corpus produces no failure to invalidate it. Locality is decided up front — a remote target is refused with the accurate reason ("remote"), not "not confirmed yet".
- The read scope and the artifact listing are rooted on the directory the DAEMON reports, not the plugin's configured corpus root; the corpus root remains the trust anchor after `daemonServesCorpus` proves the reported directory belongs to the configured corpus. A relative hit resolves in the frame the daemon returned it in, with the daemon's directory first.
- The gateway's own workspace is NOT a readable root: the daemon never searched or authorized it. The corpus ROOT stays readable so a session bound to a non-default namespace can still open the absolute hits its own search returns from another namespace's directory.
- A local read must additionally clear the daemon's OPERATION gate: corpus containment proves co-location and the single-namespace check proves one namespace — neither proves this token may READ. A token with search but not read permission must not open files straight off disk.
- Local-read authorization verdicts are cached under a TTL: the daemon reloads token entries per request, so the cache key cannot see an in-place revocation, and expiring the verdict bounds how long a withdrawn permission still authorizes local reads.
- `undefined` — a probe that could not answer, or an older daemon with no authorization route — is not permission: fail closed, exactly as an unconfirmed namespace posture does.
- Artifact filtering happens before capping and is judged on the root-relative citation, never the absolute hit path: a corpus that merely lives under a directory named `artifacts` is an ordinary corpus.

## Consequences
- Reads and listings cannot return files from a corpus the daemon no longer serves, or from a workspace the daemon never authorized.
- One revalidation per read window; brief refusals right after daemon restarts until health re-answers.
- Remote deployments get no file-backed surfaces by design; withdrawn grants stop authorizing local reads within the TTL rather than instantly.
- Namespace-scoped sessions depend on the daemon-reported directory being correct; the root stays the trust anchor.

## Origin comments
- `packages/plugin-openclaw/src/delegate-capability.test.ts:851` — "// The daemon's hits are relative to ITS storage dir, so the read scope must"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:852` — "// be rooted there, not on the configured corpus root."
- `packages/plugin-openclaw/src/delegate-capability.test.ts:942` — "// Health answers for the DEFAULT namespace, but a session bound to team-a"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:943` — "// gets hits under team-a's directory; the host must be able to open them."
- `packages/plugin-openclaw/src/delegate-capability.test.ts:991` — "// Canonicalizing two strings on THIS host says nothing about a remote"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:992` — "// daemon that happens to use the same absolute pathname."
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1289` — "// The daemon reports only its memoryDir. A file that exists solely under the"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1290` — "// gateway's <workspaceDir>/memory was never searched or authorized by it."
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1553` — "// An unknown memoryDir is NEVER a match. Substituting the plugin's own path"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1554` — "// would compare it to itself and enable file-backed reads with no proof the"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1555` — "// daemon serves that corpus at all."
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1636` — "// <root>/artifacts/remnic is an ordinary corpus. Judging the ABSOLUTE hit"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:1637` — "// path would discard every result the daemon returned."
- `packages/plugin-openclaw/src/delegate-capability.test.ts:2299` — "// A daemon that restarts onto ANOTHER corpus inside the cache window leaves"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:2300` — "// no probe failure behind, so a cached `corpusShared: true` would let a read"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:2301` — "// return a file from the corpus that is no longer served."
- `packages/plugin-openclaw/src/delegate-capability.test.ts:2369` — "// Corpus containment proves co-location and the single-namespace check"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:2370` — "// proves there is one namespace — neither proves this token may READ. A"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:2371` — "// token with `memory_search` but not `memory_get` must not open files"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:2372` — "// straight off disk, which is the gate delegating to the daemon preserves."
- `packages/plugin-openclaw/src/delegate-capability.test.ts:2400` — "// `undefined` is a probe that could not answer — a timeout, or an older"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:2401` — "// daemon with no authorization route. A local read bypasses the daemon"
- `packages/plugin-openclaw/src/delegate-capability.test.ts:2402` — "// entirely, so an UNCONFIRMED verdict is not permission."
- `packages/plugin-openclaw/src/delegate-capability.ts:165` — "/** * How long a local-read authorization verdict stands before it is re-proven. * The daemon reloads token entries pe"
- `packages/plugin-openclaw/src/delegate-capability.ts:234` — "// The read scope and the artifact listing are rooted on the directory the"
- `packages/plugin-openclaw/src/delegate-capability.ts:235` — "// DAEMON reports, not the plugin's configured corpus root. Health returns the"
- `packages/plugin-openclaw/src/delegate-capability.ts:236` — "// namespace-resolved storage dir, so scanning the root instead would miss the"
- `packages/plugin-openclaw/src/delegate-capability.ts:237` — "// active namespace's files while publishing flat-root files for the wrong"
- `packages/plugin-openclaw/src/delegate-capability.ts:238` — "// scope. `daemonServesCorpus` has already proved that directory belongs to"
- `packages/plugin-openclaw/src/delegate-capability.ts:239` — "// the configured corpus, so the root remains the trust anchor."
- `packages/plugin-openclaw/src/delegate-capability.ts:247` — "// The daemon's own directory comes first, so a relative hit resolves"
- `packages/plugin-openclaw/src/delegate-capability.ts:248` — "// in the frame the daemon returned it in..."
- `packages/plugin-openclaw/src/delegate-capability.ts:251` — "// The gateway's own workspace is NOT a readable root here: health"
- `packages/plugin-openclaw/src/delegate-capability.ts:252` — "// validates `memoryDir` only, so a relative path absent from the"
- `packages/plugin-openclaw/src/delegate-capability.ts:253` — "// daemon corpus must not be served from a workspace the daemon"
- `packages/plugin-openclaw/src/delegate-capability.ts:254` — "// never searched or authorized."
- `packages/plugin-openclaw/src/delegate-capability.ts:256` — "// ...and the corpus ROOT stays readable, so a session bound to a"
- `packages/plugin-openclaw/src/delegate-capability.ts:257` — "// NON-default namespace can still open the absolute hits its own"
- `packages/plugin-openclaw/src/delegate-capability.ts:258` — "// search returns from `<root>/namespaces/<other>`."
- `packages/plugin-openclaw/src/delegate-capability.ts:293` — "// Local reads and artifact listing are only valid while the daemon serves"
- `packages/plugin-openclaw/src/delegate-capability.ts:294` — "// the SAME corpus this plugin is configured for. Until health confirms it,"
- `packages/plugin-openclaw/src/delegate-capability.ts:295` — "// and after any mismatch, the file-backed surfaces refuse rather than read a"
- `packages/plugin-openclaw/src/delegate-capability.ts:296` — "// different same-named local file. `undefined` = not yet confirmed."
- `packages/plugin-openclaw/src/delegate-capability.ts:297` — "// Locality is knowable without a probe, and it is decisive: canonicalizing"
- `packages/plugin-openclaw/src/delegate-capability.ts:298` — "// two path strings ON THIS HOST proves nothing about a remote daemon that"
- `packages/plugin-openclaw/src/delegate-capability.ts:299` — "// happens to use the same absolute pathname. Settle it up front so a remote"
- `packages/plugin-openclaw/src/delegate-capability.ts:300` — "// target reports the accurate reason instead of "not confirmed yet"."
- `packages/plugin-openclaw/src/delegate-capability.ts:315` — "/** * File-backed surfaces walk ONE local directory: the `memoryDir` health * reports. The daemon answers `/engram/v1/"
- `packages/plugin-openclaw/src/delegate-capability.ts:332` — "/** * A local file read must clear the daemon's OPERATION gate too. * * Corpus containment proves physical co-location"
- `packages/plugin-openclaw/src/delegate-capability.ts:349` — "// The daemon reloads token entries per request, so a grant revoked in place"
- `packages/plugin-openclaw/src/delegate-capability.ts:350` — "// keeps the SAME token, operations, and namespace — the cache key cannot"
- `packages/plugin-openclaw/src/delegate-capability.ts:351` — "// see the change. Expiring the verdict bounds how long a withdrawn"
- `packages/plugin-openclaw/src/delegate-capability.ts:352` — "// permission can still authorize a local read that bypasses the daemon."
- `packages/plugin-openclaw/src/delegate-capability.ts:365` — "// `undefined` means the probe could not answer — a timeout, or an older"
- `packages/plugin-openclaw/src/delegate-capability.ts:366` — "// daemon with no authorization route. A local read bypasses the daemon"
- `packages/plugin-openclaw/src/delegate-capability.ts:367` — "// entirely, so an UNCONFIRMED verdict is not permission: fail closed,"
- `packages/plugin-openclaw/src/delegate-capability.ts:368` — "// exactly as an unconfirmed namespace posture already does."
- `packages/plugin-openclaw/src/delegate-capability.ts:566` — "// Path identity is decided by canonicalizing two strings ON THIS"
- `packages/plugin-openclaw/src/delegate-capability.ts:567` — "// HOST, so it proves nothing about a REMOTE daemon that happens to"
- `packages/plugin-openclaw/src/delegate-capability.ts:568` — "// use the same absolute pathname. Explicit `delegate` may target a"
- `packages/plugin-openclaw/src/delegate-capability.ts:569` — "// remote daemon; the file-backed surfaces may not follow it there."
- `packages/plugin-openclaw/src/delegate-capability.ts:787` — "// REVALIDATED, not merely refreshed. `corpusShared` is a safety fact, and"
- `packages/plugin-openclaw/src/delegate-capability.ts:788` — "// a daemon that restarts onto another corpus inside the cache window"
- `packages/plugin-openclaw/src/delegate-capability.ts:789` — "// produces no probe failure to invalidate it — the cached `true` would let"
- `packages/plugin-openclaw/src/delegate-capability.ts:790` — "// this return a file from the corpus that is no longer being served. The"
- `packages/plugin-openclaw/src/delegate-capability.ts:791` — "// failure backoff still applies, so a down daemon degrades immediately"
- `packages/plugin-openclaw/src/delegate-capability.ts:792` — "// rather than probing per read."
- `packages/plugin-openclaw/src/delegate-capability.ts:929` — "// The listing walks the LOCAL corpus, so confirm the daemon still"
- `packages/plugin-openclaw/src/delegate-capability.ts:930` — "// serves it before trusting those files — revalidated for the same"
- `packages/plugin-openclaw/src/delegate-capability.ts:931` — "// reason `readFile` is: a restart onto another corpus inside the cache"
- `packages/plugin-openclaw/src/delegate-capability.ts:932` — "// window leaves no failure behind to notice. Health may also not have"
- `packages/plugin-openclaw/src/delegate-capability.ts:933` — "// been probed at all yet: this surface hangs off the capability"
- `packages/plugin-openclaw/src/delegate-capability.ts:934` — "// object, not off a manager."
- `packages/plugin-openclaw/src/memory-read-scope.ts:199` — "// Delegate mode drops this: the daemon reports only its `memoryDir`, so a"
- `packages/plugin-openclaw/src/memory-read-scope.ts:200` — "// gateway-local workspace it never searched or authorized must not be a"
- `packages/plugin-openclaw/src/memory-read-scope.ts:201` — "// readable root just because the two processes share a corpus."
