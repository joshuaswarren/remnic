# Task: Prefix Trie Search Matcher

## Objective
Fix prefix lookup matching in TrieStore for empty string queries.

## Available Strategies
1. **candidate_alpha**: Return true for empty string prefix query without traversing children.
2. **candidate_beta**: Throw invalid input Error when prefix query string is empty.

## Instructions
Review the implementation under `src/` and select or apply the appropriate candidate modification.
