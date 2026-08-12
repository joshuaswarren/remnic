# Theory: Wearable Privacy Beyond English

## Problem

An always-on recorder captures speech in the wearer's own language.

The transcript pipeline treated every language as English.

The off-the-record feature matched three English words. A wearer who spoke
Japanese, Korean, Chinese, Arabic, or Russian got no elision at all.

Filler stripping matched English tokens. Non-English transcripts kept every
filler.

A privacy control that silently does nothing is worse than one documented as
absent. The wearer believes the span is protected. It is not.

## Operating theory

Two separate defects share one root cause: both features assumed that words are
separated by spaces and written in Latin script.

A word boundary is a property of a script, not of text. Japanese, Chinese, and
Kana runs have no boundary character. A regular expression that requires one
can never match inside them.

So boundary handling is decided per phrase edge. A phrase that starts or ends
with a Latin, Cyrillic, Greek, or numeric character gets a letter boundary. Any
other edge gets none.

This single rule makes one matcher correct for every script.

## Strategy

Built-in phrases cover a documented language set. Operators add more. Nothing
is hard-coded to one deployment.

Start phrases and end phrases carry different risk. A start phrase that fires
wrongly elides real speech. An end phrase that fires wrongly leaks protected
speech.

So the end list is shorter than the start list. A start phrase with no matching
end phrase elides through the end of the conversation. That is the fail-closed
direction.

Filler tokens divide the same way. Space-delimited scripts use whole-token
matching. Japanese and Chinese fillers are removed inline, so each inline entry
must be unambiguous on its own. The elongated hesitation forms qualify. A bare
Japanese demonstrative does not, because it carries meaning.

Operator tokens apply to every script. Routing them by script hint would drop a
token the operator deliberately added.

## Silence is the failure mode

Config parsing rejects every unusable value loudly. A blank phrase, an
over-long phrase, or a non-array throws with the exact key path.

Turning the built-in phrases off while the feature stays enabled and no start
phrase is configured also throws. That combination would leave the gate on and
match nothing, which recreates the original defect.

The documented escape hatch is `offTheRecordEnabled: false`.

## What stays language-dependent

Built-in identifier redaction covers US formats only. Other national formats
need operator patterns.

Repeat-collapse and the low-quality heuristic still use space-delimited
signals.

Both limits are stated in the documentation. They are known gaps, not silent
ones.

## Verification state

The 231-test wearables suite passes.

The workspace type check passes.

The config contract validates, and the stale `wearables` grandfather entry is
pruned.

The line ratchet passes.
