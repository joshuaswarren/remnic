"""Correction-intent morphology grammar (issue #1581 / #1585 PR3).

This is the seed grammar for the correction-intent synthetic data generator.
It mirrors the **exact morphology** of ``packages/remnic-core/src/correction/
passive-correction-detector.ts`` (#1581) — the three polarities
(update / retract / stop_storing), the strong correction signals, and the four
anti-fixture guards (self_resolving / hypothetical / third_party / tool_output)
that the production detector rejects. Deriving the grammar from that existing
extraction artifact is what makes the synthetic labels trustworthy: the model
is trained on the same distinctions the rule-based detector encodes, so
"correct" is derivable from code, not annotated.

The output record shape matches the #1581 ``PassiveCorrection`` contract:
``{targetHint, correctedAssertion, polarity, confidence}``.

Pure stdlib. Imported by ``generate-data.py`` (writer), ``train.py`` /
``eval.py`` (readers), and the CI determinism probe.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal, Sequence

# The three correction polarities — exactly ``PassiveCorrectionPolarity`` (#1581).
Polarity = Literal["update", "retract", "stop_storing"]

#: Detection labels. ``correction`` = the turn expresses a correction to stored
#: memory; ``none`` = it does not (clean turn OR an anti-fixture the detector
#: rejects). Order is fixed for deterministic enumeration/encoding.
LABELS: tuple[str, ...] = ("correction", "none")


@dataclass(frozen=True)
class ConversationRecord:
    """One labeled conversation window.

    Attributes:
        turns: A small prior-turn window + the turn under inspection. Each turn
            is ``{role, content}`` (only ``user`` turns are scanned, matching
            #1581). The LAST user turn is the one the classifier verdicts.
        label: ``correction`` if the final user turn expresses a correction the
            production detector would capture; ``none`` otherwise.
        corrections: The #1581 ``corrections[]`` block (empty for ``none``).
        morphology: Which signal/anti-fixture produced this record, for label
            provenance review (e.g. ``update_switched_to`` / ``anti_hypothetical``).
        sourceId: Stable id of the seed scenario this record derives from.
    """

    turns: list[dict[str, str]]
    label: str
    corrections: list[dict[str, Any]]
    morphology: str
    sourceId: str

    def to_jsonl_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        return {key: payload[key] for key in (
            "turns", "label", "corrections", "morphology", "sourceId",
        )}


def validate_record(record: ConversationRecord) -> list[str]:
    """Return human-readable validation errors (empty == valid)."""
    errors: list[str] = []
    if not isinstance(record.turns, list) or not record.turns:
        errors.append("turns must be a non-empty list")
    else:
        for i, turn in enumerate(record.turns):
            if not isinstance(turn, dict) or turn.get("role") not in ("user", "assistant", "other"):
                errors.append(f"turns[{i}] must have a role in user/assistant/other")
            if not isinstance(turn.get("content"), str) or not turn["content"].strip():
                errors.append(f"turns[{i}].content must be a non-empty string")
    if record.label not in LABELS:
        errors.append(f"label must be one of {LABELS!r}, got {record.label!r}")
    if record.label == "correction" and not record.corrections:
        errors.append("a 'correction' label must carry at least one correction block")
    if record.label == "none" and record.corrections:
        errors.append("a 'none' label must carry an empty corrections block")
    if not record.morphology:
        errors.append("morphology tag is required for label provenance")
    if not record.sourceId:
        errors.append("sourceId is required")
    return errors


def assert_dataset(records: Sequence[ConversationRecord]) -> None:
    """Validate every record; raise ``ValueError`` listing all errors at once."""
    all_errors: list[str] = []
    for index, record in enumerate(records):
        for error in validate_record(record):
            all_errors.append(f"record[{index}] ({record.sourceId}): {error}")
    if all_errors:
        raise ValueError("invalid dataset records:\n  " + "\n  ".join(all_errors))


# ---------------------------------------------------------------------------
# Seed scenario bank — correction morphologies (mirror #1581 PATTERNS).
#
# Each scenario is a (morphology, user_turn_template, correction) triple. The
# template's ``{subject}`` / ``{new}`` / ``{old}`` slots are filled from a
# substitution table at generation time, so one scenario fans out to many
# concrete turns — the volume driver. Extend the bank to scale the dataset.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CorrectionScenario:
    """A correction-signal template + the correction block it yields."""

    morphology: str
    template: str  # user turn text; {subject}/{new}/{old} substituted at gen
    polarity: Polarity
    #: Builds the corrections[] block from the substituted turn.
    #: ``update``/``stop_storing`` carry a correctedAssertion; ``retract`` → "".
    corrected_assertion_from: str  # "turn" = the turn itself; "" = pure retraction

    def build_correction(self, turn: str) -> dict[str, Any]:
        assertion = "" if self.polarity == "retract" else (
            turn if self.corrected_assertion_from == "turn" else self.corrected_assertion_from
        )
        return {
            "targetHint": _target_hint(turn),
            "correctedAssertion": assertion[:200],
            "polarity": self.polarity,
            "confidence": 0.85,  # matches the median #1581 pattern confidence
        }


def _target_hint(turn: str) -> str:
    """Short phrase the planner can use to locate the affected memory (≤80)."""
    cleaned = " ".join(turn.split())
    return cleaned[:80] if len(cleaned) <= 80 else cleaned[:77] + "..."


#: The correction morphology bank. Each entry corresponds to a #1581 PATTERNS
#: regex family; the template is a canonical utterance that family matches.
CORRECTION_SCENARIOS: tuple[CorrectionScenario, ...] = (
    CorrectionScenario("update_switched_to", "we switched to {new} from {old}", "update", "turn"),
    CorrectionScenario("update_migrated_to", "we migrated from {old} to {new}", "update", "turn"),
    CorrectionScenario("update_renamed", "we renamed {old} to {new}", "update", "turn"),
    CorrectionScenario("update_actually_now", "actually, it's now {new} not {old}", "update", "turn"),
    CorrectionScenario("update_no_longer", "we no longer use {old}, it's {new} now", "update", "turn"),
    CorrectionScenario("update_deadline_moved", "the deadline moved to {new}", "update", "turn"),
    CorrectionScenario("update_outdated", "that's outdated, the current value is {new}", "update", "turn"),
    CorrectionScenario("retract_dont_use", "I don't use {old} anymore", "retract", ""),
    CorrectionScenario("retract_thats_wrong", "that's wrong, {old} isn't correct", "retract", ""),
    CorrectionScenario("retract_forget", "forget about {old}, it was never true", "retract", ""),
    CorrectionScenario("stop_storing_stop_suggesting", "stop suggesting {old}", "stop_storing", "turn"),
    CorrectionScenario("stop_storing_dont_mention", "don't mention {old} again", "stop_storing", "turn"),
)


#: Substitution targets — real-world-ish entities so the model sees varied
#: surface forms. Pairs are (old, new); each scenario is instantiated against
#: every pair, fanning one scenario into many concrete turns.
SUBSTITUTIONS: tuple[tuple[str, str], ...] = (
    ("Redis", "KeyDB"),
    ("Vim", "Neovim"),
    ("MySQL", "Postgres"),
    ("Jira", "Linear"),
    ("Slack", "Discord"),
    ("Monolith", "microservices"),
    ("REST", "GraphQL"),
    ("Friday", "Monday"),
    ("Python 3.11", "Python 3.12"),
    ("AWS", "GCP"),
)


def _fill(template: str, pair: tuple[str, str]) -> str:
    return template.replace("{old}", pair[0]).replace("{new}", pair[1])


# ---------------------------------------------------------------------------
# Anti-example bank — turns the #1581 detector REJECTS (label ``none``).
# These are the four anti-fixture guards; training on them teaches the model
# NOT to fire on hypotheticals, third-party corrections, tool-output
# complaints, or self-resolving double-corrections.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AntiExample:
    morphology: str  # anti_hypothetical / anti_third_party / anti_tool_output / anti_self_resolving
    template: str
    corrected_assertion_from: str = ""  # unused; anti-examples are label=none

    def build_correction(self, turn: str) -> dict[str, Any]:  # noqa: ARG002
        raise RuntimeError("anti-examples carry no correction block")


ANTI_EXAMPLES: tuple[AntiExample, ...] = (
    AntiExample("anti_hypothetical", "what if we ever switched to {new}, would that be better?"),
    AntiExample("anti_hypothetical", "suppose we migrated from {old} to {new} in theory"),
    AntiExample("anti_third_party", "tell him he's wrong about {old}, it's actually {new}"),
    AntiExample("anti_third_party", "she's wrong about {old}"),
    AntiExample("anti_tool_output", "your output is wrong, the result for {old} should be {new}"),
    AntiExample("anti_tool_output", "the error log is incorrect about {old}"),
    AntiExample("anti_self_resolving", "actually wait, never mind, {old} was right after all"),
    AntiExample("anti_self_resolving", "no, scratch that, forget I mentioned {old}"),
)

#: Clean non-correction turns — ordinary conversation the detector must ignore.
CLEAN_TURNS: tuple[str, ...] = (
    "how do I configure {new}?",
    "I'm really liking {new} so far.",
    "can you remind me what {old} does?",
    "let's review the {new} deployment tomorrow.",
    "thanks for the help with {old}.",
)


# ---------------------------------------------------------------------------
# Selftest — each morphology provably yields its expected label.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SelftestCase:
    morphology: str
    expected_label: str
    description: str


SELFTEST_CASES: tuple[SelftestCase, ...] = (
    SelftestCase("update_switched_to", "correction", "switched-to → update correction"),
    SelftestCase("update_renamed", "correction", "renamed → update correction"),
    SelftestCase("update_no_longer", "correction", "no-longer → update correction"),
    SelftestCase("retract_dont_use", "correction", "don't-use-anymore → retract correction"),
    SelftestCase("retract_thats_wrong", "correction", "that's-wrong → retract correction"),
    SelftestCase("stop_storing_stop_suggesting", "correction", "stop-suggesting → stop_storing correction"),
    SelftestCase("anti_hypothetical", "none", "hypothetical → rejected (none)"),
    SelftestCase("anti_third_party", "none", "third-party → rejected (none)"),
    SelftestCase("anti_tool_output", "none", "tool-output → rejected (none)"),
    SelftestCase("anti_self_resolving", "none", "self-resolving → rejected (none)"),
)
