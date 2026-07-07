#!/usr/bin/env python3
"""Correction-intent shadow-log harvest STUB (issue #1585 PR3).

The harvest stream reads an operator's own #1581 passive-correction telemetry
(the detector's captured corrections, plus an optional frontier-teacher label
on a sampled slice for generator label-quality validation) and turns it into
additional training data. It is **opt-in, local-only, and documented** — the
operator consents with ``--i-consent-local-data`` and the script prints exactly
what it will read.

This PR (PR3) does NOT implement harvest: it depends on #1581 telemetry
landed + a teacher-labeling pass. The script exits with a clear message so an
operator cannot accidentally invoke a half-wired pipeline. The follow-up wires
the real reader once the shadow stream is producing teacher labels.

Exit code 2 distinguishes "not yet implemented" from a normal failure.
"""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    consent = "--i-consent-local-data" in argv
    if not consent:
        print(
            "harvest-shadow-logs.py requires explicit, informed consent.\n"
            "  re-run with: --i-consent-local-data\n"
            "This flag is intentional friction: harvest reads your own passive-\n"
            "correction telemetry from your own memoryDir and nothing leaves the\n"
            "machine, but the operator must opt in per session (issue #1585).",
            file=sys.stderr,
        )
        return 2
    print(
        "harvest-shadow-logs.py is not implemented in PR3.\n"
        "  requires: #1581 telemetry (captured corrections) + a teacher-labeling pass\n"
        "  lands in: the #1585 GPU-run follow-up once the shadow stream produces labels\n"
        "  reads:    passive-correction captures from <memoryDir> (local only)\n"
        "  emits:    additional JSONL rows under correction-intent/data/harvest/\n"
        "  reports:  teacher-vs-generator label agreement in the manifest\n"
        "No data was read. See model-lab/README.md.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
