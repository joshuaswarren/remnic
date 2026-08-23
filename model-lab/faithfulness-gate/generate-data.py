#!/usr/bin/env python3
"""Faithfulness-gate synthetic data generator (issue #1585 PR1).

Produces labeled ``(factText, quote, context) → {entailed, contradicted,
unsupported}`` triples matching the :class:`FaithfulnessCheckInput` contract
from issue #1576. Labels are **trustworthy by construction**: every example
is produced by a pure perturbation function in ``perturbations.py``, so no
model is in the loop and no annotation can disagree with the transform.

Reproducibility contract
------------------------
*Same seed → same dataset bytes → same sha256*, across machines and Python
builds. The generator uses a dedicated ``random.Random(seed)`` (never the
global RNG), serializes rows with ``sort_keys=True``, and shuffles the final
record order with the seeded RNG so two runs with different seeds almost
surely produce different bytes (and thus different hashes). This is the only
CI-testable piece of the model lab — it runs on CPU with no third-party deps.

Outputs
-------
* ``<out>/faithfulness-train.jsonl`` — the dataset (gitignored).
* ``<out>/dataset.sha256`` — the dataset hash (gitignored).
* stdout gains ``DATASET_SHA256=<hex>`` for machine parsing.

The harvest stream (teacher labels from #1576 shadow mode) is NOT here — it
lands with the #1585 GPU-run follow-up once #1576 shadow mode exists.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Make the sibling ``common`` package importable (the script dir is on
# sys.path[0]; the model-lab root is not). Done once, explicitly.
_MODEL_LAB_ROOT = Path(__file__).resolve().parents[1]
if str(_MODEL_LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(_MODEL_LAB_ROOT))

from common.jsonl_schema import (  # noqa: E402
    LABELS,
    assert_dataset,
)
from common.seeding import sha256_bytes, write_jsonl  # noqa: E402

import perturbations  # noqa: E402  (sibling module, same dir)


DEFAULT_SEED = 1337
DEFAULT_OUT = Path(__file__).resolve().parent / "data"


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="generate-data.py",
        description=(
            "Generate seeded synthetic faithfulness-gate training data "
            "(issue #1585 PR1). Same seed → same sha256. CPU-only, no deps."
        ),
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--selfcheck",
        action="store_true",
        help="run the perturbation self-test table, print JSON, and exit "
             "(used by the CI determinism/perturbation test; exit code 0 on "
             "all-pass, 1 on any failure).",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=DEFAULT_SEED,
        help=f"dataset seed (default: {DEFAULT_SEED}). Same seed → same bytes.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"output directory (default: {DEFAULT_OUT}). Created if missing. "
             "Gitignored — pass a temp dir for CI.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="non-interactive: skip the 'will write to <out>' confirmation "
             "(required for CI / piped runs).",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="suppress progress on stderr; still emit DATASET_SHA256 on stdout.",
    )
    return parser


def run_selfcheck() -> int:
    result = perturbations.run_selftest()
    print(json.dumps(result, indent=2))
    return 0 if result["allPassed"] else 1


def generate(args: argparse.Namespace) -> int:
    records = perturbations.generate_dataset(args.seed)
    assert_dataset(records)  # raises on any invalid record — fail loud, never silent.

    out_dir: Path = args.out
    if not args.yes and out_dir.exists() and any(out_dir.iterdir()):
        confirm = input(f"Clear and write {len(records)} records to {out_dir}? [y/N] ")
        if confirm.strip().lower() not in {"y", "yes"}:
            if not args.quiet:
                print("aborted.", file=sys.stderr)
            return 1
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = [record.to_jsonl_dict() for record in records]
    dataset_path = out_dir / "faithfulness-train.jsonl"
    digest = write_jsonl(rows, dataset_path)

    # Sidecar hash file for offline reproducibility checks.
    (out_dir / "dataset.sha256").write_text(digest + "\n", encoding="utf-8")

    counts = perturbations.label_counts(records)
    if not args.quiet:
        print(
            f"wrote {len(records)} records to {dataset_path} "
            f"(entailed={counts['entailed']} contradicted={counts['contradicted']} "
            f"unsupported={counts['unsupported']})",
            file=sys.stderr,
        )
    # Machine-parseable result on stdout.
    print(f"DATASET_SHA256={digest}")
    print(f"DATASET_PATH={dataset_path}")
    print(f"DATASET_RECORDS={len(records)}")
    print(f"DATASET_SEED={args.seed}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    if args.selfcheck:
        return run_selfcheck()
    return generate(args)


if __name__ == "__main__":
    sys.exit(main())
