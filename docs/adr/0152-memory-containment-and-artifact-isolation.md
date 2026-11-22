# Read containment is enforced by canonical-path checks with symlink defense, and artifacts are isolated from generic memory reads

Status: accepted

## Context
The capability hands agents a `readFile` primitive, so the filesystem layout is a security boundary. Roots may be symlinks, may not exist yet at plugin start, and may sit at a Windows drive root where stripping a trailing separator yields a drive-relative path. A writable workspace lets an attacker swap a validated path for a symlink between check and open. Artifacts are served only through a dedicated verbatim path, and public artifact listings must not expose private directories or return paths that can be swapped after validation. Symlink cycles also made traversal order depend on `readdir()` order, so output was not reproducible across environments.

## Decision
- Containment is decided by canonicalizing the requested path against the trusted root and checking it stayed inside. Check-time canonicalization is strict: a `realpath` failure means the file does not exist or its symlink chain is broken, and a lexical fallback there would reopen the TOCTOU window. Init-time canonicalization tolerates `realpath` failure (roots may not exist yet) and its lexical fallback is safe only because those values are containment targets, never paths that are opened.
- A root that is itself a symlink is a mutable trust anchor and is rejected outright; trailing separators are stripped without ever stripping past the root (a drive root must stay drive-absolute).
- Artifact isolation is a contract, not a ranking detail: generic memory readers never open artifact files. Isolation is judged ROOT-RELATIVE on the canonical path, so a corpus that merely lives under a directory named `artifacts` keeps all its hits and a symlink alias cannot route around the check; the raw request is judged only when it is relative.
- Public artifact scans use the specific public directory as the containment boundary, not `memoryDir`, so symlinks inside a public tree cannot escape into private directories; directory symlinks must resolve inside that boundary, top-level symlinks that redirect an allowlisted name are rejected, and standalone-file symlinks are rejected so returned paths cannot be swapped after validation; results are deduplicated by (workspaceDir, relativePath, kind).
- Traversal determinism is part of the contract: entries are sorted before traversal and cycle detection tracks only the current recursion path, so sibling aliases of the same real directory are each traversed and output order is stable across filesystems.

## Consequences
- The TOCTOU window narrows to check-then-open with a refusing second look; no symlink planted in a public or state tree can redirect a read, a listing, or an artifact ingestion.
- Costs one canonicalization per read and per-segment checks at scan time; a broken symlink chain is a refusal, not a best-effort read.
- Corpora legitimately living under an `artifacts/`-named directory keep working; the trade-off is that the isolation check must stay root-relative, never absolute.
- Public listings can be slightly larger (aliases traversed independently) in exchange for deterministic output.

## Origin comments
- `packages/plugin-openclaw/src/delegate-capability.ts:730` — "// Artifact isolation: the same exclusion the embedded runtime applies."
- `packages/plugin-openclaw/src/delegate-capability.ts:731` — "// A current daemon already dropped these before its own cap; this"
- `packages/plugin-openclaw/src/delegate-capability.ts:732` — "// keeps the guarantee against an older one."
- `packages/plugin-openclaw/src/delegate-capability.ts:734` — "// Judged on the ROOT-RELATIVE citation, never the absolute hit: a"
- `packages/plugin-openclaw/src/delegate-capability.ts:735` — "// corpus that merely LIVES under a directory named `artifacts`"
- `packages/plugin-openclaw/src/delegate-capability.ts:736` — "// (`<root>/artifacts/remnic`) would otherwise lose every hit."
- `packages/plugin-openclaw/src/delegate-capability.ts:739` — "// A missing or non-finite score is a protocol failure, not a zero: it"
- `packages/plugin-openclaw/src/delegate-capability.ts:740` — "// would silently drop the hit under `minScore` and hand callers a"
- `packages/plugin-openclaw/src/delegate-capability.ts:741` — "// fabricated ranking without one."
- `packages/plugin-openclaw/src/delegate-capability.ts:748` — "// Absolute, so a follow-up readFile is unambiguous when the same"
- `packages/plugin-openclaw/src/delegate-capability.ts:749` — "// relative path exists under more than one allowed root."
- `packages/plugin-openclaw/src/memory-read-scope.ts:1` — "/** * Read scope for the OpenClaw memory-slot capability. * * The capability runtime hands agents a `readFile` primitive"
- `packages/plugin-openclaw/src/memory-read-scope.ts:22` — "/** * Strip trailing separators from an already-normalized path. * * A character loop rather than a `/[\\/]+$/` regex: t"
- `packages/plugin-openclaw/src/memory-read-scope.ts:31` — "// Never strip past the root. On Windows a corpus at `C:\\` would otherwise"
- `packages/plugin-openclaw/src/memory-read-scope.ts:32` — "// become `C:`, which node:path treats as DRIVE-RELATIVE — `path.relative`"
- `packages/plugin-openclaw/src/memory-read-scope.ts:33` — "// would then measure against the gateway's cwd and reject a daemon serving"
- `packages/plugin-openclaw/src/memory-read-scope.ts:34` — "// `C:\\namespaces\\<ns>`."
- `packages/plugin-openclaw/src/memory-read-scope.ts:45` — "// A missing path is rejected by the canonicalization below; report it as"
- `packages/plugin-openclaw/src/memory-read-scope.ts:46` — "// "not a symlink" so the failure surfaces there with the right reason."
- `packages/plugin-openclaw/src/memory-read-scope.ts:89` — "// A root that is ITSELF a symlink is a mutable trust anchor: realpath would"
- `packages/plugin-openclaw/src/memory-read-scope.ts:90` — "// erase that fact, and retargeting the link after validation would silently"
- `packages/plugin-openclaw/src/memory-read-scope.ts:91` — "// move the directory treated as the corpus. Reject it outright."
- `packages/plugin-openclaw/src/memory-read-scope.ts:208` — "// Init-time canonicalization tolerates realpath failure: the roots may not"
- `packages/plugin-openclaw/src/memory-read-scope.ts:209` — "// exist yet at plugin start. The lexical fallback is safe because these"
- `packages/plugin-openclaw/src/memory-read-scope.ts:210` — "// values are only ever containment targets, never paths we open."
- `packages/plugin-openclaw/src/memory-read-scope.ts:222` — "// Check-time canonicalization is strict: realpath failure means the file does"
- `packages/plugin-openclaw/src/memory-read-scope.ts:223` — "// not exist or its symlink chain is broken. A lexical fallback here would"
- `packages/plugin-openclaw/src/memory-read-scope.ts:224` — "// reopen the TOCTOU window by letting a non-existent path pass containment,"
- `packages/plugin-openclaw/src/memory-read-scope.ts:225` — "// after which a symlink could be created before the read."
- `packages/plugin-openclaw/src/memory-read-scope.ts:303` — "// Artifact isolation is a contract, not a search-ranking detail: generic"
- `packages/plugin-openclaw/src/memory-read-scope.ts:304` — "// memory readers must never open artifact files, which are served only"
- `packages/plugin-openclaw/src/memory-read-scope.ts:305` — "// through the dedicated verbatim path."
- `packages/plugin-openclaw/src/memory-read-scope.ts:306` — "//"
- `packages/plugin-openclaw/src/memory-read-scope.ts:307` — "// Judged ROOT-RELATIVE, on the canonical path so a symlink alias cannot"
- `packages/plugin-openclaw/src/memory-read-scope.ts:308` — "// route around it. An absolute test would match any corpus that merely"
- `packages/plugin-openclaw/src/memory-read-scope.ts:309` — "// LIVES under a directory named `artifacts` (`/srv/artifacts/remnic`)"
- `packages/plugin-openclaw/src/memory-read-scope.ts:310` — "// and reject every ordinary read in it."
- `packages/plugin-openclaw/src/memory-read-scope.ts:313` — "// Containment already passed, so this is unreachable in practice; a"
- `packages/plugin-openclaw/src/memory-read-scope.ts:314` — "// path that escapes on the second look is refused rather than trusted."
- `packages/plugin-openclaw/src/memory-read-scope.ts:317` — "// The raw request is judged only when it is RELATIVE — it is then"
- `packages/plugin-openclaw/src/memory-read-scope.ts:318` — "// already corpus-relative by construction. An absolute request would"
- `packages/plugin-openclaw/src/memory-read-scope.ts:319` — "// reintroduce the ancestor-directory false positive this fix removes."
- `packages/plugin-openclaw/src/public-artifacts.ts:96` — "// Cycle detection uses only the current recursion path — the set of real"
- `packages/plugin-openclaw/src/public-artifacts.ts:97` — "// paths of ancestors we've descended through. This prevents infinite"
- `packages/plugin-openclaw/src/public-artifacts.ts:98` — "// recursion on symlink cycles while still allowing sibling aliases that"
- `packages/plugin-openclaw/src/public-artifacts.ts:99` — "// point at the same real directory to each be traversed independently."
- `packages/plugin-openclaw/src/public-artifacts.ts:100` — "// Globally tracking visited real paths (as the earlier implementation"
- `packages/plugin-openclaw/src/public-artifacts.ts:101` — "// did) suppressed all-but-one of the aliases, leaving the surviving one"
- `packages/plugin-openclaw/src/public-artifacts.ts:102` — "// dependent on readdir() order — a source of unstable relativePath"
- `packages/plugin-openclaw/src/public-artifacts.ts:103` — "// output across environments/runs."
- `packages/plugin-openclaw/src/public-artifacts.ts:121` — "// Sort entries deterministically before traversal so readdir() order"
- `packages/plugin-openclaw/src/public-artifacts.ts:122` — "// cannot influence which aliases survive cycle pruning, and so the"
- `packages/plugin-openclaw/src/public-artifacts.ts:123` — "// overall output order is stable across filesystems."
- `packages/plugin-openclaw/src/public-artifacts.ts:213` — "// Block symlink traversal: verify the directory resolves within memoryDir."
- `packages/plugin-openclaw/src/public-artifacts.ts:214` — "// Also reject top-level symlinks that redirect an allowlisted directory"
- `packages/plugin-openclaw/src/public-artifacts.ts:215` — "// name to a different directory (e.g., facts -> state), which would"
- `packages/plugin-openclaw/src/public-artifacts.ts:216` — "// expose private files as public artifacts under the wrong kind."
- `packages/plugin-openclaw/src/public-artifacts.ts:231` — "// Use the specific public directory as the containment boundary (not"
- `packages/plugin-openclaw/src/public-artifacts.ts:232` — "// memoryDir), so symlinks within e.g. facts/ cannot escape into private"
- `packages/plugin-openclaw/src/public-artifacts.ts:233` — "// directories like state/ or questions/ that live under memoryDir."
- `packages/plugin-openclaw/src/public-artifacts.ts:256` — "// Reject symlinks for standalone files so returned paths cannot be swapped"
- `packages/plugin-openclaw/src/public-artifacts.ts:257` — "// after validation but before downstream ingestion reads them."
- `packages/plugin-openclaw/src/public-artifacts.ts:281` — "// Deduplicate by (workspaceDir, relativePath, kind) — defensive against"
- `packages/plugin-openclaw/src/public-artifacts.ts:282` — "// overlapping scans or symlinks."
