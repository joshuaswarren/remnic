# Your AI agent's memory works. It's just showing up late.

I spent the last few weeks running a preregistered experiment on a question
that has bugged me since I started building Remnic, my open source memory
system for AI agents: when an agent has a memory of failing at something,
why does it so often fail the same way again?

The answer surprised me. It's not that the memory is wrong. It's not that the
model ignores memory. It's that we deliver the memory at the wrong moment.

## The setup

Every agent memory system I know of, mine included, works the same way at
recall time. The agent starts a turn, the system retrieves whatever looks
relevant, and the recalled context lands in the prompt before the agent
begins working. Retrieval strategies differ. Storage formats differ. The
delivery point never does.

So I built an experiment to isolate it. Thirty synthetic TypeScript repair
tasks, each with a deliberate trap: a wrong fix that looks more attractive
than the right one. Mark the failing test as flaky instead of fixing the
state bug underneath it. Edit the config file that another file silently
shadows. Patch the call site instead of the module that owns the bug. Six
trap classes, five tasks each.

The protocol has two episodes. In episode one, the agent falls into the trap,
and the harness freezes that failure as a memory: the fact text, plus a
fingerprint of the trapping action. Episode two is the test: same task, and
the agent gets its own failure memory back. The only question is when.

One arm gets the memory at turn start, the way memory systems deliver it
today. The other arm gets the identical fact, same wording, same token
count, at the moment the agent proposes the action that failed last time. A
small advisory gate watches proposed tool calls, matches them against the
fingerprint, and speaks up right then: the matched proposal doesn't run,
the warning lands as a direct response to it, and the model decides again
with the memory in front of it. It can still pick the same action. Nothing
is ever blocked.

I preregistered the whole thing before collecting data: tasks, arms, seeds,
outcome definitions, statistical tests, decision thresholds. The registration
is hash-bound, and the harness refuses to run if the documents drift. More on
why that mattered in a minute.

## What happened

Without any memory, the model repeated its own known failure in 44% of
episodes. The traps work.

With the failure memory at turn start? 36%. Eight points. And here's the part
that stung: a matched success memory, telling the agent what worked in a
similar repo instead of what failed here, beat the failure memory on task
completion. The registered test rejected turn-start failure memory outright.

With the identical fact delivered at the action site: zero repeats in 270
raw episodes. The preregistered test works on task-level averages, and
there it measured a 35.6 percentage point reduction against turn-start
delivery, p = 0.0019, on all 18 preregistered tasks with no excluded data.
I measured the effect three separate times across the pilot and both
registered runs, and it landed between 35 and 38 points every time.

Same fact, same wording, same token count. What changed was the delivery:
at the action site the warning arrives as an answer to the exact thing the
agent is about to do, and the agent reconsiders before anything runs. The
study compares those two delivery mechanisms whole; teasing apart how much
is the memory text versus the interruption itself is the follow-up
experiment.

## The honest part

Preventing the known failure did not make the agent finish more tasks. The
completion estimate moved one and a half points with an interval touching
zero. Agents that got blocked from the trap mostly wandered to a different
wrong answer instead of the correct fix. So the claim is narrow: action-site
delivery removes a known failure mode. It does not make your agent smart.

I also have to own a mistake. My first registered run completed all 1,890
episodes, and two came back unclassifiable after hitting execution caps.
One of the two sat in the timing comparison, and my own preregistered rule
said any unclassifiable row there voids the hypothesis. It voided. A
38-point effect, set aside because I wrote a rule that allowed zero
exceptions and then met exactly one where it mattered. I fixed the rule,
registered the fix before generating new data, and reran the whole thing on
fresh seeds.
That rerun is the confirmatory result. Expensive lesson, but it's exactly
what preregistration is for. The result you can trust is the one that
survived the rules written before the data existed.

## What this means for how we build

If you're building agent memory, I think the takeaway is a routing rule, not
a new architecture. Store failure memories with a fingerprint of the action
that failed. At tool-proposal time, check the match. Inject the memory as an
advisory, right there, and fail open if anything goes wrong. Keep your
semantic recall and preference context at turn start where it belongs. The
warning belongs at the moment of temptation.

I'm building this into Remnic now: the gate primitive already exists in
remnic core, and the issue laying out the production design is public.

Everything is open if you want to poke at it. The paper has the full design,
statistics, and limitations. The 30 trap tasks live in the Remnic repo with
the harness and both registration documents, and the per-episode logs and
statistics artifacts for every run are attached to the study release, so
you can replay the analysis yourself with zero model calls.

Paper: [arXiv link on publication]. Tasks, harness, and registrations:
https://github.com/joshuaswarren/remnic/tree/h6-study-2026-08. Run
artifacts: https://github.com/joshuaswarren/remnic/releases/tag/h6-study-2026-08.

Has anyone else measured where in the loop their agent's recalled context
actually lands? I'd love to compare notes, especially if you've got data on
real repositories rather than synthetic traps.

-Josh
