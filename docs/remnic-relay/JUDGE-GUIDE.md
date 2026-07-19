# Judge guide: Remnic Relay

Remnic Relay is memory that can repair an agent team: it exposes conflicting
beliefs, requires a human-approved correction, retires the stale decision, and
proves a transcript-free cold agent used the replacement to turn the same test
from red to green.

## Run the complete judge experience

Prerequisites:

- a checkout of this public MIT-licensed repository;
- Linux with procfs and descriptor no-follow filesystem flags;
- Node.js 22.12 or newer;
- a desktop browser.

No install, build, account, credential, dataset download, model call, or
network access is required after the repository is available.

```bash
node scripts/relay/judge-package.mjs serve
```

Expected terminal output begins with:

```text
RELAY_JUDGE_PACKAGE_OK root=69d6f7f30d5603bcf514cea657aeb2a9bf1b6ff8b6712d5cfce6b5c33aae30be ui=55e9eb9ad7a6bc5faec7e431313d9ff3b47c6a46940b4cdb7f73adf39dfdb08b model=gpt-5.6-terra calls=4 filesystem=descriptor-pinned-nofollow-mount-locked
Remnic Relay Mission Control: http://127.0.0.1:4173/
Verified offline replay · zero credentials · zero external calls · Ctrl+C to stop
```

Open the printed loopback URL. Mission Control begins at the disagreement:

1. Select Scout and Builder to compare the accepted contract with the stale
   recalled decision.
2. Press `E` to inspect at-action provenance, then `Escape` to close it.
3. Press `→` until the human gate. Type `APPROVE`, then approve the replayed
   correction.
4. Continue to **Cold-start recall**, **Contract passed**, and the sealed
   **Outcome recovered** receipt.

Keyboard controls are `Space` to play/pause, `←`/`→` to step, `E` for evidence,
and `Escape` to close a dialog. Replay approval is an interaction with the
local playback only; it is never presented as a new live write.

## Verify the evidence without opening a browser

```bash
node scripts/relay/judge-package.mjs verify
```

Expected output:

```text
RELAY_JUDGE_PACKAGE_OK root=69d6f7f30d5603bcf514cea657aeb2a9bf1b6ff8b6712d5cfce6b5c33aae30be ui=55e9eb9ad7a6bc5faec7e431313d9ff3b47c6a46940b4cdb7f73adf39dfdb08b model=gpt-5.6-terra calls=4 transition=failed->passed filesystem=descriptor-pinned-nofollow-mount-locked externalCalls=0 productionDataRead=false
```

The dependency-free verifier does not merely trust the final JSON. It:

- rehashes the exact recording and synthetic fixture trees;
- pins the canonical recording root and mission receipt;
- pins the ordered before/after hidden-test output digests recorded by the
  mission, so a resealed but substituted test transcript fails closed;
- binds four distinct Codex threads to four committed prompt hashes and four
  retained structured-output hashes;
- verifies stale recall, human approval, supersession, replacement recall,
  cold-start propagation, and the `failed → passed` test transition across 16
  ordered mission events;
- independently recomputes `gpt-5.6-terra` credit units from per-call usage;
- independently recomputes the mission-receipt digest from the final snapshot;
- pins every byte in the five-file Mission Control package to one reviewed UI
  root and verifies the browser replay against the final sealed event trace;
- captures one immutable input snapshot before verification or serving using
  component-by-component descriptor-pinned no-follow reads, with symlink and
  hard-link rejection, file-handle identity checks around every read, and a
  Linux descriptor mount-ID lock that rejects nested or same-device bind
  mounts before reading their contents;
- scans all 39 copied recording, fixture, UI, demo, and package-manifest text
  files for secret-like and host-private material; and
- measures the demo narration at 326 words: 135 seconds at 145 words per
  minute, plus a 30-second action allowance, for an estimated 165 seconds.

## Clean-room smoke

For an ordinary checkout already trusted to match the reviewed commit, the
short command is `node scripts/verify-relay-judge-package.mjs`. For the
stronger case where the checkout itself may be modified, use this trust-root
procedure instead. Obtain both this exact bootstrap block and
`RELAY_LAUNCHER_SHA256` from the pinned GitHub comment on PR #2012 or issue
#1969; that comment is deliberately out-of-band from checkout contents. The
copy below must match that trusted source. Do not derive either the bootstrap
or expected value solely from the checkout being tested.

```bash
RELAY_LAUNCHER_SHA256=99619f5a287d85a6bfe026cf2d81f5a246ab2adf4bda885d3bae6c63f39471e8
relay_trust_dir="$(mktemp -d)"
trap 'rm -r -- "$relay_trust_dir"' EXIT

node -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const [source, target, expected] = process.argv.slice(1);
const fail = (message) => {
  throw new Error(`Relay launcher staging failed: ${message}`);
};
for (const name of ["O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK"]) {
  if (typeof fs.constants[name] !== "number") fail(`Linux ${name} support is required`);
}
if (!source || source.startsWith("/") || source.includes("\\")) fail("source must be a relative POSIX path");
if (!/^[a-f0-9]{64}$/.test(expected)) fail("expected SHA-256 is invalid");
const segments = source.split("/");
if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
  fail("source must stay inside the checkout");
}
const mountId = (fd) => {
  const info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
  const matches = [...info.matchAll(/^mnt_id:\s+([1-9]\d*)\s*$/gm)];
  if (matches.length !== 1) fail("each descriptor must expose one Linux mount ID");
  return matches[0][1];
};
const sameOpenedNode = (before, after) =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.mode === after.mode &&
  before.nlink === after.nlink &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs;
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
let fd = fs.openSync(".", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
let bytes;
try {
  const rootMountId = mountId(fd);
  for (const [index, segment] of segments.entries()) {
    const final = index === segments.length - 1;
    const next = fs.openSync(
      `/proc/self/fd/${fd}/${segment}`,
      flags | (final ? 0 : fs.constants.O_DIRECTORY)
    );
    try {
      const info = fs.fstatSync(next, { bigint: true });
      if (mountId(next) !== rootMountId) fail("launcher path crosses a mount boundary");
      if (final ? !info.isFile() : !info.isDirectory()) fail("launcher path has the wrong filesystem type");
    } catch (error) {
      fs.closeSync(next);
      throw error;
    }
    fs.closeSync(fd);
    fd = next;
  }
  const before = fs.fstatSync(fd, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) fail("launcher must be one non-hard-linked regular file");
  bytes = fs.readFileSync(fd);
  const after = fs.fstatSync(fd, { bigint: true });
  if (!sameOpenedNode(before, after)) fail("launcher changed while its bytes were read");
} finally {
  fs.closeSync(fd);
}
const actual = crypto.createHash("sha256").update(bytes).digest("hex");
if (actual !== expected) {
  process.stderr.write(`Relay launcher digest mismatch: ${actual}\n`);
  process.exit(1);
}
fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o500 });
' scripts/verify-relay-judge-package.mjs "$relay_trust_dir/launcher.mjs" "$RELAY_LAUNCHER_SHA256"

node "$relay_trust_dir/launcher.mjs" --source-root "$PWD"
```

Expected output on the verified platform:

```text
RELAY_JUDGE_CLEAN_ROOM_OK platform=linux/x64 node=v22.23.1 root=69d6f7f30d5603bcf514cea657aeb2a9bf1b6ff8b6712d5cfce6b5c33aae30be ui=55e9eb9ad7a6bc5faec7e431313d9ff3b47c6a46940b4cdb7f73adf39dfdb08b dependencies=0 filesystem=descriptor-pinned-nofollow-mount-locked executables=trusted-launcher-pinned-sha256 externalCalls=0 productionDataRead=false sensitiveFiles=39
```

The inline Node bootstrap opens every candidate-launcher path component through
Linux no-follow descriptors rooted at the current checkout, locks them to one
mount ID, rejects hard links and non-regular files, reads the opened file once,
checks that it did not change, hashes those exact bytes, and writes the same
bytes into a new private temporary directory. That prevents symlink, mount,
hard-link, and check-then-copy escapes before the trust root exists. Tests use
an exact-digest launcher outside the checkout behind both final-file and parent
symlinks, proving neither can be staged.

The externally anchored launcher then snapshots the package manifest, five
static UI files, sealed recording, synthetic fixtures, demo script, decision
contract, and verifier through mount-locked no-follow descriptors. Before it
executes checkout code, it requires the decision contract and verifier to match
two SHA-256 values pinned inside the trusted launcher. A regression replaces
each executable with code that would write a host marker and proves the marker
is never created.

The launcher also rejects symlinks, hard links, mount crossings, and concurrent
source changes before any verified byte is copied to a new temporary
directory. It asserts that no symlink or `node_modules` directory exists in the
copy, runs the trusted dependency-free Node verifier with isolated home/temp
variables and empty `NODE_PATH`, serves the UI on ephemeral loopback,
fetches the page/replay/receipt, rejects an unlisted path, and removes the
temporary package. Invoking Node directly remains part of the trust boundary:
npm pre/post lifecycle hooks cannot run before the clean-room receipt.

## What the recording proves

| Evidence | Sealed value |
| --- | --- |
| Model | `gpt-5.6-terra`, medium reasoning; no Sol |
| Calls | 4 one-shot calls, 4 distinct threads |
| Roles | Scout → stale Builder → Resolver → cold Builder |
| Mission wall time | 84.829 seconds |
| Test transition | failed → passed |
| Human control | explicit `APPROVE` correction gate |
| Cold-start proof | replacement recalled in `relay:builder-cold:transcript-free` |
| Locally accounted run cost | 5.8096 Codex units |
| Recording root | `69d6f7f30d5603bcf514cea657aeb2a9bf1b6ff8b6712d5cfce6b5c33aae30be` |
| Mission receipt | `ef04b66dadcb31af5312cce5a820662ae7169e6cece33e16e39a7abba3433013` |
| Fixture root | `19d7d6dd86e6ea98ab49b65512392d09e69cd535cbd3224ca077f0d69f0fa6ec` |
| Privacy | synthetic fixtures only; production data read `false` |

The artifacts retain structured outputs, hashes, usage, evidence locators, and
receipts. They intentionally omit raw prompts, transcripts, JSONL, credentials,
and private account ledgers.

## Live path, clearly separated

The live mission is not necessary for judging and would spend credits. On a
Linux x64 development checkout with dependencies installed, Codex CLI 0.144.4
or compatible, ChatGPT authentication, and user/mount/network namespace
support, this preflight performs **zero inference calls**:

```bash
pnpm relay:preflight
```

That plain command is for a fresh checkout. The canonical Build Week workspace
also retains the private, blocked ledger from an earlier rejected generic
`gpt-5.6` alias attempt. Its reviewed zero-call command explicitly quarantines
that ledger and reduces the usable budget by 300 conservative units:

```bash
pnpm relay:preflight -- \
  --quarantine-uncertain-alias-ledger .remnic/relay/codex-credit-ledger.json
```

The private `.remnic/` ledgers are intentionally not part of the judge package
or repository. Their sanitized adjustment and final run totals are committed as
`budget-adjustment.json` and `credit-receipt.json` evidence instead.

It fails closed unless it can report the exact model (`gpt-5.6-terra`), medium
reasoning, maximum four calls, credit cap/reserve policy, isolated memory root,
loopback-only Remnic MCP with only `remnic.recall`, network namespace, chroot,
and `solAllowed: false`. `pnpm relay:live -- --approve-correction APPROVE` is
operator-only and should not be used by judges; the committed recording is the
reproducible competition evidence.

## Supported environment

- Offline judge package: Linux with procfs and Node.js 22.12+ using Node
  built-ins only. It uses `descriptor-pinned-nofollow-mount-locked` and includes
  that mode in every receipt. Linux x64 is independently clean-room verified on Node
  22.23.1. macOS and Windows are intentionally unsupported for executable
  verification because Node does not expose equivalent parent-component
  no-follow traversal there; use the public video/gallery or a Linux
  environment instead.
- Live isolated runner: Linux x64 only; it requires `unshare`, mount namespaces,
  a network namespace, `chroot`, and loopback proxy support.
- Browser audit: Chromium/Chrome 151 at 1440 × 900 and 390 × 844, including
  keyboard navigation and reduced-motion behavior.

## Troubleshooting and cleanup

- `Unsupported engine`: run `node --version`; use Node 22.12 or newer.
- `requires Linux with procfs`: move the checkout to a Linux environment. Do
  not bypass the gate; no pathname-only fallback is treated as equivalent
  evidence.
- Port 4173 busy: run `node scripts/relay/judge-package.mjs serve --port 4180`.
- Integrity or semantic verification failure: do not bypass it. Restore the
  committed files and rerun; a changed byte or causal claim is intentionally a
  hard failure.
- Launcher digest mismatch: stop. Cross-check the expected digest against the
  GitHub trust-root comment, then obtain a clean copy of the launcher; never
  execute the mismatched checkout copy.
- Live preflight reports namespace/chroot failure: use the offline judge path;
  the host is not supported for a live run.
- Stop the demo with `Ctrl+C`. It binds only `127.0.0.1`, writes no Remnic data,
  and starts no persistent daemon. The clean-room command removes its own
  temporary directory unless invoked directly with `--keep`.

For the evidence-to-claim mapping, see [CLAIMS.md](CLAIMS.md). For the measured
video plan, see [DEMO-SCRIPT.md](DEMO-SCRIPT.md).
