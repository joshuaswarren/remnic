---
"@remnic/core": patch
---

An extraction result that carries only an identity reflection or only entity relationships is no longer treated as empty. It now reaches persistence while the matching `identityEnabled` / `entityRelationshipsEnabled` capability is on, instead of clearing the source turns and marking the input processed without writing it. `durableOutputCount` counts these outputs too. A storage failure while writing a relationship or reflection now fails the persistence pass like an entity write failure does, so the input stays retryable instead of being marked processed with the output lost. Fixes #3227.

Stability: stable
