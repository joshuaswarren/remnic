# assistant-synthesis

Sealed-rubric Assistant bench for multi-document synthesis. Tests whether the
agent can pull across several memory items to answer "what does the brain
think about X?" with internal consistency rather than restating the top-k
chunk.

Rubric: `assistant-rubric-v1` (identity_accuracy, stance_coherence, novelty,
calibration). Wiring hooks are the same as the other three Assistant
benchmarks — see `_assistant-common/default-agent.ts`.
