# Release process

How Remnic versions and publishes its packages. Releases are automated by
`.github/workflows/release-and-publish.yml` and driven by merged pull-request
labels, not by a manual version-bump file. There is no Changesets step: a
changeset records the change's stability level for review and promotion (see
[../releases.md](../releases.md)), and never drives the version.

Every merge publishes to the npm `alpha` dist-tag. `beta` and `latest` are
dist-tag moves performed by `release-promote.yml` — see
[../releases.md](../releases.md) for the channel model and cut rules.

## How a release happens

Every push to `main` runs the release workflow. It is idempotent: the release
commit's source SHA is embedded in the git tag, so re-running against the same
`main` SHA reuses the existing tag instead of cutting a duplicate release.

1. **Quality gates.** The workflow runs `pnpm run check-types`, `pnpm test`,
   `pnpm run build`, and `node scripts/check-release-artifacts.mjs`. A failure
   here stops the release before anything is tagged or published.
2. **Resolve the bump type from the merged PR's labels.** The workflow finds
   the PR that introduced the head commit and reads its labels:
   - `major` or `breaking-change` -> **major** bump
   - `feature` or `enhancement` -> **minor** bump
   - anything else -> **patch** bump
3. **Compute the next version.** The next version is derived from the latest
   `vX.Y.Z` tag plus the resolved bump. If the root `package.json` version is
   *higher* than that auto-bump, `package.json` wins — this lets a PR set an
   intentional version (for example jumping to a new minor) and have it stick.
4. **Set versions across the workspace.** `scripts/set-release-version.mjs`
   writes the release version into the root and every workspace
   `package.json`, plus the OpenClaw and Claude Code plugin manifests. Changed
   workspace packages are bumped relative to the previous release tag by
   `scripts/bump-changed-packages.mjs`.
5. **Commit and tag.** The release commit (`chore(release): vX.Y.Z [skip ci]`)
   is pushed to `main` via a deploy key, and an annotated `vX.Y.Z` tag is
   created on it. The tag message records `source-main-sha:` for the
   idempotency check above.
6. **Generate the publish order.** `scripts/publish-order.mjs` topologically
   sorts the public workspace packages over their dependencies,
   optionalDependencies, and required peerDependencies (optional peers are
   excluded). The order is written to a temp file the publish step reads.
7. **Publish to npm.** Packages publish in that order with `pnpm publish`
   (see below), onto the `alpha` dist-tag. npm 11.x is pinned so provenance /
   trusted-publishing behavior only changes through review; all publishes carry
   provenance attestations.
8. **Dispatch the native-helper publish.** After the GitHub release is created
   and the npm publish step has run, the workflow dispatches
   `capture-native-helper.yml` via `workflow_dispatch` at the release tag.
   The helper then runs its `swift` job (rebuilds the unified Swift helper on
   real macOS runners) and its `publish` job (uploads the binary to npm via
   trusted publishing, on the `alpha` dist-tag). The dispatch is best-effort
   relative to the main release: `continue-on-error: true` is set, and any
   failure is surfaced via `::warning::` and a job-summary block, so it
   cannot fail the ClawHub step or the npm publish that already completed.
   The helper's `publish` job guards itself in two stages:

   - The job `if` requires `startsWith(github.ref, 'refs/tags/v')` so
     branch refs and non-v tag refs cannot enter the dispatch path.
   - A dedicated `Validate ref is a vX.Y.Z tag` step reads github.ref
     through `env: DISPATCH_REF` (not direct bash-source interpolation,
     which would let a tag name like `v$(cmd)` execute inside this
     trusted-publishing job before the regex rejects it) and runs
     `[[ "${DISPATCH_REF}" =~ ^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$ ]]`,
     setting `is_release_tag`; every step that touches `pnpm publish`
     is gated on that output.

   GitHub Actions expressions do not support the `=~` operator, so the
   vX.Y.Z anchor cannot live in the job-level `if` (the REST API
   returns HTTP 422 on `workflow_dispatch` for a workflow file that
   tries). The two-stage gate keeps the ref check strict and parsable. Passing
   the ref through an environment variable prevents tag-name shell metacharacters
   from being interpreted as code.

   The initial authenticated seed publish and npm trusted-publisher setup require
   a maintainer. Until both are complete, the helper fails with the message
   `::error::Provision npm trusted publishing for <pkg>, then rerun this workflow.`
   See [Native helper publish](#native-helper-publish) for the required sequence.
   The `release-promote.yml` gate remains strict: a release without both Darwin
   packages at the exact version on npm is incomplete and cannot be promoted.
9. **Rescan ClawHub.** After npm publishing, the workflow triggers a ClawHub
   package rescan for `@remnic/plugin-openclaw`.

### Manual override

Trigger the workflow via `workflow_dispatch` with a `version_override` input
(for example `10.0.0`) to publish an exact version and skip the label-based
auto-bump. The workflow refuses an override whose tag already exists.

### Bootstrap releases

When `@remnic/core` is not yet on npm (a brand-new package name), the workflow
treats the root `package.json` version as authoritative instead of inheriting
the previous tag line. This prevents a first public publish from starting at
the wrong version.

## Why pnpm, and the E404 carve-out

Packages publish with **`pnpm publish`, not `npm publish`**, because pnpm
rewrites `workspace:^` / `workspace:*` specifiers to real version numbers at
pack time. `npm publish` does not, which would leak `workspace:^` verbatim into
published metadata (issue #403).

The publish loop is à-la-carte: optional surfaces (bench, weclone, importers,
plugins) all ship so users can install only what they need. A package that npm
rejects with **E404 on its very first publish** — trusted publishing not yet
provisioned for that name — is collected, surfaced loudly, and skipped so it
does not strand every package after it in the topological order. Any other
publish failure is fatal.

## Published packages

25 packages publish to npm; one dashboard is private; the Hermes plugin
publishes to PyPI on its own workflow. See
[monorepo-structure.md](../architecture/monorepo-structure.md) for the full
package map. Directory names differ from published names for several packages:

## Native helper publish

Two of the published packages are platform-restricted darwin binaries
(`@remnic/capture-native-darwin-arm64` and `@remnic/capture-native-darwin-x64`).
They are built from `packages/capture-native-darwin-helper` (a Swift
package) on real macOS runners, then staged into the per-arch
`packages/capture-native-darwin-{arm64,x64}/bin/`. Only compilation needs macOS. `release-and-publish.yml`
skips the packages because it runs on Linux. `capture-native-helper.yml` builds them on macOS
and publishes on `ubuntu-latest`; the publish job uses Node 22.14.0 and pins npm 11.16.0 for OIDC trusted publishing.

### Why a `workflow_dispatch` and not the `release: published` event

`release-and-publish.yml` creates the GitHub release with the default
`GITHUB_TOKEN` (so the push to `main` can be authorized). GitHub does
**not** start workflow runs for events caused by `GITHUB_TOKEN`; only
`workflow_dispatch` and `repository_dispatch` are exempt. The
`release: published` trigger in `capture-native-helper.yml` therefore
never fires for releases this repository creates itself. To bridge that,
`release-and-publish.yml` dispatches the helper via
`gh workflow run capture-native-helper.yml --ref <tag>` after the GitHub
release exists, using the job's `GITHUB_TOKEN`. The helper accepts that
dispatch only when `github.ref_type == 'tag'` and the ref passes a
two-stage guard: the job `if` requires
`startsWith(github.ref, 'refs/tags/v')`, and a dedicated `Validate ref
is a vX.Y.Z tag` step inside the job runs bash `[[ =~ ]]` against
`^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$` and gates every downstream step
on its `is_release_tag` output. A branch dispatch (the default for
`gh workflow run` when `--ref` is omitted), a non-v tag like
`refs/tags/feature-x`, or a pre-release like `refs/tags/v9.69.90-rc.1`
cannot reach `pnpm publish`.

The dispatch is best-effort: `continue-on-error: true`, with a
`::warning::` and a job-summary block on failure, so a missing helper
publish cannot strand the npm train or be reported as an npm failure.

### One-time npm trusted-publishing provisioning

The two platform packages are published to npm via
[trusted publishing](https://docs.npmjs.com/generating-provenance-statements#publishing-packages-with-provenance-via-github-actions)
(OIDC). npm’s [trusted-publisher setup](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
requires the package to exist on the registry first. Because these package names
do not exist yet, a maintainer must seed each one with an authenticated publish
at a version below the pending release, then configure the trusted publisher.
Until both steps are complete, the helper fails with this message:

```
::error::Provision npm trusted publishing for <pkg>, then rerun this workflow.
```

To bootstrap the current release tag:

1. Publish a seed version below the pending release with an authenticated npm
   account and the `alpha` dist-tag (not `latest`). The release workflow does not
   have a token and cannot seed it. This one-time package creation requires a
   maintainer action.
2. Configure npm Trusted Publishing for this GitHub repository (use its
   `owner/repository` identifier) with workflow filename
   `capture-native-helper.yml`. Leave the Environment field blank: the workflow
   at this release tag does not declare a job environment.
3. Rerun the failed dispatch for this original release tag:

   ```sh
   gh workflow run capture-native-helper.yml --ref v<X.Y.Z>
   ```

The helper then publishes the release version with OIDC provenance.

Future hardening is optional and is not part of this PR. Create a GitHub
Environment restricted to `v*` tags, add `environment: <name>` to the publish
job in a follow-up after the environment exists, then configure npm Trusted
Publishing with that same environment name. Only publish or retry from a release
commit whose workflow contains the environment key; an older tag uses its own
workflow YAML and will not include the environment claim.

| Directory | Published name | Registry |
|---|---|---|
| `packages/remnic-core` | `@remnic/core` | npm |
| `packages/remnic-cli` | `@remnic/cli` | npm |
| `packages/remnic-server` | `@remnic/server` | npm |
| `packages/connector-replit` | `@remnic/replit` | npm |
| `packages/shim-openclaw-engram` | `@joshuaswarren/openclaw-engram` | npm |
| `packages/plugin-hermes` | `remnic-hermes` | PyPI |
| `packages/bench-ui` | (private, not published) | — |

Every other `packages/<name>` publishes as `@remnic/<name>`.

## PyPI package

`packages/plugin-hermes` (`remnic-hermes`) publishes separately via
`.github/workflows/hermes-python.yml`. To publish manually (maintainers only):

```bash
cd packages/plugin-hermes
python -m build
twine upload dist/*
```

## Marketplace publishing

- **Claude Code plugin** -> Anthropic marketplace (manual submission).
- **Codex plugin** -> OpenAI Codex marketplace (manual submission).
- **OpenClaw plugin** -> ClawHub. The workflow rescans automatically after a
  release; manual publish steps are in
  [../plugins/openclaw.md](../plugins/openclaw.md).

## Changelog

`CHANGELOG.md` is maintained by hand. Each PR adds its entry under
`[Unreleased]`; the `changelog-guard` workflow enforces this on pull requests.
The release workflow does not generate per-package changelogs.

## Backward-compatibility notes

The root `package.json` is the private workspace root and is never published.
The old `@joshuaswarren/openclaw-engram` scope now lives at
`packages/shim-openclaw-engram/` as a frozen compatibility shim: it re-exports
the OpenClaw bridge plugin, forwards `engram-access`, prints a rename banner on
install, and carries an npm deprecation notice pointing at the `@remnic/*`
packages.
