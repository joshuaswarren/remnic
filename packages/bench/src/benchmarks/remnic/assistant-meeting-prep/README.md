# assistant-meeting-prep

Sealed-rubric Assistant bench for meeting prep. Given an upcoming meeting and
attendees, the agent must produce a prep brief that:

- names attendees correctly using memory graph facts,
- recalls open threads from prior conversations,
- avoids relitigating already-made decisions.

Fixtures are fully synthetic. The sealed rubric (`assistant-rubric-v1`) scores
identity_accuracy, stance_coherence, novelty, and calibration. See the top
`README.md` in `_assistant-common/` for the shared wiring hooks.
