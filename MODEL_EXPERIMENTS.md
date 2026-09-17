# Model Experiments

Last updated: 2026-09-17

## Objective

Determine which locally installed, GPU-resident model can reliably:

1. Choose the Wikipedia tools.
2. Form useful search queries.
3. Select and fetch relevant articles.
4. Preserve the exact predicate in the question.
5. Produce the supported final answer within a bounded tool budget.

No prompt may contain material hints about the answer. Prompt changes must describe technique only.

## Reference Question

```text
Which active MLB teams have never been to the World Series?
```

Expected benchmark grading condition: the answer identifies only the Seattle Mariners and has used `wiki_fetch` for supporting evidence.

This expected answer is for grading only and must not be inserted into model prompts or tool descriptions.

## External Reference

A prior LM Studio run with `prism-ml/bonsai-27b` and the original LocalWiki plugin succeeded:

- Context: 8192
- Temperature: 0
- Maximum output: 1024
- Maximum prediction rounds: 24
- Tool sequence: one list, four searches, two fetches
- Duration: 301.46 seconds
- Correct final answer: Seattle Mariners

The local implementation now omits `wiki_list` because there is exactly one book, but otherwise preserves upstream Kiwix behavior.

## Installed Models

| Model | Stored size | Advertised capabilities |
|---|---:|---|
| `qwen3:4b-instruct-2507-q4_K_M` | 2.5 GB | completion, tools, thinking |
| `qwen3:4b` | 2.5 GB | not re-inspected in latest round |
| `qwen3.5:2b` | 2.7 GB | not re-inspected in latest round |
| `nemotron-3-nano:4b` | 2.8 GB | completion, tools, thinking |
| `qwen3.5:4b` | 3.4 GB | not re-inspected in latest round |
| `wcamaralopes/bonsai-27b:latest` | 3.8 GB | completion, tools, thinking |
| `qwen3:8b` | 5.2 GB | not re-inspected in latest round |
| `lfm2.5:8b` | 5.2 GB | completion, tools, thinking |
| `granite4.2:8b` | 5.3 GB | completion, tools, thinking |
| `qwen3.5:9b` | 6.6 GB | not re-inspected in latest round |
| `hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M` | 6.7 GB | not re-inspected in latest round |

All inspected candidates advertise native tool support. Their metadata alone does not guarantee that they will elect to call a tool.

## Baseline Parameters

Unless otherwise stated:

```json
{
  "num_ctx": 8192,
  "temperature": 0,
  "num_predict": 1024,
  "repeat_last_n": 64,
  "think": false,
  "keep_alive": 0,
  "stream": false
}
```

The gateway allows four searches, two fetches, and 24 total model/tool rounds.

## Valid Results

### Qwen 3 4B Instruct 2507

Model: `qwen3:4b-instruct-2507-q4_K_M`

Two equivalent baseline runs produced the same behavior.

Representative result:

```json
{
  "status": 200,
  "wall_seconds": 17.768,
  "answer": "I cannot determine which active MLB teams have never been to the World Series using the available tools. This requires specific historical data on team performances and World Series appearances, which is beyond the scope of the provided Wikipedia resources.",
  "done_reason": "stop",
  "prompt_eval_count": 791,
  "eval_count": 44
}
```

Tool trace: no calls.

Interpretation: deterministic failure at tool-choice compliance. Search wording, retrieval quality, and evidence synthesis were never exercised. Sampling changes are unlikely to solve this cleanly; test stronger mandatory-tool control or forced initial tool selection.

### Nemotron 3 Nano 4B

Model: `nemotron-3-nano:4b`

A bounded baseline did not complete in several minutes and was terminated. No completed tool calls attributable to the valid request appeared in gateway logs. Ollama was idle after termination.

Interpretation: non-convergent before a completed tool call. This model should not receive long unbounded retries under the same baseline.

### LFM 2.5 8B

Model: `lfm2.5:8b`

The benchmark was bounded with GNU `timeout 300` inside the gateway container.

Result:

- Exit code: 124 (five-minute timeout)
- Gateway ended the abandoned request with HTTP 500
- No completed tool calls appeared in the captured gateway trace
- Ollama showed the model at 100% GPU, context 8192, then `Stopping...`

Interpretation: non-convergent before a completed tool call under the baseline. Do not infer that it cannot use tools generally; this specific orchestration did not produce a completed call within five minutes.

## Invalid or Contaminated Runs

Do not use these as model evidence:

- An early PowerShell matrix set `BENCH_MODEL` only in the host environment, not in the gateway container. Requests therefore fell back to default Bonsai.
- One Nemotron attempt failed gateway authentication before reaching the model; a nearby tool log belonged to an orphaned fallback request.
- A persistent PowerShell terminal was left inside an unfinished block and swallowed a Qwen command.
- Several execution wrappers timed out while their child command continued. A timeout from the orchestration tool is not itself a model timeout.
- One trace collection command recursively scanned the repository instead of querying Docker logs.

Use `home-assistant-gateway/benchmark.py` for all future runs.

## Pending Baselines

Still run under the exact baseline, sequentially and with a five-minute process bound:

1. `granite4.2:8b`
2. `wcamaralopes/bonsai-27b:latest`

Potential follow-up candidates after those:

- `qwen3.5:4b`
- `qwen3:8b`
- `qwen3.5:9b`
- Ornith 9B

## Next Iteration Strategy

First finish Granite and Bonsai baselines. Then classify each model by failure stage:

| Stage | Symptom | Next intervention |
|---|---|---|
| Tool choice | Zero tool calls or immediate refusal | Require/force an initial `wiki_search`; do not tune search wording yet |
| Query formulation | Calls search with verbose or repeated queries | Strengthen short title-oriented query rule; prevent duplicate queries |
| Result selection | Good results returned but wrong page fetched | Require selection by title/path relevance before fetch |
| Evidence use | Correct page fetched but related predicate substituted | Reinforce exact-claim verification and qualifier preservation |
| Stopping | Repeats searches/fetches or never answers | Lower rounds, enforce no duplicate calls, provide deterministic budget-exhausted response rule |
| Final synthesis | Evidence is correct but final list is wrong | Add a generic evidence ledger/claim comparison step, without answer hints |

The likely next engineering intervention is gateway-controlled first search rather than another prompt-only variation. The Qwen baseline shows that a model can ignore even explicit search instructions. A forced first `wiki_search` should be tested as a separate policy condition, not mixed into the baseline.

## Suggested Controlled Matrix

Run one change at a time:

1. Baseline prompt, automatic tool choice.
2. Same prompt, force `wiki_search` for the first model turn only.
3. If searches occur, automatic choice thereafter.
4. If a model loops, reject exact duplicate tool name/argument pairs and return a generic duplicate warning.
5. Compare `think=false` with `think=true` only for models that already complete tool calls; do not spend thinking-token experiments on zero-call models.
6. Compare temperature 0 versus 0.1 only after the control-flow issue is solved.

For every run record:

- Model and exact parameters
- Wall time
- Final answer
- `done_reason`
- Prompt and evaluation token counts
- Ordered tool names and exact arguments
- Search result titles/paths
- Fetched article and content mode/page
- Tool-result character counts
- Whether the answer satisfies the grading condition
- Ollama processor/context residency

## Benchmark Commands

Standard run:

```powershell
Set-Location D:\wikibot
$timestamp = [DateTime]::UtcNow.ToString('o')
docker compose exec -T home-assistant-gateway `
  python benchmark.py granite4.2:8b
docker compose logs --since $timestamp --timestamps --no-color home-assistant-gateway |
  Select-String 'Wiki tool call|Wiki tool result|POST /api/chat'
docker compose exec -T ollama ollama ps
```

Bound a slow run to five minutes:

```powershell
docker compose exec -T home-assistant-gateway `
  timeout 300 python benchmark.py granite4.2:8b
```

Do not run candidates concurrently.

## Current Hypotheses

- The main observed failure is before retrieval: models are not reliably producing a first tool call.
- Prompt improvements alone may be insufficient for compact models; orchestration-level tool forcing is more discriminating.
- Thinking mode should be evaluated only after basic tool-call completion works because it can greatly increase latency.
- The original successful Bonsai result may depend on LM Studio's tool-selection/runtime template as well as on the LocalWiki implementation.
- Removing `wiki_list` reduces one unnecessary round but also changes the exact sequence from the successful external reference. This is intentional for the single-book API and should remain fixed during comparisons.
