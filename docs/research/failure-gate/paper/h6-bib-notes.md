## Sections c, d, e

Entries below were checked against the linked primary landing pages (ACL Anthology, arXiv, OpenReview, or official project/report pages). Scope is limited to context position/instruction placement, coding agents/benchmarks, and preregistration/evaluation rigor.

### (c) Context position and instruction placement

1. **Liu et al. (2024), Lost in the Middle.** TACL paper testing multi-document QA and key-value retrieval; reports a U-shaped position curve: relevant facts at the beginning/end are used better than facts in the middle, including by long-context models. Primary verification: https://aclanthology.org/2024.tacl-1.9/ (metadata, abstract, DOI 10.1162/tacl_a_00638).
2. **Shi et al. (2023), Large Language Models Can Be Easily Distracted by Irrelevant Context.** Controlled “distractor” experiments show that adding irrelevant passages can sharply reduce QA accuracy, making context length/placement a confound rather than an unconditional benefit. Primary: https://arxiv.org/abs/2302.00093.
3. **Lyu et al. (2024), Position Biases in Large Language Models.** Systematically evaluates answer-choice/order and positional effects across models and tasks; documents robust positional preferences and recommends position-balanced evaluation. Primary: https://arxiv.org/abs/2402.12915.
4. **Sclar et al. (2024), Quantifying Language Models’ Sensitivity to Spurious Features in Prompt-Based Learning.** Formalizes prompt-format sensitivity, including label/order and wording changes; useful evidence that instruction placement and superficial prompt features can dominate measured performance. Primary: https://arxiv.org/abs/2310.11324.

### (d) LLM coding agents and benchmarks

5. **Chen et al. (2021), Evaluating Large Language Models Trained on Code (HumanEval/Codex).** Introduces HumanEval functional-correctness benchmark and reports pass@k; primary page explicitly defines dataset and evaluation. Primary: https://arxiv.org/abs/2107.03374.
6. **Jimenez et al. (2023), SWE-bench.** 2,294 real GitHub issues across 12 Python repositories; requires repository-level edits and tests, not isolated function synthesis. Primary: https://arxiv.org/abs/2310.06770.
7. **Yao et al. (2023), ReAct: Synergizing Reasoning and Acting in Language Models.** Interleaves reasoning traces with tool/environment actions; evaluates HotpotQA, FEVER, ALFWorld, and WebShop. Primary: https://arxiv.org/abs/2210.03629.
8. **Yang et al. (2024), SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering.** Presents an agent plus purpose-built shell/editor interface and evaluates on SWE-bench; primary paper and artifact are linked from the arXiv record. Primary: https://arxiv.org/abs/2405.15793.
9. **Wang et al. (2024), OpenHands: An Open Platform for AI Software Developers as Generalist Agents.** Open platform for coding agents with sandboxed tool use and benchmark evaluation; report distinguishes agent behavior from raw model completion. Primary: https://arxiv.org/abs/2407.16741.

### (e) Preregistration and rigor in ML evaluation

10. **van Miltenburg et al. (2021), Preregistering NLP research.** Proposal and practical template for preregistering hypotheses, data, analyses, and stopping/decision rules in NLP; directly relevant to preventing evaluation hindsight and researcher degrees of freedom. Primary: https://aclanthology.org/2021.nlp4convai-1.1/.
11. **Pineau et al. (2021), Improving Reproducibility in Machine Learning Research (NeurIPS Reproducibility Program).** JMLR description of reproducibility review/checks and reporting expectations; establishes concrete artifacts and verification as part of rigorous ML publication. Primary: https://www.jmlr.org/papers/v22/20-303.html.
12. **NeurIPS (2022), NeurIPS Paper Checklist Guidelines.** Official checklist requiring explicit reporting of limitations, assumptions, compute/data, and experimental details; a practical governance mechanism for ML evaluation rigor. Primary: https://neurips.cc/Conferences/2022/PaperInformation/PaperChecklist.
13. **Arora et al. (2024), Adding Error Bars to Evals: A Statistical Approach to Language Model Evaluation.** Argues that single benchmark percentages conceal sampling uncertainty and supplies statistical methods for confidence intervals/comparisons in LLM evaluations. Primary: https://arxiv.org/abs/2411.00640.
14. **Razea et al. (2023), Do-Not-Answer: A Dataset for Evaluating Safeguards in LLMs.** Demonstrates why evaluation must specify refusal/safety criteria and report uncertainty rather than treating aggregate scores as capability alone. Primary: https://arxiv.org/abs/2308.13387.
16. **Qwen Team (2024), Qwen2.5 Technical Report.** Official open-weight Qwen family report; Qwen2.5-Coder includes a 32B model (not “Qwen3.5”). Use this as the verified closest released family report for an open-weight ~32B coding-capable model. Primary: https://arxiv.org/abs/2412.15115. Note: no public Qwen3.5 technical report was found; do not cite that name as released.

Unverifiable candidate dropped from bibliography: the tentative “Deng et al. 2024” contamination citation above has an unresolved arXiv identifier and is intentionally excluded from references.bib. The remaining 14 entries have stable primary URLs.

## Sections a, b, f

### (a) Memory systems for LLM agents
1. **Packer et al. (2023), MemGPT.** Introduces virtual context management modeled on OS memory tiers, moving information between in-context and external storage; evaluates long-document analysis and multi-session chat. Verified primary: https://arxiv.org/abs/2310.08560
2. **Park et al. (2023), Generative Agents.** Stores natural-language experiences, synthesizes reflections, and dynamically retrieves memories for planning in a simulated town; ablations test observation, planning, and reflection. Verified primary: https://arxiv.org/abs/2304.03442
3. **Wang et al. (2023), Voyager.** Uses an automatically growing executable skill library as procedural memory, with retrieval, environment feedback, and self-verification in Minecraft. Verified primary: https://arxiv.org/abs/2305.16291
4. **Sumers et al. (2023), CoALA.** Cognitive Architectures for Language Agents organizes modular memories, structured actions, and decision processes, providing a taxonomy for comparing agent memory designs. Verified primary: https://arxiv.org/abs/2309.02427

### (b) Learning from failure and experience
5. **Shinn et al. (2023), Reflexion.** Agents convert task feedback into verbal reflections held in episodic memory, improving later trials without parameter updates; tests coding, reasoning, and sequential decision tasks. Verified primary: https://arxiv.org/abs/2303.11366
6. **Zhao et al. (2023), ExpeL.** Agents gather training-task experiences, extract natural-language insights, and recall them at inference; reports accumulating performance and transfer without finetuning. Verified primary: https://arxiv.org/abs/2308.10144
7. **Madaan et al. (2023), Self-Refine.** A single model generates, critiques, and iteratively revises outputs without additional training; evaluates seven tasks and reports average gains over one-shot generation. Verified primary: https://arxiv.org/abs/2303.17651

### (f) Runtime guardrails at tool-call time
8. **Ruan et al. (2023), ToolEmu.** LM-emulated tool execution enables scalable tests of agent actions against high-stakes tools, paired with an automatic safety evaluator; benchmark covers 36 tools and 144 cases. Verified primary: https://arxiv.org/abs/2309.15817
9. **Zhang et al. (2024), GuardAgent.** A dedicated guard agent reasons over requests and produces executable checks to regulate another agent’s actions, targeting dynamic intervention rather than only output filtering. Verified primary: https://arxiv.org/abs/2406.09187
11. **Schick et al. (2023), Toolformer.** Demonstrates learning when and how to call external APIs, including argument generation and result integration; relevant to call-time validation because tool invocation is an explicit learned action. Verified primary: https://arxiv.org/abs/2302.04761
12. **Ganguli et al. (2022), Red Teaming Language Models with Language Models.** Uses model-generated adversarial prompts to discover harmful behaviors and informs runtime safety evaluation; a precursor to automated intervention testing around agent actions. Verified primary: https://arxiv.org/abs/2202.03286
