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
        negated_text: A grammatical, hand-written negation of ``fact_text``
            for the ``negation_flip`` contradicted stream (``None`` ⇒ skip).
            Hand-written so the contradiction is real English, not a malformed
            string the model could learn as an artifact.
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
    negated_text: str | None = None
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
    """Emit the hand-written negation of ``fact_text`` ⇒ contradicted.

    The negated text is supplied per-fixture (``negated_text``) so the
    contradiction is grammatical English — not a mechanical word insertion
    that yields malformed strings like "We not migrated...", which a model
    could learn as a string artifact rather than a faithfulness signal.
    """
    if not triple.negated_text:
        return None
    return _record(triple, triple.negated_text, triple.quote, "contradicted", "negation_flip")


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
        negated_text="We did not migrate to MySQL in March 2023.",
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
        entities=None,  # no mutually-exclusive entity swap; quantity_change covers this fixture
        paraphrase="There are three engineers on the platform team.",
        negated_text="The platform team does not have three engineers.",
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
        negated_text="Releases do not happen every Tuesday.",
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
        entities=None,  # "weekends"->"holidays" is not mutually exclusive with the quote
        paraphrase="Weekends are excluded from the oncall rotation.",
        negated_text="The oncall rotation includes weekends.",
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
        negated_text="The vendor contract does not renew in January 2025.",
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
        negated_text="The API does not allow five thousand requests per hour.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase="five thousand",
        quantity_shifted="two hundred",
    ),
    # ----------------------------------------------------------------------
    # GPU-run volume expansion (issue #1585 GPU-run follow-up).
    #
    # PR1 shipped the six fixtures above as the CI-testable seed bank (the
    # generator's determinism + perturbation selfcheck run on those six
    # alone). They produce 30 records — enough to prove the pipeline but far
    # too few for a held-out split with meaningful per-class F1 (a 10% holdout
    # of 30 is 3 examples). Issue #1585 names the fixture bank itself as the
    # "volume driver" and the line above ("extending it ... scales the dataset
    # without touching perturbation logic") as the documented extension
    # point. These fixtures follow the same construction rules as the original
    # six — fact == quote (identity baseline), a meaning-preserving paraphrase,
    # a grammatical negation, and ONE mutually-exclusive substitution target
    # (entity / date / quantity, rotated for label coverage). Labels remain
    # trustworthy by construction: every record is still a pure perturbation
    # of a hand-verified fixture, so no model is in the loop.
    #
    # The original six fixtures are NOT modified, so the CI selftest cases
    # (which reference them by source_id) still resolve unchanged.
    # ----------------------------------------------------------------------
    # --- Entity swaps (canonical → mutually-exclusive value ⇒ contradicted) ---
    SeedTriple(
        source_id="lang-python",
        fact_text="The service is written in Python.",
        quote="The service is written in Python.",
        context="A new hire asked which language the codebase uses.",
        entities={"Python": "Ruby"},
        paraphrase="Python is the implementation language for the service.",
        negated_text="The service is not written in Python.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="region-useast",
        fact_text="The primary deployment region is us-east-1.",
        quote="The primary deployment region is us-east-1.",
        context="Ops shared the failover topology during the incident review.",
        entities={"us-east-1": "eu-west-1"},
        paraphrase="us-east-1 is where the primary deployment lives.",
        negated_text="The primary deployment region is not us-east-1.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="db-postgres",
        fact_text="The analytics database is Postgres.",
        quote="The analytics database is Postgres.",
        context="Data engineering confirmed the warehouse engine.",
        entities={"Postgres": "MongoDB"},
        paraphrase="Postgres backs the analytics database.",
        negated_text="The analytics database is not Postgres.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="framework-react",
        fact_text="The frontend uses React.",
        quote="The frontend uses React.",
        context="The web lead stated the UI stack in the architecture review.",
        entities={"React": "Vue"},
        paraphrase="React is the frontend framework in use.",
        negated_text="The frontend does not use React.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="currency-usd",
        fact_text="Prices are listed in USD.",
        quote="Prices are listed in USD.",
        context="Finance clarified the catalog currency.",
        entities={"USD": "EUR"},
        paraphrase="USD is the currency prices are listed in.",
        negated_text="Prices are not listed in USD.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="day-monday",
        fact_text="The standup is on Monday.",
        quote="The standup is on Monday.",
        context="The scrum master posted the meeting cadence.",
        entities={"Monday": "Thursday"},
        paraphrase="Monday is when the standup happens.",
        negated_text="The standup is not on Monday.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="country-germany",
        fact_text="The office is in Germany.",
        quote="The office is in Germany.",
        context="HR listed the registered office location.",
        entities={"Germany": "France"},
        paraphrase="Germany is where the office is located.",
        negated_text="The office is not in Germany.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="proto-https",
        fact_text="The API requires HTTPS.",
        quote="The API requires HTTPS.",
        context="Security noted the transport requirement.",
        entities={"HTTPS": "HTTP"},
        paraphrase="HTTPS is required by the API.",
        negated_text="The API does not require HTTPS.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="cache-redis",
        fact_text="The cache layer uses Redis.",
        quote="The cache layer uses Redis.",
        context="Platform documented the caching backend.",
        entities={"Redis": "Memcached"},
        paraphrase="Redis powers the cache layer.",
        negated_text="The cache layer does not use Redis.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="os-linux",
        fact_text="The servers run Linux.",
        quote="The servers run Linux.",
        context="Infra confirmed the host operating system.",
        entities={"Linux": "Windows"},
        paraphrase="Linux is the operating system on the servers.",
        negated_text="The servers do not run Linux.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    # --- Date shifts (date token → different date ⇒ contradicted) ---
    SeedTriple(
        source_id="founded-2019",
        fact_text="The company was founded in 2019.",
        quote="The company was founded in 2019.",
        context="The about page lists the founding year.",
        entities=None,
        paraphrase="Founded in 2019, the company is a few years old.",
        negated_text="The company was not founded in 2019.",
        date_phrase="2019",
        date_shifted="2021",
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="launched-apr2024",
        fact_text="The product launched in April 2024.",
        quote="The product launched in April 2024.",
        context="Marketing announced the general-availability date.",
        entities=None,
        paraphrase="April 2024 was the product launch month.",
        negated_text="The product did not launch in April 2024.",
        date_phrase="April 2024",
        date_shifted="April 2025",
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="hired-jun2023",
        fact_text="She joined the team in June 2023.",
        quote="She joined the team in June 2023.",
        context="Her start date was shared in the team channel.",
        entities=None,
        paraphrase="June 2023 is when she joined the team.",
        negated_text="She did not join the team in June 2023.",
        date_phrase="June 2023",
        date_shifted="June 2022",
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="migrated-oct2022",
        fact_text="The data was migrated in October 2022.",
        quote="The data was migrated in October 2022.",
        context="The migration runbook recorded the cutover month.",
        entities=None,
        paraphrase="October 2022 was the data migration month.",
        negated_text="The data was not migrated in October 2022.",
        date_phrase="October 2022",
        date_shifted="October 2024",
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="certified-2020",
        fact_text="The process was certified in 2020.",
        quote="The process was certified in 2020.",
        context="Compliance published the certification year.",
        entities=None,
        paraphrase="Certification for the process was achieved in 2020.",
        negated_text="The process was not certified in 2020.",
        date_phrase="2020",
        date_shifted="2023",
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="renamed-feb2024",
        fact_text="The product was renamed in February 2024.",
        quote="The product was renamed in February 2024.",
        context="The changelog noted the rename.",
        entities=None,
        paraphrase="February 2024 was when the product was renamed.",
        negated_text="The product was not renamed in February 2024.",
        date_phrase="February 2024",
        date_shifted="February 2025",
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="deprecated-2021",
        fact_text="The legacy API was deprecated in 2021.",
        quote="The legacy API was deprecated in 2021.",
        context="The deprecation notice carried the year.",
        entities=None,
        paraphrase="2021 is when the legacy API got deprecated.",
        negated_text="The legacy API was not deprecated in 2021.",
        date_phrase="2021",
        date_shifted="2024",
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="audit-q3",
        fact_text="The security audit is scheduled for Q3.",
        quote="The security audit is scheduled for Q3.",
        context="The security team posted the audit calendar.",
        entities=None,
        paraphrase="Q3 is the scheduled quarter for the security audit.",
        negated_text="The security audit is not scheduled for Q3.",
        date_phrase="Q3",
        date_shifted="Q1",
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    SeedTriple(
        source_id="patent-2018",
        fact_text="The patent was filed in 2018.",
        quote="The patent was filed in 2018.",
        context="Legal recorded the filing year.",
        entities=None,
        paraphrase="2018 was the patent filing year.",
        negated_text="The patent was not filed in 2018.",
        date_phrase="2018",
        date_shifted="2015",
        quantity_phrase=None,
        quantity_shifted=None,
    ),
    # --- Quantity changes (quantity token → different quantity ⇒ contradicted) ---
    SeedTriple(
        source_id="users-500",
        fact_text="The system supports five hundred concurrent users.",
        quote="The system supports five hundred concurrent users.",
        context="Capacity planning recorded the concurrency ceiling.",
        entities=None,
        paraphrase="Five hundred concurrent users are supported by the system.",
        negated_text="The system does not support five hundred concurrent users.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase="five hundred",
        quantity_shifted="fifty",
    ),
    SeedTriple(
        source_id="cost-twenty",
        fact_text="The plan costs twenty dollars per month.",
        quote="The plan costs twenty dollars per month.",
        context="The pricing page lists the monthly fee.",
        entities=None,
        paraphrase="Twenty dollars a month is the plan cost.",
        negated_text="The plan does not cost twenty dollars per month.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase="twenty",
        quantity_shifted="two",
    ),
    SeedTriple(
        source_id="nodes-four",
        fact_text="The cluster runs on four nodes.",
        quote="The cluster runs on four nodes.",
        context="SRE documented the cluster topology.",
        entities=None,
        paraphrase="Four nodes make up the cluster.",
        negated_text="The cluster does not run on four nodes.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase="four",
        quantity_shifted="twelve",
    ),
    SeedTriple(
        source_id="timeout-thirty",
        fact_text="The request timeout is thirty seconds.",
        quote="The request timeout is thirty seconds.",
        context="The config file carries the timeout value.",
        entities=None,
        paraphrase="Thirty seconds is the request timeout.",
        negated_text="The request timeout is not thirty seconds.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase="thirty",
        quantity_shifted="three hundred",
    ),
    SeedTriple(
        source_id="retention-ninety",
        fact_text="Logs are retained for ninety days.",
        quote="Logs are retained for ninety days.",
        context="The data-retention policy states the window.",
        entities=None,
        paraphrase="The log retention period is ninety days.",
        negated_text="Logs are not retained for ninety days.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase="ninety",
        quantity_shifted="seven",
    ),
    SeedTriple(
        source_id="countries-ten",
        fact_text="The service ships to ten countries.",
        quote="The service ships to ten countries.",
        context="The launch plan lists the supported markets.",
        entities=None,
        paraphrase="Ten countries receive the service.",
        negated_text="The service does not ship to ten countries.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase="ten",
        quantity_shifted="two",
    ),
    SeedTriple(
        source_id="requests-200",
        fact_text="The worker handles two hundred requests per batch.",
        quote="The worker handles two hundred requests per batch.",
        context="The throughput spec records the batch size.",
        entities=None,
        paraphrase="Two hundred requests per batch are handled by the worker.",
        negated_text="The worker does not handle two hundred requests per batch.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase="two hundred",
        quantity_shifted="ten thousand",
    ),
    SeedTriple(
        source_id="storage-one",
        fact_text="The archive stores one petabyte of data.",
        quote="The archive stores one petabyte of data.",
        context="Storage capacity was reported in the capacity review.",
        entities=None,
        paraphrase="One petabyte of data is stored in the archive.",
        negated_text="The archive does not store one petabyte of data.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase="one",
        quantity_shifted="nine",
    ),
    SeedTriple(
        source_id="team-fifty",
        fact_text="The engineering org has fifty people.",
        quote="The engineering org has fifty people.",
        context="Headcount was shared in the all-hands.",
        entities=None,
        paraphrase="Fifty people make up the engineering org.",
        negated_text="The engineering org does not have fifty people.",
        date_phrase=None,
        date_shifted=None,
        quantity_phrase="fifty",
        quantity_shifted="five",
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
                 "a grammatical negation of the fact contradicts the quote"),
    SelftestCase("negation-flip-affirmative-contradict", "negation_flip", "release-cadence", "contradicted",
                 "negating an affirmative fact with 'do not' contradicts the quote"),
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


#: How many topically-unrelated quotes each fact is paired with (the
#: ``unsupported`` stream). Pairs are drawn deterministically from the seeded
#: RNG. 2 keeps the dataset ≈1:1:1 across the three labels and enlarges the
#: held-out split so per-class F1 is meaningful (issue #1585 GPU-run).
UNRELATED_PAIRINGS: int = 2


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
        # Unrelated-quote stream (the ``unsupported`` volume driver, issue
        # #1585): pair this fact with UNRELATED_PAIRINGS quotes from OTHER
        # fixtures, drawn deterministically from the seeded RNG. Pairing a
        # fact with a topically-unrelated quote is ``unsupported`` by
        # construction, so this is a label-trustworthy multiplier (no model
        # in the loop). The seed chooses WHICH quotes, so two seeds still
        # produce different bytes → different sha256.
        other_quotes = [t.quote for t in SEED_TRIPLES if t.source_id != triple.source_id]
        n_pairings = min(UNRELATED_PAIRINGS, len(other_quotes))
        for pick in rng.sample(other_quotes, n_pairings):
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
