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
8. **Rescan ClawHub.** After npm publishing, the workflow triggers a ClawHub
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
