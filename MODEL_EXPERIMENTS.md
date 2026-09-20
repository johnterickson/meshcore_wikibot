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

## Current Baseline Parameters

Unless otherwise stated:

```json
{
  "num_ctx": 8192,
  "temperature": 0,
  "num_predict": 1024,
  "repeat_last_n": 64,
  "think": false,
  "keep_alive": -1,
  "stream": false
}
```

Earlier recorded Ollama runs used `keep_alive=0`, which reloaded the model between tool rounds and substantially increased latency. Current runs keep the model resident indefinitely with `keep_alive=-1`.

The gateway has no separate search or fetch cap. It retains a 24-round circuit breaker to terminate pathological loops.

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

## Retrieval-Contaminated Runs

The Granite and Bonsai runs below are not valid model evidence. Kiwix was receiving the directory `/data` as an archive argument, rejecting it, and serving an empty catalog. LocalWiki consequently returned the same 44-character MCP error for every call: `Kiwix catalog does not contain a usable book`.

The Compose command now expands `/data/*.zim`, and Kiwix health requires a nonempty catalog. Direct post-fix validation returned five results for `Seattle Mariners` and fetched the article introduction successfully.

### Granite 4.2 8B

Model: `granite4.2:8b`

Result:

```json
{
  "status": 200,
  "wall_seconds": 183.935,
  "answer": "<tool_call>\n<function=wiki_fetch>\n<parameter=path>\nList of MLB teams\n</parameter>\n<parameter=content>\nintro\n</parameter>\n</function>\n</tool_call>\n",
  "done_reason": "stop",
  "prompt_eval_count": 566,
  "eval_count": 45
}
```

Ordered tool trace:

1. `wiki_search({"query":"MLB teams never been to the World Series"})`
2. `wiki_search({"query":"World Series never played"})`
3. `wiki_search({"query":"list of MLB teams that have never played in the World Series"})`
4. `wiki_search({"query":"World Series history teams"})`
5. `wiki_fetch({"content":"intro","path":"World Series"})`
6. `wiki_fetch({"content":"intro","path":"Major League Baseball"})`

Every tool result was 44 characters. After exhausting both budgets, Granite emitted a seventh attempted `wiki_fetch` as literal tool markup instead of returning an answer. Ollama had unloaded the model by the post-run residency check.

Interpretation: Granite produced native structured calls, but no conclusions about retrieval, stopping, or synthesis are valid because every tool response was the catalog error.

### Bonsai 27B

Model: `wcamaralopes/bonsai-27b:latest`

The benchmark client reached its five-minute bound with exit code 124 after three completed searches. The abandoned gateway request continued to four searches and two fetches, all returning the 44-character catalog error, and did not log an HTTP completion before the affected services were recreated.

Interpretation: invalid as model evidence. Repeat the baseline against the repaired retrieval stack.

## Invalid or Contaminated Runs

Do not use these as model evidence:

- An early PowerShell matrix set `BENCH_MODEL` only in the host environment, not in the gateway container. Requests therefore fell back to default Bonsai.
- One Nemotron attempt failed gateway authentication before reaching the model; a nearby tool log belonged to an orphaned fallback request.
- A persistent PowerShell terminal was left inside an unfinished block and swallowed a Qwen command.
- Several execution wrappers timed out while their child command continued. A timeout from the orchestration tool is not itself a model timeout.
- One trace collection command recursively scanned the repository instead of querying Docker logs.

Use `home-assistant-gateway/benchmark.py` for all future runs.

## Post-Fix Baselines

### Granite 4.2 8B

Model: `granite4.2:8b`

The benchmark reached its five-minute process bound with exit code 124. It completed six real tool calls before cancellation:

1. `wiki_search({"query":"MLB teams never been to the World Series"})` (554 characters)
2. `wiki_search({"query":"teams never played in World Series"})` (588 characters)
3. `wiki_fetch({"content":"intro","path":"List_of_Major_League_Baseball_franchise_postseason_droughts"})` (2,596 characters)
4. `wiki_fetch({"content":"full","path":"List_of_Major_League_Baseball_franchise_postseason_droughts"})` (4,185 characters)
5. `wiki_search({"query":"World Series never played team list"})` (588 characters)
6. `wiki_search({"query":"MLB teams that have never played in the World Series"})` (532 characters)

The gateway did not log an HTTP completion, and Ollama was idle after cancellation.

Interpretation: tool choice, useful query formulation, result selection, and article fetching all succeeded. Granite did not synthesize an answer within five minutes and exhausted both search and fetch budgets, so its observed failure stage is stopping/final synthesis rather than retrieval.

### Granite 4.2 8B With Five Fetches

The first expanded-fetch run retained `num_ctx=8192`, the detailed gateway prompt, and `keep_alive=0`, but raised the fetch allowance from two to five and the process bound from five to ten minutes.

It reached the ten-minute bound with exit code 124 after eight calls:

1. Two searches selected `List_of_Major_League_Baseball_franchise_postseason_droughts`.
2. Five fetches read its introduction and full-content pages 1 through 4.
3. A final search queried `active MLB teams never appeared in World Series`.

The gateway did not log an HTTP completion. Ollama reloaded Granite before every model round because `keep_alive=0` requests immediate unload after each response.

Interpretation: a five-fetch allowance let Granite continue gathering evidence but did not correct its retrieval trajectory. The measured wall time is heavily contaminated by repeated model loading and should not be used as a resident-model latency estimate. Subsequent runs remove separate search/fetch caps, retain only the 24-round circuit breaker, and use `keep_alive=-1`.

### Granite 4.2 8B Resident With Uncapped Tools

This run used `num_ctx=8192`, 4,000-character fetch pages, no separate search/fetch caps, the 24-round circuit breaker, and `keep_alive=-1`. Granite was warm before the request.

The benchmark reached its ten-minute process bound with exit code 124 after eleven completed calls:

- Four searches, including both the exact appearance predicate and the related championship predicate.
- Seven fetches of `List_of_Major_League_Baseball_franchise_postseason_droughts`: the introduction followed by full-content pages 1 through 6.
- No final answer or gateway HTTP completion.
- Zero Ollama runner-load events during the request; Granite remained resident with `UNTIL Forever`.

Interpretation: persistent residency removed reload overhead and made early tool turns much faster, but the model selected a related drought article and entered a page-by-page evidence loop. The active failure stage is result selection/stopping, not tool availability or model loading. Keep 4,000-character pages fixed for the next run and test 12,288-token context before changing pagination.

### Granite 4.2 8B Resident at 12K

A direct warm-up loaded Granite successfully at `num_ctx=12288` in 10.2 seconds with no OOM. The model occupied 6.6 GB across the GPUs and remained resident indefinitely.

The Wikipedia benchmark kept 4,000-character pages and all other settings unchanged. It reached the ten-minute process bound with exit code 124 after eleven calls:

- Two searches selected `List_of_Major_League_Baseball_franchise_postseason_droughts`.
- Nine fetches read the introduction and every full-content page, 1 through 8.
- Page 8 contained only 546 result characters, so the article was exhausted.
- No final answer or gateway HTTP completion occurred before cancellation.
- Zero Ollama runner-load events occurred during the benchmark.

Interpretation: increasing context from 8,192 to 12,288 did not change article selection or stop the exhaustive pagination loop. The next controlled condition should change the system prompt while preserving 12K context, 4,000-character pages, resident execution, and uncapped tools.

### Granite 4.2 8B With Short Prompt at 12K

This run replaced only the detailed gateway system prompt with the shorter LM Studio prompt. It preserved `num_ctx=12288`, 4,000-character pages, unlimited search/fetch calls, the 24-round circuit breaker, temperature 0, and `keep_alive=-1`.

The benchmark reached its ten-minute process bound with exit code 124 after eleven calls. Its tool path matched the preceding 12K run:

- Two searches selected `List_of_Major_League_Baseball_franchise_postseason_droughts`.
- Nine fetches read the introduction and full-content pages 1 through 8.
- Page 8 contained 546 result characters, exhausting the article.
- No final answer or gateway HTTP completion occurred before cancellation.
- Every model turn used a 12,288-token context, with zero runner reloads.

The accumulated prompt reached 12,220 tokens before the page-8 decision. That model turn took 3 minutes 54 seconds, after which Granite requested page 8 and began another generation. Restarting only the gateway canceled the orphaned request; Granite remained resident at 12K with `UNTIL Forever`.

Interpretation: shortening the prompt did not change result selection or stopping behavior. The failure is now stable across prompt detail and 8K/12K context conditions. Further prompt or pagination tuning is unlikely to be the most discriminating next step; orchestration should prevent repeated traversal of a weakly related article or steer selection toward explicit evidence.

### Search Path Diagnostic

Direct MCP calls showed why Granite's route is stable:

- `MLB teams never been to the World Series` returned tie-breakers, sweeps, Rockies seasons, MLB postseason, and the World Series MVP award.
- `teams never played in World Series` ranked the franchise postseason-droughts article third and did not return the champions list.
- `Major League Baseball`, `World Series`, and `List of World Series champions` each returned their exact-title article first.

The latter three queries reproduce the successful LM Studio search path, whose champions-list introduction contains the explicit answer. The next diagnostic condition adds only an instruction to begin with `Major League Baseball`. This is a benchmark-specific trajectory hint, not a proposed general production prompt.

### Granite 4.2 8B With Initial Search Hint at 12K

The prompt added only `Begin by searching for Major League Baseball.` to the preceding short-prompt condition. Granite followed the successful LM Studio route for its first two calls:

1. `wiki_search({"query":"Major League Baseball"})`
2. `wiki_fetch({"content":"intro","path":"Major_League_Baseball"})`

It diverged on call 3 by searching for `World Series teams list` rather than the exact title `World Series`. It then made several reordered variants of that query, fetched unrelated trophy and individual franchise-season introductions, and never searched for `List of World Series champions`.

The run reached the 24-round circuit breaker in about 7.5 minutes after ten searches and fourteen fetches. It produced no final answer. All model turns used the resident 12,288-token runner, which remained loaded with `UNTIL Forever`; no runner reload occurred.

The circuit breaker initially surfaced as an empty-body HTTP 500 because raising `HTTPException` inside the MCP stream task group wrapped it in an `ExceptionGroup`. The benchmark then raised `JSONDecodeError` while assuming the error body was JSON. The gateway now returns a JSON 502 response directly at the limit, and the benchmark preserves both JSON and non-JSON HTTP error bodies.

Interpretation: the hint proved that Granite can be steered onto the first successful search and fetch, but that is insufficient. Its next-query planning still broadens the title and loses the exact-article path. A stronger benchmark-specific route hint or gateway-driven search sequence is needed to distinguish model synthesis ability from retrieval planning under Ollama.

### Granite 4.2 8B With Exact Route at 12K

This isolation condition replaced the one-title hint with the three exact article titles from the successful LM Studio route: `Major League Baseball`, `World Series`, and `List of World Series champions`. It was deliberately question-specific and was removed after the diagnostic run.

Granite passed in 151.132 seconds with HTTP 200 and six tool calls:

1. `wiki_search({"query":"Major League Baseball"})` (610 characters)
2. `wiki_fetch({"content":"intro","path":"Major_League_Baseball"})` (4,143 characters)
3. `wiki_search({"query":"World Series"})` (440 characters)
4. `wiki_fetch({"content":"intro","path":"World_Series"})` (2,455 characters)
5. `wiki_search({"query":"List of World Series champions"})` (588 characters)
6. `wiki_fetch({"content":"intro","path":"List_of_World_Series_champions"})` (3,195 characters)

It correctly answered Seattle Mariners and quoted the explicit sentence that the Mariners are the only MLB franchise never to appear in a World Series. The final response stopped normally with `prompt_eval_count=3779` and `eval_count=199`. It was unnecessarily repetitive and exposed a stray `</think>` marker despite `think=false`, but its graded answer was correct.

All turns used the resident 12,288-token runner, with no reloads. Granite remained loaded with `UNTIL Forever` after completion.

Interpretation: Granite can select the exact returned paths, recognize decisive evidence, distinguish appearances from championships, and synthesize the correct answer under Ollama. The failed general-prompt runs are therefore query-planning failures. The runtime gap with LM Studio is not a fundamental evidence-use or synthesis failure once the same retrieval route is supplied.

### Granite 4.2 8B With Exact LM Studio Prompt and Default Thinking

This condition made the gateway prompt byte-for-byte identical to the successful 217-byte LM Studio prompt and omitted Ollama's `think` field so the model used its default thinking mode. Context remained 12,288; all other runtime, tool, pagination, and round settings were unchanged.

An initial attempt was invalid because LocalWiki still had an older MCP authentication token after the gateway was recreated. Recreating only LocalWiki synchronized it with the current `.env`; authenticated MCP discovery then succeeded before the valid run.

The valid run reached the ten-minute process bound after fourteen completed calls:

- Eleven searches, mostly verbose variations of the full question or `World Series participants list`.
- Three introduction fetches: `Major_League_Baseball_postseason`, `World_Series`, and `Commissioner's_Trophy_(MLB)`.
- It reached the exact `World Series` search and fetched that article's introduction, but never searched for or fetched `List_of_World_Series_champions`.
- No final answer or gateway HTTP completion occurred before cancellation.
- The last model turn began at 4,087 prompt tokens, far below the 12,288-token limit.
- Granite remained resident at 12K with `UNTIL Forever`; restarting only the gateway canceled the orphaned final turn.

Interpretation: matching the LM Studio prompt exactly and enabling model-default thinking did not reproduce LM Studio's successful query plan. Thinking increased per-round latency and changed the route, but the failure remained title-query planning rather than context exhaustion. The strongest remaining explanations are LM Studio's `.act()` tool orchestration/parser and chat template, context-overflow behavior, or a different model artifact/quantization.

### Granite 4.2 8B With 120-Minute Ceiling

This repeated the exact-prompt, default-thinking condition with both the gateway and benchmark request timeouts raised to 7,200 seconds. The prediction limit remained 1,024 tokens, context remained 12,288, and Granite remained resident.

The request completed with HTTP 200 in 530.224 seconds, well below both the former ten-minute bound and the new 120-minute ceiling. It made eight tool calls:

```json
{
  "status": 200,
  "wall_seconds": 530.224,
  "answer": "",
  "done_reason": "length",
  "prompt_eval_count": 2792,
  "eval_count": 1024
}
```

1. Seven searches, beginning with `World Series appearances MLB teams` and ending with `World Series appearances by team`.
2. One introduction fetch of `World_Series` after the sixth search.

The final model turn began with 2,792 prompt tokens and ran for approximately 195 seconds. It then returned an empty visible answer with `done_reason=length` and `eval_count=1024`. Granite remained resident at 12K with `UNTIL Forever`, and no benchmark process remained after completion.

Interpretation: the ten-minute client bound was not the cause of this failure. The final turn exhausted the 1,024-token generation allowance before producing visible content, so increasing the wall-clock timeout further is not a useful next test. The next controlled diagnostic is to expose `message.thinking` and determine whether hidden reasoning consumed the allowance; only then consider a higher `num_predict`, or explicitly use `think=false` for production.

### Unbiased Handles and Section Retrieval

LocalWiki was changed to the intentional `wiki_search` -> `wiki_sections` -> `wiki_fetch` flow. The gateway presents request-scoped article handles (`A1`, `A2`) and section handles (`S1`, `S2`) while resolving exact paths and section IDs internally. Handles preserve Kiwix result order and Wikipedia document order; they contain no relevance ranking. Section fetches use block-aware segments, keep table rows intact, and repeat table headers across segments. Older tool messages are compacted every four rounds while preserving handle maps and the two latest evidence segments verbatim.

Live retrieval validation passed:

- `Longest_current_World_Series_appearance_droughts` returned one 1,156-character segment containing the complete `Seattle Mariners | Never` row and no neighboring league-championship section.
- The `Results` section of `List_of_World_Series_champions` produced five segments. Its four table segments repeated identical headers, contained no partial rows, and duplicated no rows at boundaries.

The final low-thinking benchmark used compact plaintext article and section lists. It completed normally in 241.368 seconds with HTTP 200, `prompt_eval_count=838`, `eval_count=438`, and `done_reason=stop`, but refused to give a definitive answer. It made eight searches, compacting after rounds 4 and 8, and never called `wiki_sections` or `wiki_fetch`.

Direct Kiwix inspection showed that the required franchise-droughts article was absent from the top 15 raw results for both natural formulations Granite used. It appeared when searching `MLB franchise postseason droughts`. Raising LocalWiki's five-result limit would therefore add noise without exposing the article for the original queries. The remaining failure is query vocabulary/planning, not context growth, handle length, table serialization, or section segmentation.

### Granite 4.2 8B at Temperature 0.2

Two independent trials used `num_ctx=12288`, temperature 0.2, low thinking, `num_predict=1024`, and LLM compaction every four tool rounds.

Trial 1 completed in 439.763 seconds with HTTP 200, `done_reason=stop`, `prompt_eval_count=2362`, and `eval_count=289`. It made eight searches before opening `World_Series_(baseball)` and fetching its lead. Its second compaction reduced the history to a 97-character summary that changed the task to "What is the World Series?" Granite answered that substituted question. This was a compaction-integrity failure, not a table-parsing failure.

Trial 2 completed in 736.067 seconds with HTTP 200, an empty visible answer, `done_reason=length`, `prompt_eval_count=2912`, and `eval_count=1024`. It selected the correct `List_of_Major_League_Baseball_franchise_postseason_droughts` article after one search, but fetched the lead and `Longest current postseason droughts` instead of `Longest current World Series appearance droughts`. After the first 1,080-character compaction, it repeated the search, section listing, and both wrong fetches. The second compaction failed with Ollama HTTP 500 and was skipped as designed. Final hidden reasoning remained trapped interpreting the unrelated postseason table until it exhausted the prediction limit.

Interpretation: temperature 0.2 changed the trajectories but did not produce a successful run. The trials exposed independent weaknesses in generated-summary fidelity, section selection, duplicate-work avoidance, and bounded final reasoning. No semantic ranking, query rewriting, larger result limit, or answer-specific routing was introduced. The gateway now excludes its original policy and client messages from the compaction request, summarizes only retrieval work, preserves its mechanical handle registry, and restores the exact original messages after the advisory summary so compaction cannot rewrite the task.

### Nemotron, MiniCPM5, and Qwen3 14B Matrix

The next matrix used 8,192 context, temperature 0.2, low thinking, 2,048 prediction tokens, `repeat_last_n=64`, and sequential runs. Each candidate was tested on both GPUs first and retried GTX-only after any failure, including a wrong answer.

| Model | Configuration | Result |
| --- | --- | --- |
| `nemotron-3-nano:4b` | Dual GPU | Loaded all 43 layers, then hung during empty warm-up until Ollama's five-minute runner timeout |
| `nemotron-3-nano:4b` | GTX-only | Initialized in 100.8 seconds; two full runs completed but neither fetched decisive evidence or answered correctly |
| `openbmb/minicpm5-2b:q4_K_M` | Dual GPU | Fully GPU-resident; made eight searches, no section listing or fetch, then exhausted 2,048 reasoning tokens |
| `openbmb/minicpm5-2b:q4_K_M` | GTX-only | Passed article handles to `wiki_fetch` and a title to `wiki_sections`; repeated the handle mismatch until length exhaustion |
| `qwen3:14b-q4_K_M` | Dual GPU | Runner startup timeout after 313 seconds |
| `qwen3:14b-q4_K_M` | GTX-only | 70% CPU / 30% GPU with 11/41 layers offloaded; four searches, no section/fetch, empty answer at 2,048 tokens after 1,672.861 seconds |

Nemotron's first GTX run found the franchise-droughts article and correctly listed its sections but stopped tool use immediately afterward. Its second run made four searches without section listing. MiniCPM5 demonstrated syntactically accepted native calls but did not follow the article-handle -> section-handle contract. Qwen3 14B was technically usable with CPU offload but too slow and did not progress beyond search.

### LM Studio Nemotron Parity

The raw LM Studio trace `nemotron - 2026-09-17 21.13` is a valid successful run. It used `Q4_K_M`, 32,768 context, full 42-layer offload, and thinking enabled. The first search returned 25 results, including the decisive franchise-droughts article at position 21. After one recoverable invalid section ID, Nemotron listed sections, fetched `Longest_current_World_Series_appearance_droughts`, and correctly identified only the Seattle Mariners from the explicit table.

Three gateway conditions were changed to match that run without adding answer-specific routing:

1. LocalWiki search results increased from 5 to 25.
2. Previous `thinking` fields are removed before assistant messages enter the next model turn.
3. Fixed four-round compaction was replaced by context-pressure compaction at an estimated 85% of the request's actual context window.

Live validation confirmed that the same query returns 25 results and the target article at position 21. A subsequent GTX-only Nemotron parity run used 32,768 context, Boolean thinking, full GPU residency, and no compaction. It found the drought article and listed its sections, reaching only 1,927 prompt tokens, but then exhausted all 2,048 generated tokens repeating that it should fetch `S19`; it emitted neither a tool call nor visible answer. The remaining difference is therefore likely LM Studio's chat template, reasoning-to-tool transition, or `.act()` orchestration rather than retrieval depth, compaction, or retained historical reasoning.

`mistral-nemo:12b` is downloaded but has not yet completed its dual/GTX matrix. Larger pending candidates remain `gpt-oss:20b` and `mistral-small3.2:24b`.

### Native LM Studio SDK Gateway

The Home Assistant gateway was rewritten in Node/TypeScript with `@lmstudio/sdk` 1.4.0. It passes the generic Wikipedia prompt and request-scoped LocalWiki tools to `model.act()` instead of manually replaying Ollama assistant/tool turns. Search still returns 25 results, tools remain serial, and the only control-flow bound is 24 prediction rounds.

Nemotron Q4_K_M passed through this gateway at 32,768 context with full GPU offload. It completed search -> sections -> fetch and correctly identified only the Seattle Mariners. This reproduces the earlier positive LM Studio result and strongly supports `.act()` or LM Studio's reasoning/tool transition as the material runtime difference.

Granite Q4_K_M loaded successfully at 12,288 context with 80% GPU offload. Full GPU offload loaded but failed during inference with CUDA OOM. The first full `.act()` attempt made five valid calls:

1. `wiki_search("MLB teams never played in the World Series")`
2. `wiki_search("World Series appearances by team")`
3. `wiki_sections(A44)` for `World_Series`
4. `wiki_fetch(S33)` for `Modern_World_Series_appearances_by_franchise`
5. `wiki_fetch(S34)` for `World_Series_record_by_team_or_franchise,_1903-present`

The benchmark client then hit Undici's default response-header timeout while the server-side final prediction continued. This is not a Granite tool or gateway failure. The Node benchmark now uses `node:http` with no response-header deadline; final Granite grading remains pending.

The next exact candidate is `unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf`, approximately 16.5 GB. It is Qwen3.8, not Qwen3.5, and should be downloaded and tested only after Granite is idle.

### Nemotron Clean-Context Researchers

An atomic `/new Victoria Beckham birthday` baseline passed in 14 seconds. Nemotron searched `Victoria Beckham`, opened `Victoria_Beckham`, fetched `Early_life`, and answered `17 April 1974` from explicit evidence.

A parent tool was then tested with nested same-model `.act()` calls. The initial reliable contract exposed one `research_question` at a time; each call started a fresh child chat, LocalWiki client, and handle registry, while children received only wiki tools to prevent recursion. This fixed the five-person query but did not scale to the 30-team Mariners decomposition.

The current design adds request-scoped structured memory. `research_list` captures a grounded answer and fetched evidence, uses a tool-free reasoning-disabled structured extraction to validate the complete canonical list, and stores names plus discovery context as `D1`. Its explicit purpose separates attribute enumeration from set-filter fallback; filter fallback is rejected until aggregate research is partial or failed. `research_map` expands every entity placeholder, declares required fields, deterministically applies one question template to every stored item, and stores generic status-bearing results as `M1`. `research_reduce` reviews the required fields, discovery context, and complete map before final synthesis. It can retry, add, or exclude records, and can recursively map unresolved fields to separate clean researchers. Whole-record and field-level repairs share an eight-call budget. A 30-record contract test processed 30/30 items and reduced all 30 without returning the entity list to the parent context.

Focused tests cover repeated placeholder expansion, aggregate-first fallback gating, repair-plan normalization for failed/wrong-subject/missing/accidental records, and reduction of field subagents into a status-bearing parent record.

The 2026-09-18 repaired reruns are stored under `test-runs/2026-09-18-repair`. Mariners passed in 156.863 seconds through aggregate drought-table research and returned only Seattle Mariners. Spice Girls passed in 238.338 seconds: discovery produced all five people, all repeated placeholders expanded, all five biography records completed with fetched evidence, and the repair review correctly requested no actions.

Ollama streaming now emits `message.thinking` progress deltas for discovery, each map item, retries, and reduction. A live request received its first `done:false` progress record before discovery completed, and a complete atomic stream ended with the grounded `17 April 1974` answer and `done:true`.

The composite question `Who are the Spice Girls (stage and real names) and what are their birthdays YYYY/MM/DD?` passed in 156 seconds. The parent first delegated group membership, then separately researched Melanie Brown, Emma Bunton, Melanie Chisholm, Victoria Beckham, and Geri Halliwell. Every biography researcher searched the exact person, listed sections, fetched its isolated `S1` lead, and returned explicit evidence. The final answer contained all five correct mappings and dates:

| Stage name | Real name | Birthday |
| --- | --- | --- |
| Scary Spice | Melanie Brown | 1975/05/29 |
| Baby Spice | Emma Bunton | 1976/01/21 |
| Sporty Spice | Melanie Chisholm | 1974/01/12 |
| Posh Spice | Victoria Beckham | 1974/04/17 |
| Ginger Spice | Geri Halliwell | 1972/08/06 |

Two failed intermediate designs were discriminating. Giving the parent direct wiki tools let it accumulate and confuse shared handles before attempting delegation. Allowing batched questions let it guess entities before reading the membership result, mislabeling members and adding Jade Goody. The single-question contract forces evidence to arrive before the next planning step. Researchers remain serial to avoid competing workloads on the loaded model; the expected cost is roughly one atomic inference per entity.

## Pending Baselines

Still run under the exact baseline, sequentially and with a five-minute process bound:

1. `wcamaralopes/bonsai-27b:latest`

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
  node dist/benchmark.js granite-4.2-8b --num-predict 2048 --temperature 0.2
docker compose logs --since $timestamp --timestamps --no-color home-assistant-gateway |
  Select-String 'lmstudio_tool_call|wiki_tool_call|wiki_tool_result|lmstudio_invalid_tool_call'
lms ps
```

The benchmark deliberately has no response-header timeout because `.act()` may require more than five minutes. Cancel a slow run explicitly only after recording the tool trace. Do not run candidates concurrently.

## Current Hypotheses

- The main observed failure is before retrieval: models are not reliably producing a first tool call.
- Prompt improvements alone may be insufficient for compact models; orchestration-level tool forcing is more discriminating.
- Thinking mode should be evaluated only after basic tool-call completion works because it can greatly increase latency.
- The original successful Bonsai result may depend on LM Studio's tool-selection/runtime template as well as on the LocalWiki implementation.
- Removing `wiki_list` reduces one unnecessary round but also changes the exact sequence from the successful external reference. This is intentional for the single-book API and should remain fixed during comparisons.
