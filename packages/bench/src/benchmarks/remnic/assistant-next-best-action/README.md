# assistant-next-best-action

Sealed-rubric Assistant bench for next-best-action recommendations. Tests
whether the agent grounds its suggestion in the user's actual commitments
and open work, and whether it abstains appropriately when asked to reason
from weak evidence.

Fixtures are synthetic. Scoring uses the sealed `assistant-rubric-v1`
rubric with four dimensions: identity_accuracy, stance_coherence, novelty,
and calibration. See `_assistant-common/README` equivalent (top of
`_assistant-common/index.ts`) for the shared wiring hooks.
