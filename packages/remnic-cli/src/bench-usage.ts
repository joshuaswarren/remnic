/**
 * Help text for `remnic bench`, extracted from index.ts under the
 * structural ratchet (issue #1995).
 */

export function getBenchUsageText(): string {
  return `Usage: remnic bench <list|run|published|datasets|runs|compare|results|baseline|export|publish|ui|providers|judge-calibrate|attribute|drift-gen|coding> [options] [benchmark...]
       remnic benchmark <list|run|published|datasets|runs|compare|results|baseline|export|publish|ui|providers|judge-calibrate|check|report|attribute|drift-gen|coding> [options] [benchmark...]

Commands:
  list                     List published benchmark packs
  run [benchmark...]       Run one or more benchmark packs
  published --name <benchmark> --dataset <path> --model <id>
                           Run a published benchmark with leaderboard-friendly flags
                           (see issue #566 slice 4). Accepts --limit, --seed,
                           --trial-limit, --trial-concurrency,
                           --ingest-concurrency, --out, --dry-run,
                           --provider, --base-url.
  datasets download [benchmark...]
                           Download local datasets for supported published benchmarks
  datasets status          Show local dataset availability for supported benchmarks
  runs list                List stored benchmark runs
  runs show <run>          Show one stored benchmark run
  runs delete <run...>     Delete one or more stored benchmark runs
  compare <base> <cand>    Compare two stored benchmark runs by id or file path
  results [run]            List stored runs or inspect a stored run
  baseline save <name> [run]
                           Save a stored run as a named baseline
  baseline list            List saved baselines
  export <run> --format <json|csv|html>
                           Export one stored run as JSON, aggregate-metrics CSV, or static HTML
  publish --target remnic-ai
                           Generate the Remnic.ai benchmark feed from stored runs
  ui                       Launch the local benchmark overview UI
  providers discover       Auto-detect available local provider backends
  judge-calibrate --benchmark <id> --source-result-id <id> --expected-answer-set-sha256 <sha256>
                           --expected-question-id-list-sha256 <sha256>
                           --local-lab-manifest <path> --judge-provider <p> --judge-model <m>
                           Cross-tier judge calibration (issue #1573): runs the
                           local + frontier judges over a benchmark's cached
                           answers, reports Cohen's kappa, and persists it so
                           subsequent local artifacts carry the kappa + warning.
  coding                   H6 synthetic coding benchmark commands
                           Run \`remnic bench coding --help\` for repo generation,
                           repeated-failure runs, resume, and offline stats replay
  check                    Legacy latency regression gate (compatibility)
  attribute --run <id> [--results-dir <path>] [--memory-dir <path>] [--threshold <value>]
                           [--qmd <path> --collection <name>]
                           Attribute failures from stored witnesses by default; paired QMD flags enable
                           explicit live fallback for legacy runs without witnesses
  drift-gen [generate|validate <dir>] [--users <n>] [--epochs <n>] [--seed <n>]
                           [--out <dir>] [--facts-per-epoch <n>] [--drifting-ratio <r>]
                           [--contradicted-ratio <r>]
                           Generate or validate synthetic memory drift bench corpora
  report                   Legacy latency report generator (compatibility)
  procedural-ablation --out <path> [--fixture <path>]
                           Run the procedural recall ablation harness (issue #567)

Options:
  --quick                  Run a lightweight quick pass (maps to --lightweight --limit 1)
  --all                    Run every published benchmark
  --adapter <remnic|mcp>   Memory backend adapter (default: remnic)
  --mcp-demo               Use the packaged keyless stdio MCP demo server
  --mcp-command <command>  Spawn an MCP stdio server
  --mcp-args <json>        JSON string array passed to --mcp-command
  --mcp-url <url>          Connect to a Streamable HTTP MCP server
  REMNIC_BENCH_MCP_BEARER_TOKEN
                           Optional bearer token for --mcp-url (environment only)
  --mcp-tool-map <json>    Explicit store/recall/correct/reset tool mapping
  --runtime-profile <baseline|real|openclaw-chain|local-lab>
                           Choose the benchmark runtime profile
  --matrix <profiles>      Run a benchmark across a comma-separated profile matrix
  --dataset-dir <path>     Override the benchmark dataset directory for full runs
  --remnic-config <path>   Load runtime settings from a Remnic config file
  --openclaw-config <path> Load runtime settings from an OpenClaw config file
  --model-source <plugin|gateway>
                           Override whether Remnic uses plugin or gateway model routing
  --gateway-agent-id <id>  OpenClaw agent persona id for gateway model routing
  --fast-gateway-agent-id <id>
                           OpenClaw fast-tier agent persona id for gateway model routing
  --system-provider <openai|anthropic|ollama|litellm|local-llm|codex-cli|claude-cli>
                           Use a direct provider-backed answering path
  --system-model <model>   Model name for the direct answering provider
  --system-base-url <url>  Base URL for the direct answering provider
  --system-codex-reasoning-effort <low|medium|high|xhigh>
                           Codex CLI reasoning effort for the direct answerer
  --system-responder-context-budget-chars <n>
                           Compact recalled memory context before sending it to the direct answerer
  --system-responder-prompt-budget-chars <n>
                           Compact repeated benchmark prompt instructions before sending them to the direct answerer
  --judge-provider <openai|anthropic|ollama|litellm|local-llm|codex-cli|claude-cli>
                           Use a direct provider-backed judge
  --judge-model <model>    Model name for the judge provider
  --judge-base-url <url>   Base URL for the judge provider
  --judge-codex-reasoning-effort <low|medium|high|xhigh>
                           Codex CLI reasoning effort for the judge
  --internal-provider <openai|anthropic|ollama|litellm|local-llm|codex-cli>
                           Provider for Remnic's internal extraction/summarization LLM
                           (claude-cli is not supported here — use --provider/--judge-provider)
  --internal-model <model> Model name for Remnic's internal LLM provider
  --internal-base-url <url>
                           Base URL for Remnic's internal LLM provider
  --internal-api-key <key> API key for Remnic's internal LLM provider
  --internal-disable-thinking
                           Suppress thinking for Remnic's internal LLM when supported
  --internal-codex-reasoning-effort <low|medium|high|xhigh>
                           Codex CLI reasoning effort for Remnic's internal LLM
  --ama-bench-judge-protocol <default|recommended>
                           For ama-bench, use the recommended binary LLM-judge protocol
                           (default-protocol calibration is not attached to recommended runs)
  --ama-bench-cross-judge-model <model>
                           For ama-bench, add a second recommended-protocol judge for agreement checks
  --ama-bench-cross-judge-provider <provider>
                           Provider for the ama-bench cross judge (defaults to --judge-provider)
  --ama-bench-cross-judge-codex-reasoning-effort <low|medium|high|xhigh>
                           Codex CLI reasoning effort for the ama-bench cross judge
  --ama-bench-cross-judge-base-url <url>
                           Base URL for the ama-bench cross judge (defaults to --judge-base-url)
  --custom <path>          Run a YAML-defined custom benchmark file
  --results-dir <path>     Override the stored benchmark results directory
  --baselines-dir <path>   Override the named baseline directory
  --request-timeout <ms>   Provider request timeout in milliseconds (codex-cli default: 180000)
  --local-judge-request-timeout <ms>
                           Calibration-only timeout for each local judge call
  --frontier-judge-request-timeout <ms>
                           Calibration-only timeout for each frontier judge call
  --max-429-wait <ms>      Maximum cumulative 429 retry wait for provider calls
  --disable-thinking       Disable thinking for supported provider-backed models
  --source-result-id <id>  Exact stored result used by or expected for calibration
  --expected-answer-set-sha256 <sha256>
                           Expected deterministic calibration answer-set hash
  --expected-question-id-list-sha256 <sha256>
                           Expected ordered source task-ID list hash; later runs may
                           pass all three source pins with both config pins
  --calibration-dir <path> Private final-state and resumable-checkpoint directory
  --calibration-local-config-sha256 <sha256>
                           Required on later runs that attach calibration state
  --calibration-frontier-config-sha256 <sha256>
                           Required on later runs that attach calibration state
  --drain-timeout <ms>     Memory drain timeout in milliseconds
                           (defaults to --request-timeout; implicit codex-cli default: 600000)
  --local-lab-manifest <path>
                           Path to a local-lab manifest JSON file (required for --runtime-profile local-lab)
  --threshold <value>      Regression threshold for compare (default: 0.05);
                           gold-memory similarity threshold for attribute (default: 0.6)
  --trial-limit <n>        Cap scored LoCoMo or MemoryAgentBench QA trials for staged published runs
  --task-ids-file <path>   Select an explicit JSON array of LoCoMo task IDs
  --expected-task-id-list-sha256 <sha256>
                           Pin the selected LoCoMo task-ID list
  --task-filter <pattern>  BEAM diagnostic filter; match task id, ability, or question text
  --detail                 Include per-task details for bench results
  --format <json|csv|html> Output format for bench export
  --output <path>          Write bench export output to a file
  --target <name>          Publish target for bench publish (remnic-ai)
  --json                   Output JSON for \`list\`
  --run <id>               Benchmark run reference for attribute
  --memory-dir <path>      Memory directory for failure attribution
  --qmd <path>            QMD executable for explicit legacy attribution fallback
  --collection <name>     QMD collection paired with --qmd; never inferred or defaulted
  --users <n>              Synthetic user count for drift-gen
  --epochs <n>             Synthetic timeline epochs for drift-gen
  --facts-per-epoch <n>    Facts generated per user per epoch for drift-gen
  --drifting-ratio <r>     Ratio of facts that undergo drift across epochs
  --contradicted-ratio <r> Ratio of drifting facts that are direct contradictions

Examples:
  remnic bench list
  remnic bench run --quick longmemeval --runtime-profile baseline
  remnic bench datasets status
  remnic bench datasets download longmemeval
  remnic bench datasets download --all
  remnic bench runs list
  remnic bench runs show candidate-run --detail
  remnic bench runs delete candidate-run
  remnic bench run --quick longmemeval
  remnic bench run longmemeval --dataset-dir ~/datasets/longmemeval
  remnic bench run longmemeval --runtime-profile real --remnic-config ~/.config/remnic/config.json
  remnic bench run longmemeval --runtime-profile real --system-provider openai --system-model gpt-5.4-mini
  remnic bench run longmemeval --quick --system-provider codex-cli --system-model gpt-5.5 --judge-provider codex-cli --judge-model gpt-5.5
  remnic bench run ama-bench --runtime-profile real --system-provider ollama --system-model gemma4:31b-cloud --judge-provider ollama --judge-model qwen3:32b --ama-bench-judge-protocol recommended
  remnic bench run longmemeval --runtime-profile openclaw-chain --openclaw-config ~/.openclaw/openclaw.json --gateway-agent-id memory-primary
  remnic bench run longmemeval --matrix baseline,real,openclaw-chain
  remnic bench compare base-run candidate-run
  remnic bench results
  remnic bench results candidate-run --detail
  remnic bench baseline save main candidate-run
  remnic bench baseline list
  remnic bench export candidate-run --format csv --output ./candidate.csv
  remnic bench export candidate-run --format html --output ./report.html
  remnic bench publish --target remnic-ai
  remnic bench providers discover
  remnic bench run --custom ./my-bench.yaml
  remnic bench procedural-ablation --out ./artifacts/procedural-ablation.json
  remnic bench attribute --run run-12345 --memory-dir ./memories
  remnic bench attribute --run legacy-run --memory-dir ./memories --qmd /opt/qmd --collection memories
  remnic bench drift-gen generate --users 20 --epochs 10 --out ./corpus
  remnic bench drift-gen validate ./corpus
  remnic bench coding repo-gen --count 30 --seed 81 --out ./h6-fixtures
  remnic bench coding repo-gen verify-all ./h6-fixtures
  remnic bench coding repeated-failure --seeds 5 --profile ./profiles/model-a.json
  remnic bench coding repeated-failure stats --run ./h6-repeated-failure
  remnic benchmark run --quick longmemeval`;
}
