# Open Knowledge Format (OKF)

Remnic memory directories are OKF v0.1 knowledge bundles: markdown files with YAML frontmatter. `category` stays the canonical Remnic field. `type` is inert interop metadata.

Spec (v0.1 revision): https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/ee67a5ca27044ebe7c38385f5b6cffc2305a9c1a/okf/SPEC.md

## Commands

| Command | Behavior |
|---|---|
| `remnic okf lint` | Report missing frontmatter or `type`. Encrypted files are skipped. Exit 1 when findings remain. `--json` prints the result object. |
| `remnic okf sweep` | Add missing `type` values without bumping `updated`. Gated by `okf.sweepEnabled`. |
| `remnic export okf --out <dir>` | Write a portable OKF v0.1 bundle (lossy interchange). Capsules stay the lossless Remnic transport. |

## Capsule vs OKF export

| | Capsule | OKF export |
|---|---|---|
| Command | `remnic capsule export` | `remnic export okf --out <dir>` |
| Shape | `.capsule.json.gz[.enc]` | Directory of markdown + `index.md` |
| Fidelity | Lossless Remnic transport | Lossy interchange / publication |
| Default contents | Full store | Active memories only; no profile, wearables, or `state/` |


Lint walks every `.md` file under the memory directory, skipping `state/`, `.git/`, and symlinks. Findings carry a stable code:

| Code | Meaning |
|---|---|
| `missing_frontmatter` | File has no YAML frontmatter block. |
| `missing_type` | Frontmatter has no `type` key. |
| `empty_type` | `type` is present but empty. |
| `reserved_basename` | `index.md` or `log.md` at any depth — OKF §6/§7 reserves these basenames for bundle-level files, and Remnic writes targeting them are rejected. |
| `skipped_encrypted` | File is a secure-store encrypted envelope. Informational; does not affect the exit code. |

Sweep fixes only `missing_type` and `empty_type` findings, deriving the value from the file's `category`.

## Config

```json
{
  "okf": {
    "conformanceEnabled": true,
    "sweepEnabled": false
  }
}
```

`conformanceEnabled: false` stops new `type` emission and profile frontmatter. `sweepEnabled: false` is the documented disable for the legacy backfill.

## Mapping

Source of truth: `packages/remnic-core/src/okf/type-mapping.ts`. The tables below mirror it exactly; change both together.

### Memory categories

| `category` | `type` |
|---|---|
| `fact` | `Memory Fact` |
| `decision` | `Decision` |
| `preference` | `Preference` |
| `commitment` | `Commitment` |
| `relationship` | `Relationship` |
| `principle` | `Principle` |
| `moment` | `Moment` |
| `skill` | `Skill` |
| `correction` | `Correction` |
| `rule` | `Rule` |
| any other category | `Memory` |

Memories carrying an `artifactType` report `Artifact` regardless of category.

### Entity kinds

| Entity `kind` | `type` |
|---|---|
| `person` | `Person` |
| `company` | `Company` |
| `organization` | `Organization` |
| `project` | `Project` |
| `topic` | `Topic` |
| `technology` | `Technology` |
| `place` | `Place` |
| `event` | `Event` |
| any other or missing kind | `Entity` |

### Other written files

| File | `type` |
|---|---|
| `profile.md` | `Profile` (frontmatter header on the profile body) |
| question files | `Question` |
