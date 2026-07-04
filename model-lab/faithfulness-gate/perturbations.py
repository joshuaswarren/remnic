"""Perturbation primitives for synthetic faithfulness data (issue #1585 PR1).

Each perturbation is a **pure function** that takes a seed triple and returns
either a labeled :class:`FaithfulnessRecord` or ``None`` (when the fixture
does not carry the target the perturbation needs — e.g. a fixture with no
date cannot be ``date_shift``ed). Because the transform is code, the label is
trustworthy by construction: there is no model in the loop and no annotation
to disagree with.

Label semantics (from issue #1585):

* ``entity_swap`` / ``negation_flip`` / ``date_shift`` / ``quantity_change``
  ⇒ ``contradicted`` — the fact now conflicts with the quote.
* ``unrelated_quote`` ⇒ ``unsupported`` — the fact may be true in isolation
  but the paired quote says nothing about it.
* ``identity`` / ``paraphrase`` ⇒ ``entailed`` — the fact is supported by the
  quote (verbatim or meaning-preserving rewrite).

The :data:`SELFTEST_CASES` table is the CI assertion surface: the node test
shells out to ``generate-data.py --selfcheck`` and requires every case to
match its expected label, so a regression in any perturbation fails CI
without a GPU.
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Callable, Optional

# Make the sibling ``common`` package importable when this file is run via
# ``python generate-data.py`` (the script dir is on sys.path, its parent is
# not). Each script that imports ``common`` does this once, explicitly.
import sys
from pathlib import Path

_MODEL_LAB_ROOT = Path(__file__).resolve().parents[1]
if str(_MODEL_LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(_MODEL_LAB_ROOT))

from common.jsonl_schema import LABELS, FaithfulnessRecord  # noqa: E402

PERTURBATIONS: tuple[str, ...] = (
    "identity",
    "paraphrase",
    "entity_swap",
    "negation_flip",
    "date_shift",
    "quantity_change",
    "unrelated_quote",
)


@dataclass(frozen=True)
class SeedTriple:
    """A verified (fact, quote, context) fixture plus its substitution targets.

    The substitution fields are the *machine-checkable* anchors each
    perturbation operates on, so transforms are deterministic and never rely
    on NER/regex at generation time. A field of ``None`` means the fixture
    does not exercise that perturbation.

    Attributes:
        source_id: Stable id; surfaces as ``sourceId`` on every derived record.
        fact_text: The candidate fact.
        quote: The verified source span (issue #1575 provenance).
        context: Surrounding turn text (may be empty).
        entities: ``{canonical: swap}`` pairs for ``entity_swap``.
        paraphrase: Meaning-preserving rewrite of ``fact_text`` for the
            ``paraphrase`` entailed stream (``None`` ⇒ skip paraphrase).
        negation_phrase: A word/phrase whose insertion flips polarity
            (``negation_flip``). ``None`` ⇒ skip.
        date_phrase / date_shifted: A date token and its contradictory
            replacement. ``None`` ⇒ skip.
        quantity_phrase / quantity_shifted: A quantity token and its
            contradictory replacement. ``None`` ⇒ skip.
    """

    source_id: str
    fact_text: str
    quote: str
    context: str
    entities: dict[str, str] | None = None
    paraphrase: str | None = None
    negation_phrase: str | None = None
    date_phrase: str | None = None
    date_shifted: str | None = None
    quantity_phrase: str | None = None
    quantity_shifted: str | None = None


def _record(
    triple: SeedTriple,
    fact_text: str,
    quote: str,
    label: str,
    perturbation: str,
) -> FaithfulnessRecord:
    return FaithfulnessRecord(
        factText=fact_text,
        quote=quote,
        context=triple.context,
        label=label,
        perturbation=perturbation,
        sourceId=triple.source_id,
    )


def identity(triple: SeedTriple) -> Optional[FaithfulnessRecord]:
    """Fact == quote ⇒ entailed. The trivial positive baseline."""
    if triple.fact_text.strip() != triple.quote.strip():
        return None
    return _record(triple, triple.fact_text, triple.quote, "entailed", "identity")


def paraphrase(triple: SeedTriple) -> Optional[FaithfulnessRecord]:
    """Hand-written meaning-preserving rewrite ⇒ entailed."""
    if not triple.paraphrase:
        return None
    return _record(triple, triple.paraphrase, triple.quote, "entailed", "paraphrase")


def entity_swap(triple: SeedTriple) -> Optional[FaithfulnessRecord]:
    """Replace a named entity with a different one ⇒ contradicted."""
    if not triple.entities:
        return None
    # Deterministic: first canonical entity in insertion order.
    canonical, swap = next(iter(triple.entities.items()))
    swapped = triple.fact_text.replace(canonical, swap, 1)
    if swapped == triple.fact_text:
        return None
    return _record(triple, swapped, triple.quote, "contradicted", "entity_swap")


def negation_flip(triple: SeedTriple) -> Optional[FaithfulnessRecord]:
    """Toggle a negation phrase ⇒ contradicted.

    Insertion if the fact is affirmative; removal if already negated (the
    fixture's ``fact_text`` would then carry ``negation_phrase``).
    """
    if not triple.negation_phrase:
        return None
    phrase = triple.negation_phrase
    if phrase in triple.fact_text:
        flipped = triple.fact_text.replace(phrase, "", 1)
    else:
        # Insert after the first word boundary — keeps the sentence readable
        # and guarantees a meaning change for the selfcheck.
        parts = triple.fact_text.split(maxsplit=1)
        flipped = f"{parts[0]} {phrase}{' ' + parts[1] if len(parts) > 1 else ''}"
    # Collapse accidental double spaces left by a mid-phrase removal
    # (e.g. stripping "not" from "does not") so the sentence stays clean.
    while "  " in flipped:
        flipped = flipped.replace("  ", " ")
    return _record(triple, flipped, triple.quote, "contradicted", "negation_flip")


def date_shift(triple: SeedTriple) -> Optional[FaithfulnessRecord]:
    """Change a date token ⇒ contradicted."""
    if not triple.date_phrase or not triple.date_shifted:
        return None
    if triple.date_phrase not in triple.fact_text:
        return None
    shifted = triple.fact_text.replace(triple.date_phrase, triple.date_shifted, 1)
    return _record(triple, shifted, triple.quote, "contradicted", "date_shift")


def quantity_change(triple: SeedTriple) -> Optional[FaithfulnessRecord]:
    """Change a quantity token ⇒ contradicted."""
    if not triple.quantity_phrase or not triple.quantity_shifted:
        return None
    if triple.quantity_phrase not in triple.fact_text:
        return None
    changed = triple.fact_text.replace(triple.quantity_phrase, triple.quantity_shifted, 1)
    return _record(triple, changed, triple.quote, "contradicted", "quantity_change")


def unrelated_quote(
    triple: SeedTriple,
    other_quote: str,
) -> Optional[FaithfulnessRecord]:
    """Pair the fact with a quote about something else ⇒ unsupported.

    ``other_quote`` is selected deterministically by the generator's RNG from
    a *different* fixture, so the pairing is reproducible but not a function
    of ``triple`` alone (hence the extra argument).
    """
    if not other_quote.strip() or other_quote.strip() == triple.quote.strip():
        return None
    return _record(triple, triple.fact_text, other_quote, "unsupported", "unrelated_quote")


#: The ordered table of perturbation functions (identity first, then entailed,
#: then contradicted, then unsupported — stable ordering aids review).
PERTURBATION_FUNCS: tuple[Callable[..., Optional[FaithfulnessRecord]], ...] = (
    identity,
    paraphrase,
    entity_swap,
    negation_flip,
    date_shift,
    quantity_change,
)


# --------------------------------------------------------------------------
# Seed fixture bank.
#
# Hand-curated so every label/perturbation is exercised. The bank is the
# synthetic-stream volume driver; extending it (more fixtures, more entity
# pairs per fixture) scales the dataset without touching perturbation logic.
# --------------------------------------------------------------------------

SEED_TRIPLES: tuple[SeedTriple, ...] = (
    SeedTriple(
        source_id="db-migration",
        fact_text="We migrated to MySQL in March 2023.",
        quote="We migrated to MySQL in March 2023.",
        context="The team discussed the database move during the retro.",
        entities={"MySQL": "PostgreSQL"},
        paraphrase="The database was switched over to MySQL in March of 2023.",
        negation_phrase="not",
        date_phrase="March 2023",
        date_shifted="March 2024",
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="team-size",
        fact_text="The platform team has three engineers.",
        quote="The platform team has three engineers.",
        context="Headcount came up in the planning meeting.",
        entities={"platform": "infra"},
        paraphrase="There are three engineers on the platform team.",
        negation_phrase="not",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase="three",
        quantity_shifted="seven",
    ),
    SeedTriple(
        source_id="release-cadence",
        fact_text="Releases happen every Tuesday.",
        quote="Releases happen every Tuesday.",
        context="The release manager confirmed the weekly schedule.",
        entities={"Tuesday": "Friday"},
        paraphrase="We ship releases on a weekly Tuesday cadence.",
        negation_phrase="never",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="oncall-rotation",
        fact_text="The oncall rotation does not include weekends.",
        quote="The oncall rotation does not include weekends.",
        context="A teammate asked about after-hours coverage.",
        entities={"weekends": "holidays"},
        paraphrase="Weekends are excluded from the oncall rotation.",
        negation_phrase="not",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="vendor-contract",
        fact_text="The vendor contract renews in January 2025.",
        quote="The vendor contract renews in January 2025.",
        context="Legal flagged the upcoming renewal date.",
        entities=None,  # date fixture; entity_swap exercised by other fixtures
        paraphrase="Renewal for the vendor contract is dated January 2025.",
        negation_phrase="not",
        date_phrase="January 2025",
        date_shifted="January 2026",
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="api-quota",
        fact_text="The API allows five thousand requests per hour.",
        quote="The API allows five thousand requests per hour.",
        context="Rate limits were documented in the integration spec.",
        entities=None,
        paraphrase="Hourly API usage is capped at five thousand requests.",
        negation_phrase="not",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase="five thousand",
        quantity_shifted="two hundred",
    ),
)


@dataclass(frozen=True)
class SelftestCase:
    """A hand-written (perturbation, fixture_id) → expected label assertion."""

    name: str
    perturbation: str
    fixture_id: str
    expected_label: str
    description: str


#: The CI assertion surface. Every case MUST produce its expected label; the
#: node test parses ``--selfcheck`` JSON and fails if any case mismatches.
#: Cases are chosen to prove each perturbation both *changes* the label where
#: it should and *preserves* it where it should not.
SELFTEST_CASES: tuple[SelftestCase, ...] = (
    # Entailed stream — meaning preserved.
    SelftestCase("identity-preserve", "identity", "db-migration", "entailed",
                 "verbatim fact vs quote is entailed"),
    SelftestCase("paraphrase-preserve", "paraphrase", "team-size", "entailed",
                 "meaning-preserving rewrite is entailed"),
    # Contradicted stream — each transform flips meaning.
    SelftestCase("entity-swap-contradict", "entity_swap", "release-cadence", "contradicted",
                 "swapping Tuesday→Friday contradicts the quote"),
    SelftestCase("negation-flip-contradict", "negation_flip", "oncall-rotation", "contradicted",
                 "removing 'not' from a negated fact contradicts the quote"),
    SelftestCase("negation-flip-insert-contradict", "negation_flip", "release-cadence", "contradicted",
                 "inserting 'never' into an affirmative fact contradicts the quote"),
    SelftestCase("date-shift-contradict", "date_shift", "vendor-contract", "contradicted",
                 "shifting the renewal year contradicts the quote"),
    SelftestCase("quantity-change-contradict", "quantity_change", "api-quota", "contradicted",
                 "changing the request cap contradicts the quote"),
    # Unsupported stream — fact paired with an unrelated quote.
    SelftestCase("unrelated-quote-unsupported", "unrelated_quote", "db-migration", "unsupported",
                 "pairing the fact with an off-topic quote is unsupported"),
    # Identity must NOT fire when fact ≠ quote (preserve-negative). Uses an
    # ad-hoc mismatched triple (seed fixtures are all fact==quote by design).
    SelftestCase("identity-no-mismatch", "identity", "_mismatch", "_skipped",
                 "identity only fires when fact == quote verbatim"),
)


def run_selftest() -> dict[str, object]:
    """Run :data:`SELFTEST_CASES` against the perturbation functions.

    Returns ``{allPassed, passed, failed, cases}`` where each case carries
    its ``expected``/``actual`` label and ``passed`` flag. ``actual ==
    "_skipped"`` means the perturbation correctly declined (returned None)
    for a fixture it should not apply to.
    """
    by_id = {triple.source_id: triple for triple in SEED_TRIPLES}
    rng = random.Random(0)  # deterministic other-quote selection for the selftest
    other_quotes = [triple.quote for triple in SEED_TRIPLES]

    results: list[dict[str, object]] = []
    failures: list[str] = []
    for case in SELFTEST_CASES:
        if case.fixture_id == "_mismatch":
            # Ad-hoc triple where fact != quote — identity must decline.
            triple = SeedTriple(
                source_id="_mismatch",
                fact_text="The service runs on port 8080.",
                quote="The service runs on port 3000.",
                context="",
            )
        else:
            triple = by_id[case.fixture_id]
        record: Optional[FaithfulnessRecord]
        if case.perturbation == "unrelated_quote":
            # Pick a quote from a different fixture deterministically.
            candidates = [q for q in other_quotes if q != triple.quote]
            pick = candidates[rng.randrange(len(candidates))] if candidates else ""
            record = unrelated_quote(triple, pick)
        else:
            func = {
                "identity": identity,
                "paraphrase": paraphrase,
                "entity_swap": entity_swap,
                "negation_flip": negation_flip,
                "date_shift": date_shift,
                "quantity_change": quantity_change,
            }[case.perturbation]
            record = func(triple)

        actual = record.label if record is not None else "_skipped"
        passed = actual == case.expected_label
        if not passed:
            failures.append(
                f"{case.name}: expected {case.expected_label!r}, got {actual!r}"
            )
        results.append({
            "name": case.name,
            "perturbation": case.perturbation,
            "fixture": case.fixture_id,
            "expected": case.expected_label,
            "actual": actual,
            "passed": passed,
            "description": case.description,
        })

    return {
        "allPassed": len(failures) == 0,
        "passed": sum(1 for r in results if r["passed"]),
        "failed": len(failures),
        "cases": results,
    }


def generate_dataset(seed: int) -> list[FaithfulnessRecord]:
    """Apply every applicable perturbation to every seed triple.

    Deterministic given ``seed``: the unrelated-quote pairings are chosen
    from a dedicated ``random.Random(seed)``, and the final record order is
    shuffled with the same RNG so two runs sharing a seed produce
    byte-identical JSONL (and two runs with different seeds almost surely
    differ in byte content → different sha256).
    """
    rng = random.Random(seed)
    records: list[FaithfulnessRecord] = []
    for triple in SEED_TRIPLES:
        for func in PERTURBATION_FUNCS:
            record = func(triple)
            if record is not None:
                records.append(record)
        # Unrelated-quote stream: pair this fact with a quote from a
        # different fixture (deterministic pick from the seeded RNG).
        other_quotes = [t.quote for t in SEED_TRIPLES if t.source_id != triple.source_id]
        if other_quotes:
            pick = other_quotes[rng.randrange(len(other_quotes))]
            record = unrelated_quote(triple, pick)
            if record is not None:
                records.append(record)

    # Seed-sensitive ordering guarantees different seeds → different bytes
    # (the unrelated-quote pick already varies, but shuffle makes the
    # determinism test bulletproof for small fixture counts).
    rng.shuffle(records)
    return records


def label_counts(records: list[FaithfulnessRecord]) -> dict[str, int]:
    """Per-label counts for the manifest ``dataRecipe.counts`` block."""
    counts = {label: 0 for label in LABELS}
    for record in records:
        counts[record.label] += 1
    return counts
