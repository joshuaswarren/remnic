#!/usr/bin/env python3
"""Consent-gated, local-only shadow-telemetry label harvester (issue #2852).

The generic CLI over :mod:`common.harvest`. Reads an operator's OWN persisted
shadow telemetry and emits deterministic JSONL labeled training records for
retraining the model-lab classifiers:

* ``--task faithfulness-gate`` — memory markdown files carrying the #1576
  ``faithfulness:`` verdict frontmatter (+ the #1575 verified quote span).
* ``--task correction-intent`` — persisted correction-plan JSON files (the
  #1581 detector's durable output).

Hard gates, all enforced BEFORE anything is read:

1. ``--consent`` — explicit, informed, per-invocation opt-in. Without it the
   tool exits 2 without touching the input.
2. ``--input`` / ``--out`` — explicit local paths. The input must be an
   existing directory (lstat; a symlink root is refused). The tool walks
   exactly that directory, skips descendant symlinks, and refuses a path
   that escapes the root. No vault scan, no home-dir discovery.
3. ``--out`` must not overlap ``--input`` (equal, inside it, or containing
   it) and must be empty or ``--yes``. Overlap would let one run's outputs
   become the next run's inputs (issue #2886).

Outputs under ``--out`` (all deterministic; same input tree → same bytes):

* ``harvest-<task>.jsonl``      the labeled records (task's canonical schema)
* ``harvest-<task>.manifest.json``  dataset provenance + sha256 (no clocks,
  no absolute paths, no content)
* ``dataset.sha256``            sidecar hash, same contract as the generators

Datasets are local-only: keep ``--out`` under a gitignored data dir (e.g.
``model-lab/<task>/data/harvest/`` — already covered by ``model-lab/**/data/``).
Nothing in the daemon, build, or CI ever invokes this tool (issue #2852).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_MODEL_LAB_ROOT = Path(__file__).resolve().parent
if str(_MODEL_LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(_MODEL_LAB_ROOT))

from common.harvest import (
    DEFAULT_MAX_RECORDS,
    DEFAULT_MAX_TEXT_BYTES,
    TASKS,
    require_input_dir,
    run_harvest,
)

#: Exit code for every refusal (consent, bad paths, dirty out dir). A refusal
#: is not a harvest failure — keep it distinct from Python error exits.
REFUSAL_EXIT = 2


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harvest.py",
        description=(
            "Opt-in, local-only harvest of persisted shadow telemetry into "
            "labeled model-lab training records (issue #2852). Refuses to run "
            "without --consent and explicit --input/--out paths."
        ),
    )
    parser.add_argument(
        "--task",
        required=True,
        choices=TASKS,
        help="Which model-lab classifier the labels train.",
    )
    parser.add_argument(
        "--input",
        required=True,
        type=Path,
        help=(
            "Local directory of persisted telemetry to read (.md memory files "
            "for faithfulness-gate, plan .json files for correction-intent). "
            "Exactly this directory is walked; a symlink root is refused."
        ),
    )
    parser.add_argument(
        "--out",
        required=True,
        type=Path,
        help=(
            "Local output directory for the JSONL dataset + provenance "
            "manifest. Keep it under a gitignored data dir (git carries "
            "recipes + hashes, never blobs)."
        ),
    )
    parser.add_argument(
        "--consent",
        action="store_true",
        help=(
            "Explicit, informed consent: I am the operator of this data, it "
            "stays on this machine, and I want it turned into training "
            "records. The tool refuses to run without this flag."
        ),
    )
    parser.add_argument(
        "--max-records",
        type=int,
        default=DEFAULT_MAX_RECORDS,
        help=f"Hard cap on emitted records (default {DEFAULT_MAX_RECORDS}).",
    )
    parser.add_argument(
        "--max-text-bytes",
        type=int,
        default=DEFAULT_MAX_TEXT_BYTES,
        help=(
            "Skip any input file larger than this many bytes before reading "
            "or hashing it. Records whose text fields exceed it are also "
            f"skipped, never truncated (default {DEFAULT_MAX_TEXT_BYTES})."
        ),
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Write into a non-empty --out directory without asking.",
    )
    parser.add_argument("--quiet", action="store_true", help="Suppress the stderr summary.")
    return parser


def _refuse(message: str) -> int:
    print(message, file=sys.stderr)
    return REFUSAL_EXIT


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(
        list(sys.argv[1:] if argv is None else argv)
    )

    # Gate 1: consent — before any filesystem access beyond arg parsing.
    if not args.consent:
        return _refuse(
            "harvest.py requires explicit, informed consent.\n"
            "  re-run with: --consent\n"
            "This flag is intentional friction (issue #2852): harvest reads\n"
            "your own persisted memory telemetry from --input and turns it\n"
            "into local training records. Nothing was read."
        )

    try:
        require_input_dir(args.input)
    except (ValueError, NotADirectoryError) as err:
        return _refuse(str(err))
    input_resolved = args.input.resolve()
    out_resolved = args.out.resolve()
    if (
        out_resolved == input_resolved
        or out_resolved in input_resolved.parents
        or input_resolved in out_resolved.parents
    ):
        return _refuse(
            "--out must not overlap --input (equal, ancestor, or descendant)"
        )
    if args.out.exists() and not args.out.is_dir():
        return _refuse(f"--out exists and is not a directory: {args.out}")
    if args.out.exists() and any(args.out.iterdir()) and not args.yes:
        return _refuse(
            f"--out is not empty: {args.out}\n"
            "  pass --yes to overwrite, or point --out at an empty directory"
        )

    print(
        f"[consent] task={args.task} reading persisted telemetry under: {args.input.resolve()}\n"
        f"[consent] files read: *{'.md (memory files with faithfulness: verdict frontmatter)' if args.task == 'faithfulness-gate' else '.json (persisted correction plans)'}\n"
        f"[consent] fields kept: the task's training schema only — session keys,\n"
        "[consent]           principals, namespaces, memory ids, and model ids are never emitted.\n"
        f"[consent] writing local-only dataset to: {args.out.resolve()}",
        file=sys.stderr,
    )

    try:
        digest, dataset_path, result = run_harvest(
            args.task,
            args.input,
            args.out,
            max_records=args.max_records,
            max_text_bytes=args.max_text_bytes,
        )
    except (ValueError, NotADirectoryError) as err:
        return _refuse(f"harvest refused: {err}")

    if not args.quiet:
        skip_summary = (
            ", ".join(f"{reason}={count}" for reason, count in result.skips.items())
            or "none"
        )
        label_summary = " ".join(f"{k}={v}" for k, v in result.label_counts.items())
        print(
            f"wrote {len(result.rows)} records to {dataset_path} "
            f"({label_summary})\n"
            f"skipped: {skip_summary}\n"
            f"deduped: {result.deduped}, truncated: {result.truncated}",
            file=sys.stderr,
        )
    # Machine-parseable result on stdout (same contract as generate-data.py).
    print(f"HARVEST_SHA256={digest}")
    print(f"HARVEST_PATH={dataset_path}")
    print(f"HARVEST_RECORDS={len(result.rows)}")
    print(f"HARVEST_BYTES_READ={result.bytes_read}")
    print(f"HARVEST_TASK={args.task}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
