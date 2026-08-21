#!/usr/bin/env python3
"""Shadow-log harvest STUB (issue #1585 PR1).

The harvest stream reads an operator's own #1576 shadow-mode telemetry
(``faithfulness: {verdict, model, at}`` frontmatter recorded by the prompted
frontier model acting as teacher) and turns it into additional training data.
It is **opt-in, local-only, and documented** — the operator consents with
``--i-consent-local-data`` and the script prints exactly what it will read.

This PR (PR1) does NOT implement harvest: it depends on #1576 shadow mode,
which lands in a later wave. The script exits with a clear message so an
operator cannot accidentally invoke a half-wired pipeline. PR2/PR3 wires the
real reader once #1576 shadow mode exists.

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
            "This flag is intentional friction: harvest reads your own memory\n"
            "telemetry from your own memoryDir and nothing leaves your machine,\n"
            "but the operator must opt in per session (issue #1585).",
            file=sys.stderr,
        )
        return 2
    print(
        "harvest-shadow-logs.py is not implemented in PR1.\n"
        "  requires: #1576 shadow mode (faithfulness gate recording verdicts)\n"
        "  lands in: PR2 once the shadow stream is producing teacher labels\n"
        "  reads:    faithfulness frontmatter from <memoryDir> (local only)\n"
        "  emits:    additional JSONL rows under faithfulness-gate/data/harvest/\n"
        "No data was read. See model-lab/README.md.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
