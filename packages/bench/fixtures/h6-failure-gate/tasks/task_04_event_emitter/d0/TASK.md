# Task: Event Listener Disposal

## Objective
Update EventEmitter subscription handling to support listener removal.

## Available Strategies
1. **candidate_alpha**: Clear all listeners for event name whenever off is invoked.
2. **candidate_beta**: Return unsubscribe function from on method that removes specific callback.

## Instructions
Review the implementation under `src/` and select or apply the appropriate candidate modification.
