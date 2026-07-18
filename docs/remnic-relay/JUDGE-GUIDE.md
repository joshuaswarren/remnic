# Judge guide: Remnic Relay

Remnic Relay is memory that can repair an agent team: it exposes conflicting
beliefs, requires a human-approved correction, retires the stale decision, and
proves a transcript-free cold agent used the replacement to turn the same test
from red to green.

## Run the complete judge experience

Prerequisites:

- a checkout of this public MIT-licensed repository;
- Node.js 22.12 or newer with npm;
- a desktop browser.

No install, build, account, credential, dataset download, model call, or
network access is required after the repository is available.

```bash
npm run relay:demo
```

Expected terminal output begins with:

```text
RELAY_JUDGE_PACKAGE_OK root=e5dc82d98118120171e2a4a9c7a5e87de966e86c8ee7cfa59e30e4545be16a6e ui=e202cc6463501b5089b82b090d86c7d566969ba3e09451a441831fe5c0b5e0b4 model=gpt-5.6-terra calls=4
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
npm run relay:judge
```

Expected output:

```text
RELAY_JUDGE_PACKAGE_OK root=e5dc82d98118120171e2a4a9c7a5e87de966e86c8ee7cfa59e30e4545be16a6e ui=e202cc6463501b5089b82b090d86c7d566969ba3e09451a441831fe5c0b5e0b4 model=gpt-5.6-terra calls=4 transition=failed->passed externalCalls=0 productionDataRead=false
```

The dependency-free verifier does not merely trust the final JSON. It:

- rehashes the exact recording and synthetic fixture trees;
- pins the canonical recording root and mission receipt;
- binds four distinct Codex threads to four committed prompt hashes and four
  retained structured-output hashes;
- verifies stale recall, human approval, supersession, replacement recall,
  cold-start propagation, and the `failed → passed` test transition across 16
  ordered mission events;
- independently recomputes `gpt-5.6-terra` credit units from per-call usage;
- independently recomputes the mission-receipt digest from the final snapshot;
- pins every byte in the five-file Mission Control package to one reviewed UI
  root and verifies the browser replay against the final sealed event trace;
- scans all 39 copied recording, fixture, UI, demo, and package-manifest text
  files for secret-like and host-private material; and
- measures the demo narration at 326 words: 135 seconds at 145 words per
  minute, plus a 30-second action allowance, for an estimated 165 seconds.

## Clean-room smoke

```bash
npm run relay:judge:clean-room
```

Expected output on the verified platform:

```text
RELAY_JUDGE_CLEAN_ROOM_OK platform=linux/x64 node=v22.23.1 root=e5dc82d98118120171e2a4a9c7a5e87de966e86c8ee7cfa59e30e4545be16a6e ui=e202cc6463501b5089b82b090d86c7d566969ba3e09451a441831fe5c0b5e0b4 dependencies=0 externalCalls=0 productionDataRead=false sensitiveFiles=39
```

This command copies only the package manifest, five static UI files, sealed
recording, synthetic fixtures, demo script, and verifier into a new temporary
directory. It asserts that no symlink or `node_modules` directory exists, runs
the exact npm verifier with isolated `HOME`, `TMPDIR`, and empty `NODE_PATH`,
serves the UI on ephemeral loopback, fetches the page/replay/receipt, rejects
an unlisted path, and removes the temporary package.

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
| Recording root | `e5dc82d98118120171e2a4a9c7a5e87de966e86c8ee7cfa59e30e4545be16a6e` |
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

It fails closed unless it can report the exact model (`gpt-5.6-terra`), medium
reasoning, maximum four calls, credit cap/reserve policy, isolated memory root,
loopback-only Remnic MCP with only `remnic.recall`, network namespace, chroot,
and `solAllowed: false`. `pnpm relay:live -- --approve-correction APPROVE` is
operator-only and should not be used by judges; the committed recording is the
reproducible competition evidence.

## Supported environment

- Offline judge package: Node.js 22.12+, with Linux x64 verified on Node
  22.23.1. It uses Node built-ins only. Other desktop platforms are not claimed
  as independently verified.
- Live isolated runner: Linux x64 only; it requires `unshare`, mount namespaces,
  a network namespace, `chroot`, and loopback proxy support.
- Browser audit: Chromium/Chrome 151 at 1440 × 900 and 390 × 844, including
  keyboard navigation and reduced-motion behavior.

## Troubleshooting and cleanup

- `Unsupported engine`: run `node --version`; use Node 22.12 or newer.
- Port 4173 busy: run `npm run relay:demo -- --port 4180`.
- Integrity or semantic verification failure: do not bypass it. Restore the
  committed files and rerun; a changed byte or causal claim is intentionally a
  hard failure.
- Live preflight reports namespace/chroot failure: use the offline judge path;
  the host is not supported for a live run.
- Stop the demo with `Ctrl+C`. It binds only `127.0.0.1`, writes no Remnic data,
  and starts no persistent daemon. The clean-room command removes its own
  temporary directory unless invoked directly with `--keep`.

For the evidence-to-claim mapping, see [CLAIMS.md](CLAIMS.md). For the measured
video plan, see [DEMO-SCRIPT.md](DEMO-SCRIPT.md).
