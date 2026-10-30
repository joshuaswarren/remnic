---
"@remnic/core": patch
---

Source grounding now trusts a fact's verbatim `quote`. A fact whose quote is an exact substring of one source turn (whitespace-normalized) is kept when its content is supported by the text around that quote, instead of by word overlap against the whole source, so reworded facts from long sources are no longer dropped. Entities and relationships are checked the same way against the quotes of the facts that were kept. A `;` inside a quote no longer splits it. Grounding stays on, and facts without a valid quote follow the existing whole-source rules unchanged. Closes #3235.

Stability: stable
