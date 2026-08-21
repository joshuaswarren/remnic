#!/usr/bin/env python3
"""Correction-intent synthetic data generator (issue #1585 PR3).

Generates a labeled conversation dataset by instantiating the #1581 morphology
grammar (``morphology.py``) against a substitution table. Every record's label
is derivable from the grammar — corrections come from the correction-signal
bank, ``none`` labels come from the anti-example + clean-turn banks — so the
labels are trustworthy by construction (no human annotation, no LLM traces).

Determinism contract (identical to the faithfulness generator): *same seed →
byte-identical dataset → identical sha256*. The CI determinism probe asserts
this without committing any data (generate small-N in a temp dir, hash it).

Pure stdlib — ``python model-lab/correction-intent/generate-data.py`` works on
a bare machine with no ``pip install``. The only CI-testable piece of the
model-lab correction-intent pipeline.

Usage:
    python model-lab/correction-intent/generate-data.py --selfcheck
    python model-lab/correction-intent/generate-data.py --seed 1337 --out /tmp/ci --yes
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_MODEL_LAB_ROOT = Path(__file__).resolve().parents[1]
if str(_MODEL_LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(_MODEL_LAB_ROOT))

from common.seeding import deterministic_rng, write_jsonl  # noqa: E402

import morphology  # noqa: E402  (sibling module, same dir)

DEFAULT_SEED = 1337
DEFAULT_OUT = Path(__file__).resolve().parent / "data"


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Correction-intent synthetic data generator (issue #1585 PR3).",
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="RNG seed (default 1337).")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output directory.")
    parser.add_argument("--yes", action="store_true", help="Skip the overwrite confirmation.")
    parser.add_argument(
        "--selfcheck",
        action="store_true",
        help="Run the morphology selftest against hand-written cases and exit.",
    )
    return parser


def run_selfcheck() -> int:
    """Run SELFTEST_CASES; emit JSON; exit 0 iff every case matches."""
    result = run_morphology_selftest()
    print(json.dumps(result, indent=2))
    return 0 if result["allPassed"] else 1


def run_morphology_selftest() -> dict[str, object]:
    """Assert every selftest morphology produces its expected label.

    Pure — no I/O. Exported so the CI node probe can call it via ``--selfcheck``
    AND so the GPU train script can sanity-check the grammar before a run.
    """
    by_morph: dict[str, str] = {}
    for sc in morphology.CORRECTION_SCENARIOS:
        by_morph[sc.morphology] = "correction"
    for ae in morphology.ANTI_EXAMPLES:
        by_morph[ae.morphology] = "none"

    cases: list[dict[str, object]] = []
    all_passed = True
    for case in morphology.SELFTEST_CASES:
        got = by_morph.get(case.morphology)
        passed = got == case.expected_label
        if not passed:
            all_passed = False
        cases.append({
            "morphology": case.morphology,
            "expected": case.expected_label,
            "actual": got,
            "passed": passed,
            "description": case.description,
        })
    return {"allPassed": all_passed, "cases": cases}


def _prior_window(rng) -> list[dict[str, str]]:
    """A small non-correction prior window so the model sees context."""
    clean = morphology.CLEAN_TURNS
    templates = rng.sample(list(clean), k=min(2, len(clean)))
    pair = rng.choice(morphology.SUBSTITUTIONS)
    return [{"role": "user", "content": t.replace("{old}", pair[0]).replace("{new}", pair[1])}
            for t in templates]


def generate_dataset(seed: int) -> list[morphology.ConversationRecord]:
    """Instantiate the grammar into a labeled, balanced dataset.

    Corrections: every scenario × every substitution pair.
    None: every anti-example × every pair + every clean turn × every pair.
    Deterministic in ``seed`` (the RNG only shuffles the prior window).
    """
    rng = deterministic_rng(seed)
    records: list[morphology.ConversationRecord] = []

    # Corrections: scenario × substitution.
    for sc in morphology.CORRECTION_SCENARIOS:
        for pair in morphology.SUBSTITUTIONS:
            turn = morphology._fill(sc.template, pair)
            correction = sc.build_correction(turn)
            records.append(morphology.ConversationRecord(
                turns=_prior_window(rng) + [{"role": "user", "content": turn}],
                label="correction",
                corrections=[correction],
                morphology=sc.morphology,
                sourceId=f"{sc.morphology}:{pair[0]}->{pair[1]}",
            ))

    # Anti-examples → none.
    for ae in morphology.ANTI_EXAMPLES:
        for pair in morphology.SUBSTITUTIONS:
            turn = morphology._fill(ae.template, pair)
            records.append(morphology.ConversationRecord(
                turns=_prior_window(rng) + [{"role": "user", "content": turn}],
                label="none",
                corrections=[],
                morphology=ae.morphology,
                sourceId=f"{ae.morphology}:{pair[0]}->{pair[1]}",
            ))

    # Clean turns → none.
    for clean in morphology.CLEAN_TURNS:
        for pair in morphology.SUBSTITUTIONS:
            turn = morphology._fill(clean, pair)
            records.append(morphology.ConversationRecord(
                turns=_prior_window(rng) + [{"role": "user", "content": turn}],
                label="none",
                corrections=[],
                morphology="clean",
                sourceId=f"clean:{clean}:{pair[0]}->{pair[1]}",
            ))

    morphology.assert_dataset(records)
    return records


def label_counts(records: list[morphology.ConversationRecord]) -> dict[str, int]:
    counts = {label: 0 for label in morphology.LABELS}
    for r in records:
        counts[r.label] = counts.get(r.label, 0) + 1
    counts["total"] = len(records)
    return counts


def generate(args: argparse.Namespace) -> int:
    if args.out.exists() and not args.yes:
        print(f"output directory exists: {args.out}\npass --yes to overwrite", file=sys.stderr)
        return 2
    args.out.mkdir(parents=True, exist_ok=True)
    records = generate_dataset(args.seed)
    train_path = args.out / "train.jsonl"
    rows = [r.to_jsonl_dict() for r in records]
    sha = write_jsonl(rows, train_path)
    counts = label_counts(records)
    print(f"wrote {len(rows)} records → {train_path}")
    print(f"counts: {counts}")
    print(f"DATASET_SHA256={sha}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    if args.selfcheck:
        return run_selfcheck()
    return generate(args)


if __name__ == "__main__":
    sys.exit(main())
