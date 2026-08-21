# Sealed Rubric Prompts

These prompt files are the canonical, sealed LLM-judge instructions used by
Assistant-tier benchmarks. Their SHA-256 hashes are embedded into every
benchmark result so we can prove the same rubric text was used across runs.

## Rules

1. **Do not edit a sealed prompt in place.** Changes are versioned by filename
   (e.g. `assistant-rubric-v1.md` -> `assistant-rubric-v2.md`). The previous
   version stays on disk.
2. **Do not expose prompt text to the system-under-test.** The loader in
   `../sealed-rubric.ts` reads these files at judge time only and passes them
   to the judge provider. The agent being benchmarked never sees the rubric.
3. **Rotate on a schedule.** See `docs/bench/assistant-rubric.md` for the
   rotation policy. Rotations exist to keep the rubric fresh and reduce
   Goodharting risk.
